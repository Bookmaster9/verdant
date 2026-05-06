/**
 * One-shot migration: rebuild every existing LearningPlan to use FSRS-managed
 * reviews. Destructive — drops TaskCompletion rows and strips review tasks
 * from planJson. Idempotent: safe to run again.
 *
 * Run with:
 *   npx tsx scripts/migrate-fsrs.ts
 *
 * Prerequisites: run `npx prisma db push --accept-data-loss` first so the new
 * tables/columns exist.
 */
import { PrismaClient } from "@prisma/client";
import { seedFsrsForPlan } from "../src/lib/fsrs";
import { reviewInstanceToTask } from "../src/lib/fsrs-to-tasks";
import { packWithScoring } from "../src/lib/scoring-pack";
import { parseTimeWindowsJson } from "../src/lib/default-preferences";
import type { PlanTask, ScheduledSession, SproutPlan } from "../src/types/plan";

const prisma = new PrismaClient();

async function main() {
  console.log("[migrate-fsrs] starting");

  // 1. Wipe TaskCompletion (Q3 — clean slate for the new rating semantics).
  const wiped = await prisma.taskCompletion.deleteMany({});
  console.log(`[migrate-fsrs] wiped ${wiped.count} TaskCompletion rows`);

  // 2. Drop any pre-existing FSRS state (re-runnable).
  const droppedReviews = await prisma.reviewInstance.deleteMany({});
  const droppedStates = await prisma.lessonState.deleteMany({});
  console.log(
    `[migrate-fsrs] cleared ${droppedReviews.count} ReviewInstance + ${droppedStates.count} LessonState rows`
  );

  // 3. For each plan: strip review tasks from planJson, seed FSRS, re-pack.
  const plans = await prisma.learningPlan.findMany();
  for (const plan of plans) {
    console.log(`[migrate-fsrs] plan ${plan.id} (${plan.title})`);
    const sprout = JSON.parse(plan.planJson || "{}") as SproutPlan;
    const allTasks = (sprout.tasks ?? []) as PlanTask[];
    const nonReviewTasks = allTasks.filter((t) => t.type !== "review");
    sprout.tasks = nonReviewTasks;
    if (sprout.weeklyShape) sprout.weeklyShape.reviews = 0;

    // Pack pass 1: lessons + milestones, to learn each lesson's end time.
    const pref = await prisma.userPreference.findUnique({
      where: { userId: plan.userId },
    });
    const tw = parseTimeWindowsJson(pref?.timeWindows ?? "{}");
    const slotEff = JSON.parse(pref?.slotEffectiveness || "{}") as Record<
      string,
      number
    >;
    const ctx = {
      startDate: plan.startDate,
      deadline: plan.deadline,
      timeWindows: tw,
      busy: [],
      maxMinutesPerDay: pref?.maxMinutesDay ?? 90,
      slotEffectiveness: slotEff,
    };
    const pass1 = packWithScoring(nonReviewTasks, ctx);

    const lessonIds = nonReviewTasks
      .filter((t) => t.type === "lesson")
      .map((t) => t.id);
    const lessonEndByTaskId = new Map<string, Date>();
    for (const sess of pass1.schedule) {
      if (sess.agenda) {
        for (const a of sess.agenda) {
          if (lessonIds.includes(a.planTaskId)) {
            lessonEndByTaskId.set(a.planTaskId, new Date(sess.end));
          }
        }
      } else if (lessonIds.includes(sess.planTaskId)) {
        lessonEndByTaskId.set(sess.planTaskId, new Date(sess.end));
      }
    }

    const seeded = seedFsrsForPlan({
      lessonTaskIds: lessonIds,
      lessonEndByTaskId,
      deadline: plan.deadline,
      intensity: plan.intensity ?? 2,
      postDeadlineMode: plan.postDeadlineMode === "maintain" ? "maintain" : "stop",
    });

    // Persist FSRS rows.
    const lessonStateIdByLessonId = new Map<string, string>();
    for (const ls of seeded.lessonStates) {
      const created = await prisma.lessonState.create({
        data: {
          planId: plan.id,
          lessonId: ls.lessonId,
          difficulty: ls.difficulty,
          stability: ls.stability,
          lapses: ls.lapses,
        },
      });
      lessonStateIdByLessonId.set(ls.lessonId, created.id);
    }

    const lessonTitles = new Map(
      nonReviewTasks
        .filter((t) => t.type === "lesson")
        .map((t) => [t.id, t.title] as const)
    );
    const reviewTasks: PlanTask[] = [];
    for (const [lessonId, dueDates] of seeded.reviewsByLessonId) {
      const lessonStateId = lessonStateIdByLessonId.get(lessonId);
      if (!lessonStateId) continue;
      for (const dueAt of dueDates) {
        const created = await prisma.reviewInstance.create({
          data: {
            planId: plan.id,
            lessonStateId,
            projected: true,
            dueAt,
          },
        });
        reviewTasks.push(
          reviewInstanceToTask({
            review: {
              id: created.id,
              planId: created.planId,
              lessonStateId: created.lessonStateId,
              projected: created.projected,
              dueAt: created.dueAt,
              completedAt: created.completedAt,
              rating: created.rating,
            },
            lessonTitle: lessonTitles.get(lessonId) ?? "lesson",
          })
        );
      }
    }

    // Pack pass 2: full set.
    const pass2 = packWithScoring([...nonReviewTasks, ...reviewTasks], ctx);
    const schedule: ScheduledSession[] = pass2.schedule;

    await prisma.learningPlan.update({
      where: { id: plan.id },
      data: {
        planJson: JSON.stringify(sprout),
        scheduleJson: JSON.stringify(schedule),
      },
    });
    console.log(
      `  ✓ ${nonReviewTasks.length} tasks, ${reviewTasks.length} projected reviews, ${schedule.length} sessions, ${pass2.overflow.length} overflow`
    );
  }

  console.log("[migrate-fsrs] done");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });

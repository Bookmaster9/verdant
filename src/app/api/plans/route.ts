import { auth } from "@/auth";
import { generateSproutPlan, supplementalResources } from "@/lib/generate-sprout";
import { ensureVerdantCalendar, insertOrSkip } from "@/lib/google-calendar";
import { prisma } from "@/lib/db";
import { ensureUserPreferences } from "@/lib/user";
import { packWithScoring } from "@/lib/scoring-pack";
import { getExternalBusy } from "@/lib/calendar-read";
import { loadCrossPlanBusy } from "@/lib/cross-plan-busy";
import { summarizeAvailability } from "@/lib/availability-summary";
import { seedFsrsForPlan } from "@/lib/fsrs";
import { reviewInstanceToTask } from "@/lib/fsrs-to-tasks";
import type { PlanTask, ScheduledSession, SproutPlan } from "@/types/plan";
import { parseTimeWindowsJson } from "@/lib/default-preferences";
import { parseHourUtility } from "@/lib/hour-utility";
import {
  applyYoutubeVideoLengthsToLessonMinutes,
  enrichSproutWithYoutubePlaylist,
  findYoutubePlaylistIdInResources,
} from "@/lib/youtube-playlist";
import { NextResponse } from "next/server";
import { z } from "zod";

const TIMING = process.env.NODE_ENV !== "production";
function tick(label: string, t0: number): void {
  if (TIMING) console.log(`[plans.POST] ${label}: ${Date.now() - t0}ms`);
}

const createBody = z.object({
  targetSkill: z.string().min(1).max(200),
  deadline: z.string(),
  startDate: z.string().optional(),
  initialResources: z.array(z.string().min(1)).min(0).max(20),
  freeformNote: z.string().max(2000).optional(),
  /** FSRS retention driver. 1=gentle (R=0.80), 2=steady (R=0.90), 3=focused (R=0.95). */
  intensity: z.number().int().min(1).max(3).optional().default(2),
  /** FSRS post-deadline behavior. */
  postDeadlineMode: z.enum(["stop", "maintain"]).optional().default("stop"),
});

export async function GET() {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const plan = await prisma.learningPlan.findFirst({
    where: { userId: s.user.id, status: "active" },
  });
  return NextResponse.json({ plan });
}

const TOTAL_STEPS = 4;

export async function POST(request: Request) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const raw = await request.json();
  const parsed = createBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const {
    targetSkill,
    initialResources,
    freeformNote,
    intensity,
    postDeadlineMode,
  } = parsed.data;
  const deadline = new Date(parsed.data.deadline);
  const startDate = parsed.data.startDate
    ? new Date(parsed.data.startDate)
    : new Date();
  if (Number.isNaN(deadline.getTime()) || deadline <= startDate) {
    return NextResponse.json({ error: "Invalid deadline" }, { status: 400 });
  }

  if (
    findYoutubePlaylistIdInResources(parsed.data.initialResources) &&
    !process.env.YOUTUBE_API_KEY?.trim()
  ) {
    return NextResponse.json(
      {
        error:
          "YouTube playlist URLs require YOUTUBE_API_KEY in .env (enable YouTube Data API v3 for your Google Cloud project).",
      },
      { status: 400 }
    );
  }

  const userId = s.user.id;
  const accessToken = (s as { accessToken?: string }).accessToken;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      const t0 = Date.now();
      try {
        const { after } = await import("next/server");
        // Step 1: gather context (DB prefs + Google busy + archive existing plan).
        send({
          type: "progress",
          step: 1,
          of: TOTAL_STEPS,
          label: "peeking at your garden",
        });

        // Multi-sprout: every other active plan's schedule is hard busy +
        // already-consumed daily minutes. No singleton gate anymore.
        const [crossPlan, pref, busyResult] = await Promise.all([
          loadCrossPlanBusy({ userId, excludePlanId: null }),
          ensureUserPreferences(userId),
          getExternalBusy({
            userId,
            accessToken,
            from: startDate,
            to: new Date(deadline.getTime() + 86_400_000),
          }),
        ]);
        tick("parallel(crossPlan+prefs+busy)", t0);

        const timeWindows = parseTimeWindowsJson(pref.timeWindows);
        const maxM = pref.maxMinutesDay;
        const hourUtility = parseHourUtility(pref.hourUtility);
        const now = new Date();
        const externalBusy = busyResult.intervals;

        const days = Math.max(
          1,
          Math.ceil((deadline.getTime() - startDate.getTime()) / 86_400_000)
        );
        const weeks = Math.max(1, Math.ceil(days / 7));
        const availability = summarizeAvailability({
          startDate,
          weeks,
          timeWindows,
          busy: [...externalBusy, ...crossPlan.busy],
          hourUtility,
          now,
        });

        // Step 2: LLM — usually the longest step.
        send({
          type: "progress",
          step: 2,
          of: TOTAL_STEPS,
          label: "drafting growth phases",
        });
        const tLLM = Date.now();
        let sprout: SproutPlan = await generateSproutPlan({
          targetSkill,
          deadline,
          startDate,
          initialResources,
          availability,
          weeklyMinutesTarget: pref.weeklyMinutesTarget,
          freeformNote: freeformNote ?? null,
        });
        if (findYoutubePlaylistIdInResources(initialResources)) {
          sprout = await enrichSproutWithYoutubePlaylist(sprout, initialResources);
        }
        const ytKey = process.env.YOUTUBE_API_KEY?.trim();
        if (ytKey) {
          sprout = {
            ...sprout,
            tasks: await applyYoutubeVideoLengthsToLessonMinutes(sprout.tasks, ytKey),
          };
        }
        tick("generateSproutPlan", tLLM);

        // Step 3: pack tasks into the calendar. Two passes: first packs the
        // AI-emitted lessons + milestones to learn each lesson's end time, then
        // FSRS projects review chains anchored to those ends, then we re-pack
        // everything together so reviews land near their dueAt.
        send({
          type: "progress",
          step: 3,
          of: TOTAL_STEPS,
          label: "weaving sessions into your calendar",
        });
        const recs = supplementalResources(targetSkill);
        // Pass 1 runs before the plan row exists, so we use a temporary planId
        // for RNG seeding. Pass 1's placement is internal (only used to read
        // lesson end times); only pass 2 produces the persisted schedule.
        const pass1Ctx = {
          startDate,
          deadline,
          timeWindows,
          busy: [...externalBusy, ...crossPlan.busy],
          maxMinutesPerDay: maxM,
          hourUtility,
          now,
          planId: `pre-pack-${userId}`,
          initialDailyMinutesUsed: crossPlan.initialDailyMinutesUsed,
        };
        const tPack = Date.now();
        // Pass 1: lessons + milestones only.
        const pass1 = packWithScoring(sprout.tasks, pass1Ctx);
        tick("packWithScoring(pass1)", tPack);

        // Build a lessonId → end-of-session map from pass 1.
        const lessonIds = sprout.tasks
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

        // FSRS: seed LessonState defaults + project initial review chains.
        const seeded = seedFsrsForPlan({
          lessonTaskIds: lessonIds,
          lessonEndByTaskId,
          deadline,
          intensity,
          postDeadlineMode,
        });

        // Step 4: persist. Calendar writes happen post-response via `after()`.
        send({
          type: "progress",
          step: 4,
          of: TOTAL_STEPS,
          label: "sealing the plan in your journal",
        });
        const tDb = Date.now();
        const plan = await prisma.learningPlan.create({
          data: {
            userId,
            title: `Sprout: ${targetSkill}`,
            targetSkill,
            deadline,
            startDate,
            initialResources: JSON.stringify(initialResources),
            planJson: JSON.stringify(sprout),
            // scheduleJson is filled below after pass 2.
            scheduleJson: "[]",
            recommendations: JSON.stringify(recs),
            freeformNote: freeformNote ?? null,
            intensity,
            postDeadlineMode,
            status: "active",
          },
        });

        // Persist LessonState rows (one per lesson task).
        const lessonTitles = new Map(
          sprout.tasks
            .filter((t) => t.type === "lesson")
            .map((t) => [t.id, t.title] as const)
        );
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

        // Persist projected ReviewInstance rows.
        const reviewRows: Array<{
          id: string;
          lessonStateId: string;
          dueAt: Date;
          lessonId: string;
        }> = [];
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
            reviewRows.push({ id: created.id, lessonStateId, dueAt, lessonId });
          }
        }

        // Pass 2: re-pack everything (lessons + milestones + reviews-as-tasks).
        // Each review carries `mustFollowTaskId` pointing at its parent lesson
        // so the packer enforces "review after lesson" as a hard ordering, and
        // its `weekIndex`/`dayOffsetInWeek` are derived from the FSRS-projected
        // `dueAt` so the scoring packer pulls each review toward when it should
        // actually happen — instead of bunching every review into week 0.
        const reviewTasks: PlanTask[] = reviewRows.map((r) =>
          reviewInstanceToTask({
            review: {
              id: r.id,
              planId: plan.id,
              lessonStateId: r.lessonStateId,
              projected: true,
              dueAt: r.dueAt,
              completedAt: null,
              rating: null,
            },
            lessonTitle: lessonTitles.get(r.lessonId) ?? "lesson",
            parentLessonId: r.lessonId,
            planStartDate: plan.startDate,
          })
        );
        const allTasks: PlanTask[] = [...sprout.tasks, ...reviewTasks];
        const pass2 = packWithScoring(allTasks, {
          ...pass1Ctx,
          planId: plan.id,
        });
        tick("packWithScoring(pass2)", tPack);
        const schedule: ScheduledSession[] = pass2.schedule;

        await prisma.learningPlan.update({
          where: { id: plan.id },
          data: { scheduleJson: JSON.stringify(schedule) },
        });
        tick("prisma.create+seed", tDb);
        tick("total(before-response)", t0);

        // Singleton counter for the landing-page "sprouts in the ground"
        // tally. Atomic increment via upsert so the first sprout in a
        // fresh DB initializes the row at 1.
        after(async () => {
          try {
            await prisma.sproutCounter.upsert({
              where: { id: 1 },
              create: { id: 1, total: 1 },
              update: { total: { increment: 1 } },
            });
          } catch (err) {
            if (TIMING) console.warn("[plans.POST] counter increment failed:", err);
          }
        });

        send({
          type: "done",
          step: TOTAL_STEPS,
          of: TOTAL_STEPS,
          plan,
          sprout,
          schedule,
          recommendations: recs,
          overflow: pass2.overflow.map((t) => ({
            id: t.id,
            title: t.title,
            priority: t.priority ?? "core",
          })),
        });

        if (pref.pushToCalendar && accessToken && schedule.length > 0) {
          const planId = plan.id;
          after(async () => {
            const tBg = Date.now();
            try {
              // Pre-warm: serialize the calendar provisioning *before* the
              // parallel insert fan-out. Otherwise N concurrent inserts each
              // race the DB read against the create+upsert and end up making
              // N separate calendars in the user's Google sidebar.
              const calendarId = await ensureVerdantCalendar({
                userId,
                accessToken,
                userTimeZone: pref.userTimeZone,
              });
              const synced = await Promise.all(
                schedule.map((sess) =>
                  insertOrSkip(
                    accessToken,
                    calendarId,
                    pref.userTimeZone ?? undefined,
                    sess
                  )
                )
              );
              await prisma.learningPlan.update({
                where: { id: planId },
                data: { scheduleJson: JSON.stringify(synced) },
              });
              tick(`bg.calendarSync(${synced.length} sessions)`, tBg);
            } catch (err) {
              if (TIMING) console.warn("[plans.POST] bg calendar sync failed:", err);
            }
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Plan generation failed";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

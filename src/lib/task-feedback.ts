import type { LearningPlan } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ensureUserPreferences } from "@/lib/user";
import { parseTimeWindowsJson } from "@/lib/default-preferences";
import { getExternalBusy } from "@/lib/calendar-read";
import { parseBlackouts, blackoutsToBusy } from "@/lib/blackouts";
import {
  compileForbidRulesToBusy,
  parsePlacementRules,
} from "@/lib/placement-rules";
import { applyRating, projectReviewChain, type UiRating } from "@/lib/fsrs";
import { reviewInstanceToTask } from "@/lib/fsrs-to-tasks";
import { packIntoExistingSchedule } from "@/lib/scoring-pack";
import { loadCrossPlanBusy } from "@/lib/cross-plan-busy";
import { smoothUpdate, slotKeyFromIso } from "@/lib/effectiveness";
import type { ScheduledSession, SproutPlan } from "@/types/plan";

export type TaskFeedbackResult =
  | { ok: true; scheduleJson: string }
  | { ok: false; error: string; status: number };

/**
 * Single source of truth for the rate/mark-done/re-open lifecycle.
 *
 * Contract:
 *  - `{ completed: true, rating? }` — commit the task. Rating must be in payload OR
 *    already on record; otherwise 400. Future schedule entry is removed (slot freed).
 *  - `{ completed: false }` — re-open the task. Old completion cleared, new schedule
 *    entry placed via surgical open-slot lookup (no displacement).
 *  - `{ rating }` only — re-rate an already-committed task. Updates the rating and
 *    (for reviews) advances FSRS again.
 *
 * Past sessions are never moved by this code path. Newly-projected reviews are
 * placed into open slots only.
 */
export async function applyTaskFeedback(args: {
  planId: string;
  userId: string;
  accessToken?: string;
  plan: LearningPlan;
  currentScheduleJson: string;
  taskId: string;
  completed?: boolean;
  rating?: number;
}): Promise<TaskFeedbackResult> {
  const { planId, userId, accessToken, plan, taskId, completed, rating } = args;
  const now = new Date();
  const sessions = JSON.parse(args.currentScheduleJson || "[]") as ScheduledSession[];

  const reviewInstance = await prisma.reviewInstance.findUnique({
    where: { id: taskId },
    include: { lessonState: true },
  });
  const isReview = !!(reviewInstance && reviewInstance.planId === planId);

  // Resolve current state for validation + decisions.
  let currentRating: number | null;
  let currentCompleted: boolean;
  if (isReview) {
    currentRating = reviewInstance!.rating;
    currentCompleted = reviewInstance!.completedAt != null;
  } else {
    const tc = await prisma.taskCompletion.findUnique({
      where: { planId_taskId: { planId, taskId } },
    });
    currentRating = tc?.rating ?? null;
    currentCompleted = tc?.completed ?? false;
  }

  // Hard rule: completing requires a rating (in payload or on record).
  if (completed === true && rating == null && currentRating == null) {
    return { ok: false, error: "Rate the task before marking it done.", status: 400 };
  }
  // Re-rate without a completion change is only valid for already-completed tasks.
  if (completed === undefined && rating != null && !currentCompleted) {
    return {
      ok: false,
      error: "Cannot rate a task without committing — send completed:true with the rating.",
      status: 400,
    };
  }
  // Empty payload — nothing to do.
  if (completed === undefined && rating == null) {
    return { ok: true, scheduleJson: args.currentScheduleJson };
  }

  // --- Schedule helpers (closures over `sessions`) ---

  /** Find the schedule entry that contains this taskId (single or agenda). */
  const sessIdx = sessions.findIndex(
    (x) => x.planTaskId === taskId || x.agenda?.some((a) => a.planTaskId === taskId)
  );
  const sess = sessIdx >= 0 ? sessions[sessIdx] : null;
  const sessIsFuture = !!sess && new Date(sess.start) > now;

  /** Remove this task from its session, dropping the session if it becomes empty. */
  function removeTaskFromSchedule(schedule: ScheduledSession[]): ScheduledSession[] {
    if (sessIdx < 0) return schedule;
    return schedule.flatMap((entry, i) => {
      if (i !== sessIdx) return [entry];
      if (!entry.agenda || entry.agenda.length <= 1) return [];
      const remaining = entry.agenda.filter((a) => a.planTaskId !== taskId);
      if (remaining.length === 0) return [];
      const totalMin = remaining.reduce((sum, a) => sum + a.minutes, 0);
      const newEnd = new Date(
        new Date(entry.start).getTime() + totalMin * 60_000
      ).toISOString();
      const first = remaining[0];
      return [
        {
          ...entry,
          agenda: remaining.length > 1 ? remaining : undefined,
          planTaskId: first.planTaskId,
          end: newEnd,
          title: remaining.map((a) => a.title).join(" · "),
          type: first.type,
        },
      ];
    });
  }

  /** Lazy load the things needed to place a new entry; cached across calls. */
  let _ctx: {
    timeWindows: ReturnType<typeof parseTimeWindowsJson>;
    externalBusy: Awaited<ReturnType<typeof getExternalBusy>>["intervals"];
    blackoutBusy: ReturnType<typeof blackoutsToBusy>;
    forbidBusy: ReturnType<typeof compileForbidRulesToBusy>;
    deadlinePlus1: Date;
    maxMinutesPerDay: number;
    slotEffectiveness: Record<string, number>;
    crossPlanBusy: Awaited<ReturnType<typeof loadCrossPlanBusy>>["busy"];
    crossPlanDailyMinutes: Awaited<
      ReturnType<typeof loadCrossPlanBusy>
    >["initialDailyMinutesUsed"];
    placementRules: ReturnType<typeof parsePlacementRules>;
    phaseCount: number;
  } | null = null;
  async function placementCtx() {
    if (_ctx) return _ctx;
    const [pref, calRead, crossPlan] = await Promise.all([
      ensureUserPreferences(userId),
      getExternalBusy({
        userId,
        accessToken,
        from: now,
        to: new Date(plan.deadline.getTime() + 864e5),
      }),
      loadCrossPlanBusy({ userId, excludePlanId: planId }),
    ]);
    const tw = parseTimeWindowsJson(pref.timeWindows);
    const externalBusy = calRead.intervals;
    const blackoutBusy = blackoutsToBusy(parseBlackouts(plan.manualBlackouts));
    const slotEffectiveness = JSON.parse(
      pref.slotEffectiveness || "{}"
    ) as Record<string, number>;
    const placementRules = parsePlacementRules(plan.placementRules);
    const deadlinePlus1 = new Date(plan.deadline.getTime() + 864e5);
    const forbidBusy = compileForbidRulesToBusy(placementRules, {
      startDate: now,
      deadline: deadlinePlus1,
    });
    const sproutPlan = JSON.parse(plan.planJson || "{}") as SproutPlan;
    _ctx = {
      timeWindows: tw,
      externalBusy,
      blackoutBusy,
      forbidBusy,
      deadlinePlus1,
      maxMinutesPerDay: pref.maxMinutesDay,
      slotEffectiveness,
      crossPlanBusy: crossPlan.busy,
      crossPlanDailyMinutes: crossPlan.initialDailyMinutesUsed,
      placementRules,
      phaseCount: (sproutPlan.phases ?? []).length,
    };
    return _ctx;
  }

  async function updateSlotEffectiveness(slotIso: string, r: number) {
    const key = slotKeyFromIso(slotIso);
    const pref = await ensureUserPreferences(userId);
    const cur = JSON.parse(pref.slotEffectiveness || "{}") as Record<string, number>;
    const updated = JSON.stringify(smoothUpdate(cur, key, r));
    await prisma.userPreference.update({
      where: { userId },
      data: { slotEffectiveness: updated },
    });
  }

  let outSchedule = sessions;

  // ============== REVIEW path ==============
  if (isReview) {
    const ri = reviewInstance!;
    const ls = ri.lessonState;
    const ratingChanged = rating != null && rating !== currentRating;

    if (completed === true) {
      const finalRating = rating ?? currentRating!;
      await prisma.reviewInstance.update({
        where: { id: ri.id },
        data: { projected: false, completedAt: now, rating: finalRating },
      });
      if (sessIsFuture) outSchedule = removeTaskFromSchedule(outSchedule);
      if (ratingChanged) {
        outSchedule = await advanceFsrsAndPlaceNewReviews({
          planId,
          plan,
          lessonState: ls,
          rating: finalRating as UiRating,
          now,
          schedule: outSchedule,
          ctxLoader: placementCtx,
        });
      }
      if (rating != null && sess) await updateSlotEffectiveness(sess.start, rating);
    } else if (completed === false) {
      // Re-open: leave FSRS state alone (per Q10 (B)).
      await prisma.reviewInstance.update({
        where: { id: ri.id },
        data: { projected: true, completedAt: null },
      });
      if (sessIdx >= 0) outSchedule = removeTaskFromSchedule(outSchedule);
      const sproutPlan = JSON.parse(plan.planJson || "{}") as SproutPlan;
      const lessonTask = (sproutPlan.tasks ?? []).find(
        (t) => t.id === ls.lessonId
      );
      const reviewTask = reviewInstanceToTask({
        review: ri,
        lessonTitle: lessonTask?.title ?? "lesson",
        parentLessonId: ls.lessonId,
        planStartDate: plan.startDate,
      });
      const ctx = await placementCtx();
      const result = packIntoExistingSchedule({
        newTasks: [reviewTask],
        existingSchedule: outSchedule,
        startDate: now,
        deadline: ctx.deadlinePlus1,
        timeWindows: ctx.timeWindows,
        externalBusy: [
          ...ctx.externalBusy,
          ...ctx.crossPlanBusy,
          ...ctx.blackoutBusy,
          ...ctx.forbidBusy,
        ],
        maxMinutesPerDay: ctx.maxMinutesPerDay,
        slotEffectiveness: ctx.slotEffectiveness,
        extraDailyMinutesUsed: ctx.crossPlanDailyMinutes,
        placementRules: ctx.placementRules,
        phaseCount: ctx.phaseCount,
      });
      outSchedule = result.schedule;
    } else if (rating != null) {
      // Re-rate an already-completed review.
      await prisma.reviewInstance.update({
        where: { id: ri.id },
        data: { rating },
      });
      if (ratingChanged) {
        outSchedule = await advanceFsrsAndPlaceNewReviews({
          planId,
          plan,
          lessonState: ls,
          rating: rating as UiRating,
          now,
          schedule: outSchedule,
          ctxLoader: placementCtx,
        });
      }
      if (sess) await updateSlotEffectiveness(sess.start, rating);
    }

    return { ok: true, scheduleJson: JSON.stringify(outSchedule) };
  }

  // ============== LESSON / MILESTONE path ==============
  if (completed === true) {
    const finalRating = rating ?? currentRating!;
    await prisma.taskCompletion.upsert({
      where: { planId_taskId: { planId, taskId } },
      create: {
        planId,
        taskId,
        completed: true,
        completedAt: now,
        rating: finalRating,
      },
      update: { completed: true, completedAt: now, rating: finalRating },
    });
    if (sessIsFuture) outSchedule = removeTaskFromSchedule(outSchedule);
    if (rating != null && sess) await updateSlotEffectiveness(sess.start, rating);
  } else if (completed === false) {
    // Re-open: clear completion + rating, place a new schedule entry.
    await prisma.taskCompletion.upsert({
      where: { planId_taskId: { planId, taskId } },
      create: {
        planId,
        taskId,
        completed: false,
        completedAt: null,
        rating: null,
      },
      update: { completed: false, completedAt: null, rating: null },
    });
    if (sessIdx >= 0) outSchedule = removeTaskFromSchedule(outSchedule);
    const sproutPlan = JSON.parse(plan.planJson || "{}") as SproutPlan;
    const planTask = (sproutPlan.tasks ?? []).find((t) => t.id === taskId);
    if (planTask) {
      const ctx = await placementCtx();
      const result = packIntoExistingSchedule({
        newTasks: [planTask],
        existingSchedule: outSchedule,
        startDate: now,
        deadline: ctx.deadlinePlus1,
        timeWindows: ctx.timeWindows,
        externalBusy: [
          ...ctx.externalBusy,
          ...ctx.crossPlanBusy,
          ...ctx.blackoutBusy,
          ...ctx.forbidBusy,
        ],
        maxMinutesPerDay: ctx.maxMinutesPerDay,
        slotEffectiveness: ctx.slotEffectiveness,
        extraDailyMinutesUsed: ctx.crossPlanDailyMinutes,
        placementRules: ctx.placementRules,
        phaseCount: ctx.phaseCount,
      });
      outSchedule = result.schedule;
    }
  } else if (rating != null) {
    await prisma.taskCompletion.update({
      where: { planId_taskId: { planId, taskId } },
      data: { rating },
    });
    if (sess) await updateSlotEffectiveness(sess.start, rating);
  }

  return { ok: true, scheduleJson: JSON.stringify(outSchedule) };
}

/**
 * Apply a fresh rating to the parent lesson's FSRS state, drop the existing
 * future projected reviews for that lesson, project a new chain, and place each
 * new ReviewInstance into the next open slot. Existing past + locked + unrelated
 * future entries are NEVER touched.
 */
async function advanceFsrsAndPlaceNewReviews(args: {
  planId: string;
  plan: LearningPlan;
  lessonState: {
    id: string;
    lessonId: string;
    difficulty: number;
    stability: number;
    lastReview: Date | null;
    lapses: number;
  };
  rating: UiRating;
  now: Date;
  schedule: ScheduledSession[];
  ctxLoader: () => Promise<{
    timeWindows: ReturnType<typeof parseTimeWindowsJson>;
    externalBusy: Awaited<ReturnType<typeof getExternalBusy>>["intervals"];
    blackoutBusy: ReturnType<typeof blackoutsToBusy>;
    forbidBusy: ReturnType<typeof compileForbidRulesToBusy>;
    deadlinePlus1: Date;
    maxMinutesPerDay: number;
    slotEffectiveness: Record<string, number>;
    crossPlanBusy: Awaited<ReturnType<typeof loadCrossPlanBusy>>["busy"];
    crossPlanDailyMinutes: Awaited<
      ReturnType<typeof loadCrossPlanBusy>
    >["initialDailyMinutesUsed"];
    placementRules: ReturnType<typeof parsePlacementRules>;
    phaseCount: number;
  }>;
}): Promise<ScheduledSession[]> {
  const { plan, lessonState: ls, rating, now, schedule } = args;
  const { next, dueAt } = applyRating({
    state: {
      difficulty: ls.difficulty,
      stability: ls.stability,
      lastReview: ls.lastReview,
      lapses: ls.lapses,
    },
    uiRating: rating,
    now,
    intensity: plan.intensity,
  });
  await prisma.lessonState.update({
    where: { id: ls.id },
    data: {
      difficulty: next.difficulty,
      stability: next.stability,
      lastReview: next.lastReview,
      lapses: next.lapses,
    },
  });

  // Find the IDs of the projected reviews we're about to drop, so we can clean
  // up their stale schedule entries (they now point to dead ReviewInstance ids).
  const oldProjected = await prisma.reviewInstance.findMany({
    where: {
      lessonStateId: ls.id,
      projected: true,
      dueAt: { gt: now },
    },
    select: { id: true },
  });
  const oldProjectedIds = new Set(oldProjected.map((r) => r.id));
  await prisma.reviewInstance.deleteMany({
    where: {
      lessonStateId: ls.id,
      projected: true,
      dueAt: { gt: now },
    },
  });

  // Drop schedule entries that referenced any of the now-deleted ReviewInstances.
  // This is a surgical removal — only entries belonging to the dropped chain.
  const outSchedule = schedule.flatMap((entry) => {
    const containsId = (id: string) =>
      entry.planTaskId === id ||
      entry.agenda?.some((a) => a.planTaskId === id);
    const matched = [...oldProjectedIds].some(containsId);
    if (!matched) return [entry];
    if (!entry.agenda || entry.agenda.length <= 1) return [];
    const remaining = entry.agenda.filter((a) => !oldProjectedIds.has(a.planTaskId));
    if (remaining.length === 0) return [];
    const totalMin = remaining.reduce((sum, a) => sum + a.minutes, 0);
    const newEnd = new Date(
      new Date(entry.start).getTime() + totalMin * 60_000
    ).toISOString();
    const first = remaining[0];
    return [
      {
        ...entry,
        agenda: remaining.length > 1 ? remaining : undefined,
        planTaskId: first.planTaskId,
        end: newEnd,
        title: remaining.map((a) => a.title).join(" · "),
        type: first.type,
      },
    ];
  });

  // Project the new chain and create the new ReviewInstance rows.
  const dueDates = projectReviewChain({
    state: next,
    lessonEnd: new Date(dueAt.getTime() - 86_400_000),
    deadline: plan.deadline,
    intensity: plan.intensity,
    postDeadlineMode:
      plan.postDeadlineMode === "maintain" ? "maintain" : "stop",
  });
  const newInstances = await Promise.all(
    dueDates.map((due) =>
      prisma.reviewInstance.create({
        data: {
          planId: args.planId,
          lessonStateId: ls.id,
          projected: true,
          dueAt: due,
        },
      })
    )
  );

  // Look up the parent lesson title so the new schedule entries read nicely.
  const sproutPlan = JSON.parse(plan.planJson || "{}") as SproutPlan;
  const parent = (sproutPlan.tasks ?? []).find((t) => t.id === ls.lessonId);
  const lessonTitle = parent?.title ?? "lesson";

  // Hand the entire batch of new reviews to the scoring packer. It treats
  // every existing schedule entry as a hard busy block, seeds the daily-cap
  // counter from existing minutes, and places each review into the highest-
  // scoring open slot — respecting `maxMinutesPerDay`, slot effectiveness, and
  // the FSRS due-date proximity preference all at once. Critically, the packer
  // never touches existing entries, so the "no displacement" rule still holds.
  // Any review it can't fit before the deadline lands in `overflow` and stays
  // unscheduled in the DB (user will see it in to-do without a planned time).
  const ctx = await args.ctxLoader();
  const reviewTasks = newInstances.map((ri) =>
    reviewInstanceToTask({
      review: ri,
      lessonTitle,
      parentLessonId: ls.lessonId,
      planStartDate: plan.startDate,
    })
  );
  const packed = packIntoExistingSchedule({
    newTasks: reviewTasks,
    existingSchedule: outSchedule,
    startDate: now,
    deadline: ctx.deadlinePlus1,
    timeWindows: ctx.timeWindows,
    externalBusy: [
      ...ctx.externalBusy,
      ...ctx.crossPlanBusy,
      ...ctx.blackoutBusy,
      ...ctx.forbidBusy,
    ],
    maxMinutesPerDay: ctx.maxMinutesPerDay,
    slotEffectiveness: ctx.slotEffectiveness,
    extraDailyMinutesUsed: ctx.crossPlanDailyMinutes,
    placementRules: ctx.placementRules,
    phaseCount: ctx.phaseCount,
  });
  return packed.schedule;
}

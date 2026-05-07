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
import {
  applySignal,
  completionSignalFor,
  parseHourUtility,
  stringifyHourUtility,
  type HourUtilityMap,
} from "@/lib/hour-utility";
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
 *
 * Hour-utility signals: when a task is committed (completed:true), the
 * scheduled session is converted to either an on-time or early-completion
 * signal (via `completionSignalFor`) and applied to the user's `hourUtility`
 * map. Re-open does not produce a signal.
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

  if (completed === true && rating == null && currentRating == null) {
    return { ok: false, error: "Rate the task before marking it done.", status: 400 };
  }
  if (completed === undefined && rating != null && !currentCompleted) {
    return {
      ok: false,
      error: "Cannot rate a task without committing — send completed:true with the rating.",
      status: 400,
    };
  }
  if (completed === undefined && rating == null) {
    return { ok: true, scheduleJson: args.currentScheduleJson };
  }

  // --- Schedule helpers (closures over `sessions`) ---

  const sessIdx = sessions.findIndex(
    (x) => x.planTaskId === taskId || x.agenda?.some((a) => a.planTaskId === taskId)
  );
  const sess = sessIdx >= 0 ? sessions[sessIdx] : null;
  const sessIsFuture = !!sess && new Date(sess.start) > now;

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

  let _ctx: {
    timeWindows: ReturnType<typeof parseTimeWindowsJson>;
    externalBusy: Awaited<ReturnType<typeof getExternalBusy>>["intervals"];
    blackoutBusy: ReturnType<typeof blackoutsToBusy>;
    forbidBusy: ReturnType<typeof compileForbidRulesToBusy>;
    deadlinePlus1: Date;
    maxMinutesPerDay: number;
    hourUtility: HourUtilityMap;
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
    const hourUtility = parseHourUtility(pref.hourUtility);
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
      hourUtility,
      crossPlanBusy: crossPlan.busy,
      crossPlanDailyMinutes: crossPlan.initialDailyMinutesUsed,
      placementRules,
      phaseCount: (sproutPlan.phases ?? []).length,
    };
    return _ctx;
  }

  /**
   * Apply a completion-shaped utility signal for a session that just got
   * committed. Classification (early vs. on-time) is decided by
   * `completionSignalFor`. Reads the current `hourUtility`, applies one
   * signal, writes it back. Idempotent enough for the rate/re-rate loop:
   * re-rating an already-completed task does NOT re-apply the signal because
   * we only call this from the commit path.
   */
  async function recordCompletionSignal(scheduledStart: Date | null) {
    const signal = completionSignalFor({
      scheduledStart,
      completedAt: now,
    });
    if (!signal) return;
    const pref = await ensureUserPreferences(userId);
    const cur = parseHourUtility(pref.hourUtility);
    const next = applySignal(cur, signal.at, signal.magnitude, now);
    await prisma.userPreference.update({
      where: { userId },
      data: { hourUtility: stringifyHourUtility(next) },
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
      const scheduledStart = sess ? new Date(sess.start) : null;
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
      // Only credit a new utility signal on first commit, not on re-rate.
      if (!currentCompleted) await recordCompletionSignal(scheduledStart);
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
        hourUtility: ctx.hourUtility,
        now,
        planId,
        extraDailyMinutesUsed: ctx.crossPlanDailyMinutes,
        placementRules: ctx.placementRules,
        phaseCount: ctx.phaseCount,
      });
      outSchedule = result.schedule;
    } else if (rating != null) {
      // Re-rate an already-committed review (no completion signal).
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
    const scheduledStart = sess ? new Date(sess.start) : null;
    if (sessIsFuture) outSchedule = removeTaskFromSchedule(outSchedule);
    if (!currentCompleted) await recordCompletionSignal(scheduledStart);
  } else if (completed === false) {
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
        hourUtility: ctx.hourUtility,
        now,
        planId,
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
    // Pure re-rate without a fresh commit — no utility signal.
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
    hourUtility: HourUtilityMap;
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

  const sproutPlan = JSON.parse(plan.planJson || "{}") as SproutPlan;
  const parent = (sproutPlan.tasks ?? []).find((t) => t.id === ls.lessonId);
  const lessonTitle = parent?.title ?? "lesson";

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
    hourUtility: ctx.hourUtility,
    now,
    planId: args.planId,
    extraDailyMinutesUsed: ctx.crossPlanDailyMinutes,
    placementRules: ctx.placementRules,
    phaseCount: ctx.phaseCount,
  });
  return packed.schedule;
}

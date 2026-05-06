/**
 * Shared plan-state loader used by both the tend-page server component and
 * the `GET /api/plans/[id]` route handler. Centralizes the calendar refresh
 * + drift reconciliation + conflict-detection pipeline so both surfaces show
 * identical state.
 */
import { prisma } from "@/lib/db";
import { getBusyIntervals } from "@/lib/calendar-read";
import { reconcileDrift, type DriftResult } from "@/lib/sync-drift";
import { findConflicts, type ConflictReport } from "@/lib/conflicts";
import { parseBlackouts, blackoutsToBusy } from "@/lib/blackouts";
import { dedupeScheduleById } from "@/lib/scoring-pack";
import type { LearningPlan, TaskCompletion } from "@prisma/client";
import type { ScheduledSession } from "@/types/plan";

export interface PlanState {
  plan: LearningPlan;
  schedule: ScheduledSession[];
  completions: TaskCompletion[];
  drift: DriftResult;
  conflicts: ConflictReport;
}

function calendarWindow(plan: { startDate: Date; deadline: Date }): {
  from: Date;
  to: Date;
} {
  const now = new Date();
  const from = plan.startDate < now ? now : plan.startDate;
  const to = new Date(plan.deadline.getTime() + 86_400_000);
  return { from, to };
}

export async function loadPlanState(args: {
  planId: string;
  userId: string;
  accessToken: string | undefined;
}): Promise<PlanState | null> {
  const { planId, userId, accessToken } = args;
  const plan = await prisma.learningPlan.findFirst({
    where: { id: planId, userId },
  });
  if (!plan) return null;

  const completions = await prisma.taskCompletion.findMany({
    where: { planId },
  });

  const { from, to } = calendarWindow(plan);
  const calendarRead = await getBusyIntervals({ userId, accessToken, from, to });
  const blackoutBusy = blackoutsToBusy(parseBlackouts(plan.manualBlackouts));
  const busy = [...calendarRead.intervals, ...blackoutBusy];

  // Defensive dedup-on-read: if any prior write left the persisted scheduleJson
  // with duplicate session ids (collision in `sess-${taskId}` after a merge),
  // strip them here so React keys don't blow up downstream. First occurrence
  // wins. The next persistence cycle writes the cleaned shape back.
  const stored = dedupeScheduleById(
    JSON.parse(plan.scheduleJson || "[]") as ScheduledSession[]
  );
  // CRITICAL: only reconcile drift when the calendar fetch actually succeeded.
  // If the access token is expired / API is off, we'd otherwise see zero
  // Verdant events and conclude every synced session was deleted, wiping the
  // schedule. Skip reconcile entirely on read failure.
  const drift = calendarRead.ok
    ? reconcileDrift(stored, calendarRead.intervals)
    : { schedule: stored, adoptedIds: [], removedIds: [] };
  const conflicts = calendarRead.ok
    ? findConflicts(drift.schedule, busy)
    : { lockedConflicts: [], unlockedConflictIds: [] };

  let effectivePlan = plan;
  if (calendarRead.ok && (drift.adoptedIds.length > 0 || drift.removedIds.length > 0)) {
    const updated = await prisma.learningPlan.update({
      where: { id: planId },
      data: { scheduleJson: JSON.stringify(drift.schedule) },
    });
    effectivePlan = updated;
  }

  return {
    plan: effectivePlan,
    schedule: drift.schedule,
    completions,
    drift,
    conflicts,
  };
}

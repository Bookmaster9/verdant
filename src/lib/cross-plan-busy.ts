/**
 * Cross-plan scheduling support.
 *
 * Multi-sprout (Q1: shared global daily cap) means every active plan's schedule
 * is a hard immutable busy block from every *other* plan's perspective. This
 * helper turns "all the user's other active plans" into the busy intervals +
 * pre-seeded daily-minute counters that the scoring packer needs.
 *
 * Use anywhere a plan is being created, rebuilt, or surgically extended:
 *   - POST /api/plans (initial pack)
 *   - PATCH /api/plans/[id] (rebuild, reschedule, NL edit)
 *   - applyTaskFeedback re-open + FSRS chain extension (task-feedback.ts)
 */
import { prisma } from "@/lib/db";
import type { ScheduledSession } from "@/types/plan";
import type { BusyInterval } from "@/lib/calendar-read";

export interface CrossPlanBusy {
  /** Each session from every OTHER active plan, shaped as a busy interval. */
  busy: BusyInterval[];
  /** Per-day minutes already consumed by other plans. Keyed by ISO YYYY-MM-DD. */
  initialDailyMinutesUsed: Map<string, number>;
}

/**
 * Fetch every active plan owned by `userId` *except* `excludePlanId`, and
 * convert their stored schedule entries into busy intervals + per-day minutes.
 *
 * Pass `excludePlanId = null` (or omit) when there's no current plan to skip
 * (e.g. during plan creation — the new plan doesn't exist in the DB yet).
 */
export async function loadCrossPlanBusy(args: {
  userId: string;
  excludePlanId?: string | null;
}): Promise<CrossPlanBusy> {
  const others = await prisma.learningPlan.findMany({
    where: {
      userId: args.userId,
      status: "active",
      ...(args.excludePlanId
        ? { id: { not: args.excludePlanId } }
        : {}),
    },
    select: { id: true, scheduleJson: true },
  });

  const busy: BusyInterval[] = [];
  const initialDailyMinutesUsed = new Map<string, number>();

  for (const p of others) {
    const sessions = JSON.parse(p.scheduleJson || "[]") as ScheduledSession[];
    for (const sess of sessions) {
      const start = new Date(sess.start);
      const end = new Date(sess.end);
      busy.push({
        start,
        end,
        calendarEventId: sess.calendarEventId ?? `verdant-${p.id}-${sess.id}`,
        isVerdant: true,
      });
      const k = start.toISOString().slice(0, 10);
      const minutes = Math.max(0, (end.getTime() - start.getTime()) / 60_000);
      initialDailyMinutesUsed.set(
        k,
        (initialDailyMinutesUsed.get(k) ?? 0) + minutes
      );
    }
  }

  return { busy, initialDailyMinutesUsed };
}

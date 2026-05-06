/**
 * Two-way sync drift reconciliation (design Q8).
 *
 * When the user moves or deletes a Verdant-synced event inside Google Calendar,
 * the live calendar disagrees with our `scheduleJson`. This module reconciles:
 *
 *   - Move drift: live event start/end differ from stored session
 *       → adopt the new times and auto-lock (`locked = true`).
 *   - Delete drift: live event is gone (no entry in `verdantEvents`)
 *       → drop the session from the schedule. The plan task in `planJson`
 *         survives so phase totals don't shift; user can re-run reschedule.
 *
 * No prompts. The UI surfaces these as informational toasts.
 */
import type { ScheduledSession } from "@/types/plan";
import type { BusyInterval } from "@/lib/calendar-read";

export interface DriftResult {
  schedule: ScheduledSession[];
  /** Sessions whose start/end were updated and that are now locked. */
  adoptedIds: string[];
  /** Sessions removed because their calendar event was deleted. */
  removedIds: string[];
}

const DRIFT_TOLERANCE_MS = 60_000;

function isoDiffer(a: string, b: Date): boolean {
  return Math.abs(new Date(a).getTime() - b.getTime()) > DRIFT_TOLERANCE_MS;
}

/**
 * Reconcile `schedule` against the live Verdant-owned events from the calendar.
 *
 * @param schedule  Stored sessions (from `plan.scheduleJson`).
 * @param busy      All busy intervals from `getBusyIntervals`. Verdant entries
 *                  (where `isVerdant === true`) are treated as the live truth
 *                  for already-synced sessions.
 */
export function reconcileDrift(
  schedule: ScheduledSession[],
  busy: BusyInterval[]
): DriftResult {
  const verdantById = new Map<string, BusyInterval>();
  for (const b of busy) {
    if (b.isVerdant) verdantById.set(b.calendarEventId, b);
  }

  const adoptedIds: string[] = [];
  const removedIds: string[] = [];
  const out: ScheduledSession[] = [];

  for (const sess of schedule) {
    if (!sess.calendarEventId || !sess.googleSynced) {
      out.push(sess);
      continue;
    }
    const live = verdantById.get(sess.calendarEventId);
    if (!live) {
      removedIds.push(sess.id);
      continue;
    }
    const moved =
      isoDiffer(sess.start, live.start) || isoDiffer(sess.end, live.end);
    if (moved) {
      adoptedIds.push(sess.id);
      out.push({
        ...sess,
        start: live.start.toISOString(),
        end: live.end.toISOString(),
        locked: true,
      });
    } else {
      out.push(sess);
    }
  }

  return { schedule: out, adoptedIds, removedIds };
}

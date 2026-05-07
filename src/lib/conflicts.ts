/**
 * Conflict detection between Verdant sessions and *external* calendar busy
 * intervals.
 *
 *   - Locked sessions that collide with external events → surfaced as a banner;
 *     user picks "Unlock & reschedule" or "Keep here". Not auto-moved.
 *   - Unlocked sessions that collide → eligible for the auto-reschedule pass
 *     called by the same refresh path. Caller is expected to drop these from
 *     the schedule and re-pack the underlying tasks.
 *
 * Post-scope-migration: callers pass busy intervals that are guaranteed
 * external (FreeBusy on primary doesn't see Verdant's secondary calendar),
 * so this module no longer filters by an `isVerdant` tag.
 */
import type { ScheduledSession } from "@/types/plan";
import type { BusyInterval } from "@/lib/calendar-read";

export interface SessionConflict {
  session: ScheduledSession;
  /** External busy intervals that overlap this session. */
  overlapping: BusyInterval[];
}

export interface ConflictReport {
  lockedConflicts: SessionConflict[];
  unlockedConflictIds: string[];
}

function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function findConflicts(
  schedule: ScheduledSession[],
  external: BusyInterval[]
): ConflictReport {
  const lockedConflicts: SessionConflict[] = [];
  const unlockedConflictIds: string[] = [];

  for (const sess of schedule) {
    const sStart = new Date(sess.start).getTime();
    const sEnd = new Date(sess.end).getTime();
    const overlapping: BusyInterval[] = [];
    for (const b of external) {
      if (overlaps(sStart, sEnd, b.start.getTime(), b.end.getTime())) {
        overlapping.push(b);
      }
    }
    if (overlapping.length === 0) continue;
    if (sess.locked) {
      lockedConflicts.push({ session: sess, overlapping });
    } else {
      unlockedConflictIds.push(sess.id);
    }
  }

  return { lockedConflicts, unlockedConflictIds };
}

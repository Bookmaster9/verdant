/**
 * Per-user learned hour-of-week utility map.
 *
 * Replaces the legacy `slotEffectiveness` (1–5 ratings, exponentially smoothed)
 * with a signed accumulator decayed exponentially in time. Each cell is keyed
 * by `<dow>-<HH>` (dow = Date.getDay(), Sun=0..Sat=6; HH = 00–23).
 *
 * Cell shape: `{ v: number; t: ISO-string }`
 *   - `v` is the accumulated, possibly-signed utility *at time `t`*.
 *   - On read, `v` is decayed by `0.5 ^ (age / 30 days)`.
 *   - On write, the current cell is decayed to `now` first, then the new
 *     contribution is added, and `t` becomes `now`.
 *
 * Smearing: every signal lands at the target cell at full magnitude and at
 * the ±1-hour neighbours (same day of week) at 0.5×. Day boundaries are
 * not crossed — Mon 00:00's "previous hour" is not Sun 23:00.
 *
 * Signal taxonomy (calibrated; see grill-me design Q4 + Q8):
 *   - manual shift (origin / destination): −1.0 / +2.0 at the target
 *   - on-time completion (within ±2h of scheduled start): +1.0
 *   - early completion (≥12h before scheduled start, lands at *actual* hour): +1.5
 *   - missed (now > end + 24h, no completion, not rescheduled): −2.0
 *   - pushed-back origin / destination (shift while past): −3.0 / +1.0
 */
import type { ScheduledSession } from "@/types/plan";

export interface HourUtilityCell {
  /** Accumulated, signed utility value, valid as of `t`. */
  v: number;
  /** ISO timestamp of the last write. Read-time decay is computed against this. */
  t: string;
}

export type HourUtilityMap = Record<string, HourUtilityCell>;

export const HALF_LIFE_DAYS = 30;
const DECAY_PER_MS = Math.LN2 / (HALF_LIFE_DAYS * 86_400_000);
const NEIGHBOR_SMEAR_FACTOR = 0.5;

/** Signal magnitudes at the target cell (before smearing). */
export const SIGNAL_MAGNITUDE = {
  manualShiftOrigin: -1.0,
  manualShiftDestination: 2.0,
  onTimeCompletion: 1.0,
  earlyCompletion: 1.5,
  missed: -2.0,
  pushedBackOrigin: -3.0,
  pushedBackDestination: 1.0,
} as const;

export function cellKey(dow: number, hour: number): string {
  return `${dow}-${String(hour).padStart(2, "0")}`;
}

/** Pure decay of a stored value to `now`, no write. */
function decayedValue(cell: HourUtilityCell | undefined, now: Date): number {
  if (!cell) return 0;
  const fromMs = new Date(cell.t).getTime();
  if (Number.isNaN(fromMs)) return 0;
  const age = Math.max(0, now.getTime() - fromMs);
  return cell.v * Math.exp(-DECAY_PER_MS * age);
}

export function parseHourUtility(json: string | null | undefined): HourUtilityMap {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    if (typeof v !== "object" || v === null) return {};
    const out: HourUtilityMap = {};
    for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as { v?: unknown; t?: unknown };
      if (typeof r.v === "number" && typeof r.t === "string") {
        out[key] = { v: r.v, t: r.t };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function stringifyHourUtility(map: HourUtilityMap): string {
  return JSON.stringify(map);
}

/**
 * Cells touched by a signal at (dow, hour). Target at full weight; ±1 hour
 * neighbours within the same day at NEIGHBOR_SMEAR_FACTOR. No cross-day
 * smearing.
 */
function smearedCells(
  dow: number,
  hour: number
): Array<{ key: string; weight: number }> {
  const out: Array<{ key: string; weight: number }> = [
    { key: cellKey(dow, hour), weight: 1.0 },
  ];
  if (hour > 0) {
    out.push({ key: cellKey(dow, hour - 1), weight: NEIGHBOR_SMEAR_FACTOR });
  }
  if (hour < 23) {
    out.push({ key: cellKey(dow, hour + 1), weight: NEIGHBOR_SMEAR_FACTOR });
  }
  return out;
}

/**
 * Add `magnitude` to the cell at `at`, with neighbour smearing. Returns a new
 * map (input is not mutated). Each touched cell is decayed to `now` before
 * the contribution is added, and `t` becomes `now`.
 */
export function applySignal(
  map: HourUtilityMap,
  at: Date,
  magnitude: number,
  now: Date
): HourUtilityMap {
  if (Number.isNaN(at.getTime())) return map;
  const dow = at.getDay();
  const hour = at.getHours();
  const next: HourUtilityMap = { ...map };
  const tIso = now.toISOString();
  for (const { key, weight } of smearedCells(dow, hour)) {
    const decayed = decayedValue(next[key], now);
    next[key] = { v: decayed + magnitude * weight, t: tIso };
  }
  return next;
}

/** Apply many signals in sequence (more efficient than reduce on caller side). */
export function applySignals(
  map: HourUtilityMap,
  signals: Array<{ at: Date; magnitude: number }>,
  now: Date
): HourUtilityMap {
  let cur = map;
  for (const s of signals) {
    cur = applySignal(cur, s.at, s.magnitude, now);
  }
  return cur;
}

/**
 * Duration-weighted average utility for a slot starting at `slotStart` and
 * lasting `durationMinutes`. Each hour-cell the slot overlaps contributes
 * proportionally to its overlap. Result has the same magnitude as a single
 * cell value (the *average*, not the sum) so a 30-min review and a 90-min
 * lesson on the same hour are scored on equal footing.
 *
 * If the slot crosses an hour boundary, the two cells are weighted by their
 * actual overlap with the slot.
 */
export function readUtilityForSlot(
  map: HourUtilityMap,
  slotStart: Date,
  durationMinutes: number,
  now: Date
): number {
  const startMs = slotStart.getTime();
  const endMs = startMs + Math.max(1, durationMinutes) * 60_000;

  // Walk hour-cells that overlap [startMs, endMs).
  const cursor = new Date(startMs);
  cursor.setMinutes(0, 0, 0); // round down to top of hour

  let totalWeighted = 0;
  let totalWeight = 0;
  while (cursor.getTime() < endMs) {
    const cellStart = cursor.getTime();
    const cellEnd = cellStart + 3_600_000;
    const overlap = Math.max(
      0,
      Math.min(endMs, cellEnd) - Math.max(startMs, cellStart)
    );
    if (overlap > 0) {
      const dow = cursor.getDay();
      const hour = cursor.getHours();
      const v = decayedValue(map[cellKey(dow, hour)], now);
      totalWeighted += v * overlap;
      totalWeight += overlap;
    }
    cursor.setTime(cellEnd);
  }
  return totalWeight > 0 ? totalWeighted / totalWeight : 0;
}

/**
 * Compute completion-signal classification for a session that just got rated.
 * Returns the (at, magnitude) tuple that should be applied — or `null` when
 * the timing doesn't qualify for a completion signal at all (e.g. session
 * was a long way in the past and the completion is just bookkeeping).
 *
 * - Early completion (≥12h before scheduled start): credit `+1.5` at the
 *   *actual completion* hour, not the scheduled hour. Reason: the user
 *   voluntarily moved earlier, so the actual hour is the revealed preference.
 * - On-time (within ±2h of scheduled start): credit `+1.0` at the scheduled
 *   hour.
 * - Late but completed: credit `+1.0` at the scheduled hour. Mild reward;
 *   they did get it done.
 */
export function completionSignalFor(args: {
  scheduledStart: Date | null;
  completedAt: Date;
}): { at: Date; magnitude: number } | null {
  const { scheduledStart, completedAt } = args;
  if (!scheduledStart || Number.isNaN(scheduledStart.getTime())) {
    // No scheduled slot to attribute the completion to.
    return null;
  }
  const deltaMs = completedAt.getTime() - scheduledStart.getTime();
  // Early: completed at least 12h before scheduled start.
  if (deltaMs <= -12 * 3_600_000) {
    return { at: completedAt, magnitude: SIGNAL_MAGNITUDE.earlyCompletion };
  }
  return { at: scheduledStart, magnitude: SIGNAL_MAGNITUDE.onTimeCompletion };
}

/**
 * Detect sessions that should retroactively count as "missed" for utility
 * purposes. A session is missed iff:
 *   - its end is more than 24h in the past
 *   - it has no recorded completion
 *   - it has not already been credited as missed (we use a marker on the
 *     ScheduledSession to prevent double-counting on repeat reads)
 *
 * Returns the (sessionId, scheduledStart) pairs that should both:
 *   1. Be credited with a missed signal in the user's hour-utility map
 *   2. Have the marker stamped on so we don't credit them again
 *
 * The caller is expected to apply the signals to the map and then write the
 * updated schedule back. Pure function — no I/O.
 */
export function detectMissedSessions(args: {
  schedule: ScheduledSession[];
  completedTaskIds: Set<string>;
  now: Date;
}): Array<{ sessionId: string; planTaskIds: string[]; scheduledStart: Date }> {
  const { schedule, completedTaskIds, now } = args;
  const cutoffMs = now.getTime() - 24 * 3_600_000;
  const out: Array<{
    sessionId: string;
    planTaskIds: string[];
    scheduledStart: Date;
  }> = [];
  for (const sess of schedule) {
    if (sess.missedSignalAppliedAt) continue;
    const endMs = new Date(sess.end).getTime();
    if (Number.isNaN(endMs) || endMs >= cutoffMs) continue;
    // Build the list of plan task ids in this session.
    const ids = sess.agenda
      ? sess.agenda.map((a) => a.planTaskId)
      : [sess.planTaskId];
    // If every constituent task was completed, the session as a whole was
    // satisfied — no miss.
    const allCompleted = ids.every((id) => completedTaskIds.has(id));
    if (allCompleted) continue;
    out.push({
      sessionId: sess.id,
      planTaskIds: ids,
      scheduledStart: new Date(sess.start),
    });
  }
  return out;
}

/**
 * Stamp the `missedSignalAppliedAt` marker on each session in `sessionIds`.
 * Returns a new schedule array (input not mutated).
 */
export function markMissedSessionsApplied(
  schedule: ScheduledSession[],
  sessionIds: Set<string>,
  now: Date
): ScheduledSession[] {
  if (sessionIds.size === 0) return schedule;
  const tIso = now.toISOString();
  return schedule.map((sess) =>
    sessionIds.has(sess.id)
      ? { ...sess, missedSignalAppliedAt: tIso }
      : sess
  );
}

// -----------------------------------------------------------------------------
// Coarse aggregations — used by `availability-summary.ts` and any UI that
// wants a rough morning/afternoon/evening summary of the learned map.
// -----------------------------------------------------------------------------

/**
 * Coarse morning/afternoon/evening histogram of the *positive* portion of the
 * learned map. Only positive cells contribute (we want to surface preferred
 * times, not avoided times). Sums to 1 across the three buckets, or all zeros
 * if there's no positive signal.
 */
export function preferredTimeOfDayHistogram(
  map: HourUtilityMap,
  now: Date
): { morning: number; afternoon: number; evening: number } {
  let morning = 0;
  let afternoon = 0;
  let evening = 0;
  for (const [key, cell] of Object.entries(map)) {
    const hr = parseInt(key.split("-")[1] ?? "", 10);
    if (Number.isNaN(hr)) continue;
    const v = decayedValue(cell, now);
    if (v <= 0) continue;
    if (hr < 12) morning += v;
    else if (hr < 17) afternoon += v;
    else evening += v;
  }
  const total = morning + afternoon + evening;
  if (total === 0) return { morning: 0, afternoon: 0, evening: 0 };
  return {
    morning: Math.round((morning / total) * 100) / 100,
    afternoon: Math.round((afternoon / total) * 100) / 100,
    evening: Math.round((evening / total) * 100) / 100,
  };
}

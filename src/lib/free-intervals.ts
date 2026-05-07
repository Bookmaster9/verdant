/**
 * Compose the user's declared `timeWindows` with calendar busy intervals to
 * produce per-day free sub-intervals (design Q2: windows ∩ ¬busy).
 *
 * Behavior contract:
 *   - When `busy === []`, each day yields a single sub-interval that exactly
 *     matches the day's `timeWindows` entry. The existing packer therefore
 *     behaves identically to the pre-busy world.
 *   - When `busy` is non-empty, the day's window is fragmented into the
 *     gaps between busy intervals, clamped to the window edges.
 *
 * All day-of-week and wall-clock arithmetic happens in the user's `tz`. The
 * server's local zone (UTC on Vercel) is never consulted, so a window like
 * "07:00–22:00" lands at the user's 07:00, not 07:00 UTC.
 */
import type { TimeWindows } from "@/types/plan";
import type { BusyInterval } from "@/lib/calendar-read";
import {
  addDaysInTz,
  dowSunZeroInTz,
  localWallClockToUtcIso,
  startOfDayInTz,
  ymdInTz,
} from "@/lib/tz";

export interface FreeInterval {
  start: Date;
  end: Date;
}

function dayWindows(
  day: Date,
  timeWindows: TimeWindows,
  tz: string
): FreeInterval[] {
  const wd = String(dowSunZeroInTz(day, tz));
  const list = timeWindows[wd] ?? timeWindows[wd === "0" ? "7" : wd];
  if (!list || list.length === 0) return [];
  const ymd = ymdInTz(day, tz);
  const out: FreeInterval[] = [];
  for (const w of list) {
    const startIso = localWallClockToUtcIso(ymd, w.start, tz);
    const endIso = localWallClockToUtcIso(ymd, w.end, tz);
    if (!startIso || !endIso) continue;
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (end.getTime() <= start.getTime()) continue;
    out.push({ start, end });
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out;
}

/**
 * Subtract overlapping busy intervals from a single window. Returns the gaps.
 */
function subtractBusy(
  window: FreeInterval,
  busy: BusyInterval[]
): FreeInterval[] {
  const overlapping = busy
    .filter((b) => b.end > window.start && b.start < window.end)
    .map((b) => ({
      start: b.start < window.start ? window.start : b.start,
      end: b.end > window.end ? window.end : b.end,
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (overlapping.length === 0) return [window];

  const merged: FreeInterval[] = [];
  for (const o of overlapping) {
    const last = merged[merged.length - 1];
    if (last && o.start <= last.end) {
      if (o.end > last.end) last.end = o.end;
    } else {
      merged.push({ start: new Date(o.start), end: new Date(o.end) });
    }
  }

  const out: FreeInterval[] = [];
  let cursor = window.start;
  for (const m of merged) {
    if (m.start > cursor) {
      out.push({ start: cursor, end: m.start });
    }
    if (m.end > cursor) cursor = m.end;
  }
  if (cursor < window.end) out.push({ start: cursor, end: window.end });
  return out;
}

/**
 * Free sub-intervals for a single calendar day = (day's windows) ∩ ¬busy.
 * Each declared window contributes its own gaps; the resulting fragments are
 * concatenated and returned in start-time order. The "calendar day" is the
 * one containing `day` in the user's `tz`.
 */
export function freeIntervalsForDay(
  day: Date,
  timeWindows: TimeWindows,
  busy: BusyInterval[],
  tz: string
): FreeInterval[] {
  const windows = dayWindows(day, timeWindows, tz);
  if (windows.length === 0) return [];
  const out: FreeInterval[] = [];
  for (const w of windows) {
    out.push(...subtractBusy(w, busy));
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out;
}

/**
 * Free sub-intervals for an inclusive day range. Day boundaries are taken in
 * the user's `tz`.
 */
export function freeIntervalsForRange(
  from: Date,
  to: Date,
  timeWindows: TimeWindows,
  busy: BusyInterval[],
  tz: string
): FreeInterval[] {
  const out: FreeInterval[] = [];
  const start = startOfDayInTz(from, tz);
  const end = startOfDayInTz(to, tz);
  for (let d = 0; d < 400; d++) {
    const day = addDaysInTz(start, d, tz);
    if (day > end) break;
    out.push(...freeIntervalsForDay(day, timeWindows, busy, tz));
  }
  return out;
}

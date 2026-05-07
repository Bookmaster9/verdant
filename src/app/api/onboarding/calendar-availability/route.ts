/**
 * Onboarding helper: infer time windows from the user's actual calendar.
 *
 * Reads the past 7 days from Google Calendar (one sample per weekday) and
 * returns the inferred `TimeWindows` — gaps inside a "reasonable hours" band
 * that are at least MIN_BLOCK_MIN long. The user reviews + edits in the
 * onboarding modal heatmap before saving.
 *
 * Auth: standard session.
 * Output: `{ timeWindows }` matching the TimeWindows shape used everywhere.
 */
import { auth } from "@/auth";
import { getExternalBusy } from "@/lib/calendar-read";
import type { TimeWindow, TimeWindows } from "@/types/plan";
import { NextResponse } from "next/server";
import { addDays, startOfDay } from "date-fns";

const REASONABLE_START_HOUR = 7; // don't suggest 3am as available
const REASONABLE_END_HOUR = 22;
const MIN_BLOCK_MIN = 30;
const LOOKBACK_DAYS = 7;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function minutesToHHmm(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}
/** Local-time minutes-from-midnight for a Date. */
function localMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Find free intervals inside [startMin, endMin] on `day` given a list of
 * busy intervals. Free blocks shorter than `minBlockMin` are dropped.
 */
function freeBlocksOnDay(
  day: Date,
  busy: { start: Date; end: Date }[],
  startMin: number,
  endMin: number,
  minBlockMin: number
): { startMin: number; endMin: number }[] {
  const sod = startOfDay(day);
  // Project busy to local-minutes-on-this-day, clipped to [startMin, endMin].
  const overlapping = busy
    .map((b) => {
      const sameDay = startOfDay(b.start).getTime() === sod.getTime();
      const sameDayEnd = startOfDay(b.end).getTime() === sod.getTime();
      // Only count busy that touches this day. Multi-day events: clip.
      if (!sameDay && !sameDayEnd && b.start > sod && b.end < addDays(sod, 1))
        return null;
      const bsMin = sameDay ? localMinutes(b.start) : 0;
      const beMin = sameDayEnd ? localMinutes(b.end) : 24 * 60;
      const s = Math.max(startMin, bsMin);
      const e = Math.min(endMin, beMin);
      if (e <= s) return null;
      return { s, e };
    })
    .filter((x): x is { s: number; e: number } => x !== null)
    .sort((a, b) => a.s - b.s);

  // Merge overlapping busy blocks.
  const merged: { s: number; e: number }[] = [];
  for (const b of overlapping) {
    const last = merged[merged.length - 1];
    if (last && b.s <= last.e) {
      last.e = Math.max(last.e, b.e);
    } else {
      merged.push({ ...b });
    }
  }

  // Walk gaps.
  const out: { startMin: number; endMin: number }[] = [];
  let cursor = startMin;
  for (const m of merged) {
    if (m.s > cursor) out.push({ startMin: cursor, endMin: m.s });
    cursor = Math.max(cursor, m.e);
  }
  if (cursor < endMin) out.push({ startMin: cursor, endMin });

  return out.filter((b) => b.endMin - b.startMin >= minBlockMin);
}

export async function POST() {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const accessToken = (s as { accessToken?: string }).accessToken;
  if (!accessToken) {
    return NextResponse.json(
      { error: "No calendar access — sign in with Google to enable auto-fill." },
      { status: 400 }
    );
  }

  const now = new Date();
  const from = startOfDay(addDays(now, -LOOKBACK_DAYS));
  const to = startOfDay(addDays(now, 1)); // through end of today

  const calRead = await getExternalBusy({
    userId: s.user.id,
    accessToken,
    from,
    to,
  });
  if (!calRead.ok) {
    return NextResponse.json(
      { error: "Couldn't read your calendar — try again later." },
      { status: 502 }
    );
  }
  // FreeBusy on primary already excludes Verdant-owned events (they live on
  // the secondary calendar), so the auto-fill reflects what the user *did
  // with their time* without any extra filtering.
  const externalBusy = calRead.intervals;

  const startMin = REASONABLE_START_HOUR * 60;
  const endMin = REASONABLE_END_HOUR * 60;
  const tw: TimeWindows = {};

  // One sample per weekday. dayKey uses Date.getDay() semantics (Sun=0..Sat=6)
  // to match the rest of the codebase.
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const day = addDays(from, i);
    const dayKey = String(day.getDay());
    const busyOnDay = externalBusy.filter((b) => {
      // Keep events that touch this calendar day at all.
      const dayStart = startOfDay(day);
      const dayEnd = addDays(dayStart, 1);
      return b.end > dayStart && b.start < dayEnd;
    });
    const blocks = freeBlocksOnDay(
      day,
      busyOnDay,
      startMin,
      endMin,
      MIN_BLOCK_MIN
    );
    const windows: TimeWindow[] = blocks.map((b) => ({
      start: minutesToHHmm(b.startMin),
      end: minutesToHHmm(b.endMin),
    }));
    tw[dayKey] = windows;
  }

  return NextResponse.json({ timeWindows: tw });
}

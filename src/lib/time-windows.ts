import type { ScheduledSession, TimeWindows } from "@/types/plan";
import type { BusyInterval } from "@/lib/calendar-read";
import { freeIntervalsForDay, type FreeInterval } from "@/lib/free-intervals";
import { addDaysInTz, startOfDayInTz, ymdInTz } from "@/lib/tz";

/** Pick next start time in preferred windows, advancing day by day */
export function firstSlotFrom(
  from: Date,
  durationMinutes: number,
  timeWindows: TimeWindows,
  maxEndDate: Date,
  busy: BusyInterval[],
  tz: string
): Date | null {
  const sod = startOfDayInTz(from, tz);
  for (let d = 0; d < 400; d++) {
    const day = addDaysInTz(sod, d, tz);
    if (day > maxEndDate) return null;
    const frags = freeIntervalsForDay(day, timeWindows, busy, tz);
    for (const f of frags) {
      const fStart = f.start;
      const fEnd = f.end;
      const fSpanMin = (fEnd.getTime() - fStart.getTime()) / 60000;
      if (fSpanMin < durationMinutes) continue;

      if (d === 0 && from > fStart) {
        const at = new Date(from);
        if (
          at >= fStart &&
          at.getTime() + durationMinutes * 60_000 <= fEnd.getTime()
        ) {
          return at;
        }
        continue;
      }
      if (d > 0 || from <= fStart) {
        return fStart;
      }
    }
  }
  return null;
}

function largestFragmentMinutes(frags: FreeInterval[]): number {
  let best = 0;
  for (const f of frags) {
    const m = (f.end.getTime() - f.start.getTime()) / 60000;
    if (m > best) best = m;
  }
  return best;
}

function maxMinutesThatFitInWindow(
  day: Date,
  timeWindows: TimeWindows,
  maxMinutesPerDay: number,
  busy: BusyInterval[],
  tz: string
): number {
  const frags = freeIntervalsForDay(day, timeWindows, busy, tz);
  if (frags.length === 0) return 0;
  return Math.max(0, Math.min(maxMinutesPerDay, largestFragmentMinutes(frags)));
}

function advanceToLearnableDay(
  from: Date,
  timeWindows: TimeWindows,
  deadline: Date,
  busy: BusyInterval[],
  tz: string
): Date | null {
  let cur = startOfDayInTz(from, tz);
  const end = startOfDayInTz(deadline, tz);
  for (let i = 0; i < 400; i++) {
    if (cur > end) return null;
    if (maxMinutesThatFitInWindow(cur, timeWindows, 24 * 60, busy, tz) > 0) return cur;
    cur = addDaysInTz(cur, 1, tz);
  }
  return null;
}

/**
 * Start of the daily learning block — finds the first free fragment on `day`
 * (after `notBefore`) that can fit `durationMinutes` contiguously.
 */
function sessionStartOnDay(
  day: Date,
  notBefore: Date,
  durationMinutes: number,
  timeWindows: TimeWindows,
  deadline: Date,
  busy: BusyInterval[],
  tz: string
): Date | null {
  const sod = startOfDayInTz(day, tz);
  if (sod > startOfDayInTz(deadline, tz)) return null;
  const frags = freeIntervalsForDay(sod, timeWindows, busy, tz);
  if (frags.length === 0) return null;

  for (const f of frags) {
    let cursor = f.start;
    if (notBefore > cursor) cursor = new Date(notBefore);
    if (cursor < f.start) cursor = f.start;
    if (cursor.getTime() + durationMinutes * 60_000 > f.end.getTime()) continue;
    if (cursor.getTime() + durationMinutes * 60_000 > deadline.getTime()) continue;
    return cursor;
  }
  return null;
}

function titleForDailyBlock(
  items: { title: string; type: ScheduledSession["type"] }[]
): string {
  if (items.length === 1) return items[0].title;
  return `Learning session: ${items.map((x) => x.title).join(" · ")}`;
}

/**
 * One meeting per calendar day. Tasks scheduled on the same day are merged into
 * one block whose title lists everything to accomplish in that session.
 */
export function buildScheduleFromPlan(
  tasks: { id: string; title: string; type: ScheduledSession["type"]; minutes: number }[],
  startDate: Date,
  deadline: Date,
  timeWindows: TimeWindows,
  maxMinutesPerDay: number,
  busy: BusyInterval[],
  tz: string
): ScheduledSession[] {
  const order: Record<ScheduledSession["type"], number> = {
    lesson: 0,
    review: 1,
    milestone: 2,
  };
  const sorted = [...tasks].sort(
    (a, b) => order[a.type] - order[b.type] || a.id.localeCompare(b.id)
  );

  type T = (typeof sorted)[number];
  let cursorDay =
    advanceToLearnableDay(startOfDayInTz(startDate, tz), timeWindows, deadline, busy, tz) ??
    startOfDayInTz(startDate, tz);
  let bucket: T[] = [];
  let bucketMins = 0;
  const dayBuckets: Array<{ day: Date; items: T[]; minutes: number }> = [];

  function flush() {
    if (bucket.length === 0) return;
    dayBuckets.push({
      day: new Date(cursorDay),
      items: [...bucket],
      minutes: bucketMins,
    });
    bucket = [];
    bucketMins = 0;
  }

  for (const t of sorted) {
    let dur = Math.max(15, Math.min(t.minutes, maxMinutesPerDay));
    let guard = 0;
    while (guard < 500) {
      guard++;
      const dayCap = maxMinutesThatFitInWindow(cursorDay, timeWindows, maxMinutesPerDay, busy, tz);
      if (dayCap === 0) {
        flush();
        const next = advanceToLearnableDay(addDaysInTz(cursorDay, 1, tz), timeWindows, deadline, busy, tz);
        if (!next) break;
        cursorDay = next;
        continue;
      }
      if (dur > dayCap) {
        if (guard > 120) {
          dur = dayCap;
        } else {
          const next = advanceToLearnableDay(addDaysInTz(cursorDay, 1, tz), timeWindows, deadline, busy, tz);
          if (!next) break;
          cursorDay = next;
          continue;
        }
      }
      if (bucket.length > 0 && bucketMins + dur > dayCap) {
        flush();
        const next = advanceToLearnableDay(addDaysInTz(cursorDay, 1, tz), timeWindows, deadline, busy, tz);
        if (!next) break;
        cursorDay = next;
        continue;
      }
      bucket.push(t);
      bucketMins += dur;
      break;
    }
  }
  flush();

  const out: ScheduledSession[] = [];
  for (const b of dayBuckets) {
    const sod = startOfDayInTz(b.day, tz);
    const dayKey = ymdInTz(sod, tz);
    const notBefore =
      sod.getTime() === startOfDayInTz(startDate, tz).getTime() ? startDate : sod;
    const start = sessionStartOnDay(
      sod,
      notBefore,
      b.minutes,
      timeWindows,
      deadline,
      busy,
      tz
    );
    if (!start) continue;

    const agenda = b.items.map((x) => ({
      planTaskId: x.id,
      title: x.title,
      type: x.type,
      minutes: Math.max(15, Math.min(x.minutes, maxMinutesPerDay)),
    }));
    const first = agenda[0];
    out.push({
      id: `sess-day-${dayKey}`,
      planTaskId: first.planTaskId,
      agenda: agenda.length > 1 ? agenda : undefined,
      start: start.toISOString(),
      end: new Date(start.getTime() + b.minutes * 60 * 1000).toISOString(),
      title: titleForDailyBlock(b.items),
      type: first.type,
    });
  }

  if (out.length === 0 && sorted.length > 0) {
    const t = sorted[0];
    const dur = Math.max(15, Math.min(t.minutes, maxMinutesPerDay));
    const fallback = firstSlotFrom(startDate, dur, timeWindows, deadline, busy, tz);
    if (fallback) {
      out.push({
        id: `sess-${t.id}`,
        planTaskId: t.id,
        start: fallback.toISOString(),
        end: new Date(fallback.getTime() + dur * 60 * 1000).toISOString(),
        title: t.title,
        type: t.type,
      });
    }
  }

  return out.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

/**
 * Rebalance: keep completed/past as-is, rebuild all future session times from
 * the same task set using current constraints and deadline.
 */
export function rescheduleUncompleted(
  sessions: ScheduledSession[],
  fromDate: Date,
  deadline: Date,
  timeWindows: TimeWindows,
  maxPerDay: number,
  busy: BusyInterval[],
  tz: string
): ScheduledSession[] {
  const past = sessions.filter((s) => new Date(s.end) < fromDate);
  const future = sessions.filter((s) => new Date(s.start) >= fromDate);
  if (future.length === 0) {
    return past.sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
  }
  const lockedFuture = future.filter((s) => s.locked);
  const unlockedFuture = future.filter((s) => !s.locked);

  const lockedAsBusy: BusyInterval[] = lockedFuture.map((s) => ({
    start: new Date(s.start),
    end: new Date(s.end),
  }));

  const tasks = unlockedFuture.flatMap((s) => {
    if (s.agenda && s.agenda.length > 0) {
      return s.agenda.map((a) => ({
        id: a.planTaskId,
        title: a.title,
        type: a.type,
        minutes: Math.max(15, a.minutes),
      }));
    }
    return [
      {
        id: s.planTaskId,
        title: s.title,
        type: s.type,
        minutes: Math.max(
          15,
          Math.floor(
            (new Date(s.end).getTime() - new Date(s.start).getTime()) / 60000
          )
        ),
      },
    ];
  });

  if (tasks.length === 0) {
    return [...past, ...lockedFuture].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
  }

  const newSched = buildScheduleFromPlan(
    tasks,
    fromDate,
    deadline,
    timeWindows,
    maxPerDay,
    [...busy, ...lockedAsBusy],
    tz
  );
  return [...past, ...lockedFuture, ...newSched].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );
}

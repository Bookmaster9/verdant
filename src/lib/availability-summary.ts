/**
 * Availability summary for the planner LLM (design Q3).
 *
 * Produces a small struct the planner can reason over without seeing every
 * raw event. We deliberately do NOT pass calendar event titles to the LLM
 * — only deterministic descriptors derived from busy-block patterns.
 */
import { addDays, getDay, startOfDay } from "date-fns";
import type { TimeWindows } from "@/types/plan";
import type { BusyInterval } from "@/lib/calendar-read";
import { freeIntervalsForDay } from "@/lib/free-intervals";

export interface PerWeekAvailability {
  weekIndex: number;
  minutes: number;
  /** Deterministic prose hint, e.g. "blocked Mon/Tue evenings". `null` when unremarkable. */
  note: string | null;
}

export interface AvailabilitySummary {
  typicalWeeklyMinutes: number;
  perWeek: PerWeekAvailability[];
  /** Distribution of past effectiveness across coarse time buckets. Sums to 1 (or 0 if no history). */
  preferredTimeOfDayHistogram: {
    morning: number;
    afternoon: number;
    evening: number;
  };
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function freeMinutesOnDay(
  day: Date,
  timeWindows: TimeWindows,
  busy: BusyInterval[]
): number {
  const frags = freeIntervalsForDay(day, timeWindows, busy);
  let m = 0;
  for (const f of frags) m += (f.end.getTime() - f.start.getTime()) / 60000;
  return m;
}

function noteForWeek(
  weekStart: Date,
  timeWindows: TimeWindows,
  busy: BusyInterval[]
): string | null {
  const blockedDows: number[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const dow = getDay(day);
    const wd = String(dow);
    const list = timeWindows[wd] ?? timeWindows[wd === "0" ? "7" : wd];
    if (!list || list.length === 0) continue;
    const free = freeMinutesOnDay(day, timeWindows, busy);
    let total = 0;
    for (const w of list) {
      const sm =
        parseInt(w.start.split(":")[0], 10) * 60 +
        parseInt(w.start.split(":")[1], 10);
      const em =
        parseInt(w.end.split(":")[0], 10) * 60 +
        parseInt(w.end.split(":")[1], 10);
      total += Math.max(0, em - sm);
    }
    if (total > 0 && free / total < 0.25) blockedDows.push(dow);
  }
  if (blockedDows.length === 0) return null;
  const labels = blockedDows.map((d) => DOW_LABELS[d]).join("/");
  return `mostly blocked ${labels}`;
}

/**
 * Convert per-slot effectiveness ratings (key "<dow>-<HH>") into a coarse
 * morning/afternoon/evening histogram, normalized to sum to 1.
 */
function effectivenessHistogram(
  slotEffectiveness: Record<string, number>
): { morning: number; afternoon: number; evening: number } {
  let morning = 0;
  let afternoon = 0;
  let evening = 0;
  for (const [key, val] of Object.entries(slotEffectiveness)) {
    const hr = parseInt(key.split("-")[1] ?? "0", 10);
    if (Number.isNaN(hr)) continue;
    const w = Math.max(0, val);
    if (hr < 12) morning += w;
    else if (hr < 17) afternoon += w;
    else evening += w;
  }
  const total = morning + afternoon + evening;
  if (total === 0) return { morning: 0, afternoon: 0, evening: 0 };
  return {
    morning: Math.round((morning / total) * 100) / 100,
    afternoon: Math.round((afternoon / total) * 100) / 100,
    evening: Math.round((evening / total) * 100) / 100,
  };
}

export function summarizeAvailability(args: {
  startDate: Date;
  weeks: number;
  timeWindows: TimeWindows;
  busy: BusyInterval[];
  slotEffectiveness: Record<string, number>;
}): AvailabilitySummary {
  const { startDate, weeks, timeWindows, busy, slotEffectiveness } = args;
  const sod = startOfDay(startDate);

  const perWeek: PerWeekAvailability[] = [];
  let totalMinutes = 0;
  for (let w = 0; w < weeks; w++) {
    const weekStart = addDays(sod, w * 7);
    let minutes = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      minutes += freeMinutesOnDay(day, timeWindows, busy);
    }
    const note = noteForWeek(weekStart, timeWindows, busy);
    perWeek.push({ weekIndex: w, minutes: Math.round(minutes), note });
    totalMinutes += minutes;
  }

  const typical = weeks > 0 ? Math.round(totalMinutes / weeks) : 0;

  return {
    typicalWeeklyMinutes: typical,
    perWeek,
    preferredTimeOfDayHistogram: effectivenessHistogram(slotEffectiveness),
  };
}

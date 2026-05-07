/**
 * User-declared blackout date ranges (design Q4, γ-fallback).
 *
 * Blackouts are a per-plan list of date ranges the user marks as off-limits
 * for study (vacations, exams, family events). They compose with the calendar
 * busy set as additional `BusyInterval` entries during scheduling.
 *
 * Shape persisted in `LearningPlan.manualBlackouts`:
 *   [{ from: "YYYY-MM-DD", to: "YYYY-MM-DD", reason?: "..." }]
 *
 * Inclusive on both ends. A single-day blackout uses `from === to`.
 */
import { addDays, parseISO, startOfDay } from "date-fns";
import type { BusyInterval } from "@/lib/calendar-read";

export interface ManualBlackout {
  from: string;
  to: string;
  reason?: string;
}

export function parseBlackouts(json: string): ManualBlackout[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is ManualBlackout =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as ManualBlackout).from === "string" &&
        typeof (x as ManualBlackout).to === "string"
    );
  } catch {
    return [];
  }
}

export function blackoutsToBusy(blackouts: ManualBlackout[]): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const b of blackouts) {
    const from = startOfDay(parseISO(b.from));
    const to = addDays(startOfDay(parseISO(b.to)), 1);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) continue;
    if (to <= from) continue;
    out.push({ start: from, end: to });
  }
  return out;
}

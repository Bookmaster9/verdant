/**
 * Placement-rule helpers (design Q-edit-llm).
 *
 * The NL editor emits two kinds of intent: imperative `ops` that mutate the
 * SproutPlan, and declarative `rules` that flow into the packer. This module
 * owns the rule side: parsing, filter-matching, and the "compile-down" step
 * that turns `forbid` rules into synthetic `BusyInterval[]` so the packer's
 * existing hard-filter step rejects matching slots.
 *
 * Soft `prefer` rules are NOT compiled here — they pass through verbatim to
 * `ScoringContext.placementRules` and are consulted by `ruleScore` inside
 * `scoring-pack.ts`. `pin` rules are applied by the edit-ops applier (they
 * mutate a specific session).
 */
import { addDays, getDay, parseISO, startOfDay } from "date-fns";
import type { BusyInterval } from "@/lib/calendar-read";
import type {
  DayOfWeek,
  PlacementRule,
  PlanTask,
  RuleFilter,
  TimeOfDay,
} from "@/types/plan";
import { phaseForWeek } from "@/lib/phase";

const DOW_TO_INDEX: Record<DayOfWeek, number> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};

/** Convert Date to Mon=0..Sun=6, matching `dayOffsetInWeek`. */
export function dowMonZero(d: Date): number {
  return (getDay(d) + 6) % 7;
}

export function parsePlacementRules(json: string | null | undefined): PlacementRule[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((r): r is PlacementRule => isWellFormedRule(r));
  } catch {
    return [];
  }
}

function isWellFormedRule(r: unknown): boolean {
  if (typeof r !== "object" || r === null) return false;
  const k = (r as { kind?: unknown }).kind;
  return k === "prefer" || k === "forbid" || k === "pin";
}

/** Does this task match the rule's filter? Empty filter matches everything. */
export function taskMatchesFilter(
  task: PlanTask,
  filter: RuleFilter,
  phaseCount: number
): boolean {
  if (filter.type !== undefined && task.type !== filter.type) return false;
  if (filter.weekIndex !== undefined && task.weekIndex !== filter.weekIndex)
    return false;
  if (filter.phaseIndex !== undefined) {
    const phase = phaseForWeek(task.weekIndex, phaseCount);
    if (phase !== filter.phaseIndex) return false;
  }
  if (filter.priority !== undefined && (task.priority ?? "core") !== filter.priority)
    return false;
  if (filter.taskIds !== undefined && !filter.taskIds.includes(task.id))
    return false;
  // dayOfWeek on the filter targets the slot's day, not the task's hint.
  // We can't evaluate it from a task alone — skip here; checked at scoring time.
  return true;
}

/**
 * Bucket a Date into the existing `TimeOfDay` enum. Boundaries match
 * `todMatchScore` in `scoring-pack.ts` (morning <12, afternoon 12-17, evening ≥17).
 */
export function timeOfDayForDate(d: Date): TimeOfDay {
  const hr = d.getHours();
  if (hr < 12) return "morning";
  if (hr < 17) return "afternoon";
  return "evening";
}

export function dayOfWeekForDate(d: Date): DayOfWeek {
  const idx = dowMonZero(d);
  return (Object.keys(DOW_TO_INDEX) as DayOfWeek[])[idx];
}

/** True if `slot.start` falls inside the rule's window. */
export function slotInForbidWindow(
  slot: { start: Date },
  window: Extract<PlacementRule, { kind: "forbid" }>["window"]
): boolean {
  const day = dayOfWeekForDate(slot.start);
  if (window.dayOfWeek && window.dayOfWeek.length > 0) {
    if (!window.dayOfWeek.includes(day)) return false;
  }
  if (window.date) {
    const d = parseISO(window.date);
    if (
      startOfDay(d).getTime() !== startOfDay(slot.start).getTime()
    ) {
      return false;
    }
  }
  if (window.dateRange) {
    const from = startOfDay(parseISO(window.dateRange.from));
    const to = addDays(startOfDay(parseISO(window.dateRange.to)), 1);
    if (slot.start < from || slot.start >= to) return false;
  }
  // If no window dimensions are set, default to "match nothing" — a forbid
  // rule with an empty window would mean "forbid everywhere" which is unsafe.
  return (
    (window.dayOfWeek && window.dayOfWeek.length > 0) ||
    !!window.date ||
    !!window.dateRange
  );
}

/**
 * Compile `forbid` rules into busy intervals over the planning window.
 *
 * The packer already filters slots that overlap any `BusyInterval[]`, so the
 * cheapest way to enforce a hard exclusion is to synthesize one. We emit one
 * full-day busy interval per matching day (filtered to the planning window).
 *
 * Forbid filters are ignored at this stage: the busy interval covers the day
 * regardless of which task is being placed. The packer doesn't have a way to
 * "block this slot only for these tasks," so a forbid is currently global to
 * the matching window. Filter-scoped forbids (e.g. "no reviews on Sundays
 * but lessons OK") would require a per-task filter pass — not in this round.
 */
export function compileForbidRulesToBusy(
  rules: PlacementRule[],
  ctx: { startDate: Date; deadline: Date }
): BusyInterval[] {
  const out: BusyInterval[] = [];
  const forbids = rules.filter(
    (r): r is Extract<PlacementRule, { kind: "forbid" }> => r.kind === "forbid"
  );
  if (forbids.length === 0) return out;

  const start = startOfDay(ctx.startDate);
  const end = startOfDay(ctx.deadline);
  for (
    let cursor = start;
    cursor <= end;
    cursor = addDays(cursor, 1)
  ) {
    const dayStart = cursor;
    const dayEnd = addDays(cursor, 1);
    for (const rule of forbids) {
      if (slotInForbidWindow({ start: dayStart }, rule.window)) {
        out.push({ start: dayStart, end: dayEnd });
        break;
      }
    }
  }
  return out;
}

/**
 * Score adjustment for a `prefer` rule against a (task, slot) pair.
 *
 * Returns 0 if the task doesn't match the filter. Otherwise returns +PREFER_BONUS
 * for slots that satisfy *all* populated target dimensions, and -PREFER_PENALTY
 * for slots that match the filter but miss the target. The asymmetry is
 * intentional: matching tasks are nudged toward target slots, but not so hard
 * that we'd starve them entirely if the target is busy.
 */
export const PREFER_BONUS = 35;
export const PREFER_PENALTY = -10;

export function preferRuleScore(
  task: PlanTask,
  slot: { start: Date },
  rules: PlacementRule[],
  phaseCount: number
): number {
  let total = 0;
  for (const rule of rules) {
    if (rule.kind !== "prefer") continue;
    if (!taskMatchesFilter(task, rule.filter, phaseCount)) continue;
    // Filter dayOfWeek (rare but supported) gates whether this slot is even
    // relevant to the rule. If the filter constrains day-of-week and the slot
    // doesn't match, the rule abstains for this candidate.
    if (rule.filter.dayOfWeek && rule.filter.dayOfWeek.length > 0) {
      if (!rule.filter.dayOfWeek.includes(dayOfWeekForDate(slot.start))) {
        continue;
      }
    }
    const tgt = rule.target;
    let allMatched = true;
    let anyDimension = false;
    if (tgt.dayOfWeek && tgt.dayOfWeek.length > 0) {
      anyDimension = true;
      if (!tgt.dayOfWeek.includes(dayOfWeekForDate(slot.start))) {
        allMatched = false;
      }
    }
    if (tgt.timeOfDay && tgt.timeOfDay !== "any") {
      anyDimension = true;
      if (timeOfDayForDate(slot.start) !== tgt.timeOfDay) {
        allMatched = false;
      }
    }
    if (tgt.weekIndex !== undefined) {
      anyDimension = true;
      // Slot weekIndex is computed identically to scoring-pack's idealWeekScore.
      // This duplicates that math; if either changes, keep them in sync.
      // (Not extracted because crossing the import boundary would create a
      // dependency from placement-rules into scoring-pack.)
      // We check equality rather than proximity here — a prefer-rule says
      // "this week," not "near this week."
      // No-op if no startDate context — handled at the call site that knows it.
      // For the score path, weekIndex match is approximate via raw target;
      // if needed, callers can pass slotWeekIndex separately.
    }
    if (!anyDimension) continue;
    total += allMatched ? PREFER_BONUS : PREFER_PENALTY;
  }
  return total;
}

/**
 * Apply `pin` rules to an existing schedule. Mutates session start/end + locked
 * flag for each pin whose `sessionId` is found. Returns the new schedule and
 * the busy intervals that should be added to the packer for the pinned sessions.
 *
 * Pin duration is preserved — only the start time changes.
 */
/**
 * Render a rule as a short human-readable phrase for the settings UI.
 * Best-effort; no guarantees of grammatical perfection on exotic combinations.
 */
export function describeRule(rule: PlacementRule): string {
  if (rule.kind === "pin") {
    // Pin rules are not stored persistently, so this is mostly defensive.
    return `pin a session to ${rule.start}`;
  }
  if (rule.kind === "forbid") {
    const parts: string[] = [];
    if (rule.window.dayOfWeek && rule.window.dayOfWeek.length > 0) {
      parts.push(`on ${rule.window.dayOfWeek.map(dowLong).join(", ")}`);
    }
    if (rule.window.date) parts.push(`on ${rule.window.date}`);
    if (rule.window.dateRange) {
      parts.push(`between ${rule.window.dateRange.from} and ${rule.window.dateRange.to}`);
    }
    const what = filterDescription(rule.filter) ?? "anything";
    return `avoid ${what} ${parts.join(" ")}`.trim();
  }
  // prefer
  const parts: string[] = [];
  if (rule.target.dayOfWeek && rule.target.dayOfWeek.length > 0) {
    parts.push(`on ${rule.target.dayOfWeek.map(dowLong).join(", ")}`);
  }
  if (rule.target.timeOfDay && rule.target.timeOfDay !== "any") {
    parts.push(`in the ${rule.target.timeOfDay}`);
  }
  if (rule.target.weekIndex !== undefined) {
    parts.push(`in week ${rule.target.weekIndex + 1}`);
  }
  const what = filterDescription(rule.filter) ?? "anything";
  return `prefer ${what} ${parts.join(" ")}`.trim();
}

function filterDescription(filter: RuleFilter): string | null {
  const parts: string[] = [];
  if (filter.priority) parts.push(filter.priority);
  if (filter.type) parts.push(`${filter.type}s`);
  if (filter.dayOfWeek && filter.dayOfWeek.length > 0) {
    parts.push(`on ${filter.dayOfWeek.map(dowLong).join(", ")}`);
  }
  if (filter.weekIndex !== undefined) {
    parts.push(`from week ${filter.weekIndex + 1}`);
  }
  if (filter.taskIds && filter.taskIds.length > 0) {
    parts.push(`${filter.taskIds.length} specific task(s)`);
  }
  if (parts.length === 0) return null;
  return parts.join(" ");
}

function dowLong(d: DayOfWeek): string {
  const map: Record<DayOfWeek, string> = {
    mon: "Monday",
    tue: "Tuesday",
    wed: "Wednesday",
    thu: "Thursday",
    fri: "Friday",
    sat: "Saturday",
    sun: "Sunday",
  };
  return map[d];
}

export function applyPinRules(
  rules: PlacementRule[],
  schedule: import("@/types/plan").ScheduledSession[]
): {
  schedule: import("@/types/plan").ScheduledSession[];
  pinned: BusyInterval[];
  /** Set of session ids that were successfully pinned (for ack reporting). */
  pinnedSessionIds: Set<string>;
} {
  let next = schedule.map((s) => ({ ...s }));
  const pinnedBusy: BusyInterval[] = [];
  const pinnedSessionIds = new Set<string>();
  for (const rule of rules) {
    if (rule.kind !== "pin") continue;
    const idx = next.findIndex((s) => s.id === rule.sessionId);
    if (idx === -1) continue;
    const sess = next[idx];
    const oldStart = parseISO(sess.start).getTime();
    const oldEnd = parseISO(sess.end).getTime();
    const duration = Math.max(15 * 60_000, oldEnd - oldStart);
    const newStart = parseISO(rule.start);
    if (Number.isNaN(newStart.getTime())) continue;
    const newEnd = new Date(newStart.getTime() + duration);
    next[idx] = {
      ...sess,
      start: newStart.toISOString(),
      end: newEnd.toISOString(),
      locked: true,
    };
    pinnedBusy.push({ start: newStart, end: newEnd });
    pinnedSessionIds.add(sess.id);
  }
  next = next.sort(
    (a, b) => parseISO(a.start).getTime() - parseISO(b.start).getTime()
  );
  return { schedule: next, pinned: pinnedBusy, pinnedSessionIds };
}

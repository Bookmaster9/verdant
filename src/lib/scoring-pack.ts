/**
 * Slot-scoring packer.
 *
 * For each task, in dependency-aware order, the packer enumerates feasible
 * slots in the user's free intervals, scores each candidate, then picks one
 * via softmax sampling over the top-K candidates.
 *
 * Hard constraints (filters):
 *   - Slot fits the duration contiguously inside a free interval.
 *   - Slot ends before the deadline.
 *   - Slot does not overlap any busy interval (calendar events, locked sessions, blackouts).
 *   - mustFollowTaskId predecessor placed earlier and `minDaysAfterPredecessor` honored if feasible.
 *   - Daily cap from `maxMinutesPerDay`.
 *
 * Soft scoring (4 buckets):
 *   - Learned hour-of-week utility (`hourUtility` map, duration-weighted).
 *   - Task-structural: time-of-day match, week-index/day-offset proximity,
 *     FSRS dueAt proximity, preferStandalone bonus.
 *   - Fern declarative rules (`prefer` bonuses).
 *   - Calendar mask: hard exclusion via busy-interval filtering.
 *
 * Placement: top-5 candidates by score, softmax sampled with temperature 5.
 * If the top candidate beats #2 by ≥25 points, sampling is skipped (greedy).
 * RNG is seeded by `hash(planId + taskId)` for determinism — same input
 * always yields the same placement.
 *
 * Two-phase ordering: tasks with explicit constraints (Fern prefer/pin rules,
 * FSRS-driven `dueAt`) place before unconstrained tasks within the same
 * topological layer, so explicit user preferences and review schedules win
 * the contention they need.
 */
import type {
  PlacementRule,
  PlanTask,
  ScheduledSession,
  TimeWindows,
} from "@/types/plan";
import type { BusyInterval } from "@/lib/calendar-read";
import { freeIntervalsForDay } from "@/lib/free-intervals";
import {
  preferRuleScore,
  taskMatchesFilter,
} from "@/lib/placement-rules";
import {
  readUtilityForSlot,
  type HourUtilityMap,
} from "@/lib/hour-utility";
import {
  addDaysInTz,
  dowMonZeroInTz,
  hourInTz,
  startOfDayInTz,
  ymdInTz,
} from "@/lib/tz";

export interface ScoringContext {
  startDate: Date;
  deadline: Date;
  timeWindows: TimeWindows;
  busy: BusyInterval[];
  maxMinutesPerDay: number;
  /** Learned hour-utility map (signed accumulator with lazy decay). */
  hourUtility: HourUtilityMap;
  /** "Now" timestamp used for decay-on-read against `hourUtility`. */
  now: Date;
  /**
   * IANA timezone for all wall-clock and day-boundary arithmetic. Without
   * this, day-of-week and time-of-day comparisons silently use the server's
   * local zone (UTC on Vercel) and the user's "07:00 window" lands at 07:00
   * UTC = 03:00 EDT.
   */
  tz: string;
  /**
   * Stable identifier used to seed the per-task RNG. Same `planId` + same task
   * id = same softmax sample, so re-packs with unchanged inputs reproduce.
   */
  planId: string;
  /**
   * Per-day minutes already consumed by entries the packer should *not* place
   * (i.e. existing locked schedule entries treated as busy). Lets the packer
   * respect `maxMinutesPerDay` against the full picture instead of starting
   * each call from zero. Keys are `dayKey()` ISO date strings.
   */
  initialDailyMinutesUsed?: Map<string, number>;
  /**
   * Declarative placement rules consulted by `ruleScore`. Hard `forbid` rules
   * should already be compiled into `busy` by the caller (see
   * `compileForbidRulesToBusy`). Soft `prefer` rules are read from here at
   * scoring time. Pass an empty array (or omit) to skip.
   */
  placementRules?: PlacementRule[];
  /**
   * Total phase count for the plan, used by `phaseIndex` filters in rules. If
   * omitted, phaseIndex filters are skipped (treated as no-op). The packer
   * doesn't otherwise need this.
   */
  phaseCount?: number;
}

export interface PackResult {
  schedule: ScheduledSession[];
  /** Tasks the packer could not place before the deadline. */
  overflow: PlanTask[];
}

interface Candidate {
  start: Date;
  end: Date;
  durationMinutes: number;
}

interface PlacementRecord {
  task: PlanTask;
  start: Date;
  end: Date;
}

const PLAN_DAY_LIMIT = 400;

// --- Sampling parameters (grill-me Q10) -------------------------------------
const SOFTMAX_TOP_K = 5;
const SOFTMAX_TEMPERATURE = 5;
/** If top-1 beats top-2 by this many points, skip softmax and pick top-1. */
const GREEDY_DOMINANCE_THRESHOLD = 25;

function clampDur(task: PlanTask, ctx: ScoringContext): number {
  return Math.max(15, Math.min(task.minutes, ctx.maxMinutesPerDay));
}

function dayKey(d: Date, tz: string): string {
  return ymdInTz(d, tz);
}

// -----------------------------------------------------------------------------
// Two-phase classification
// -----------------------------------------------------------------------------

/**
 * Phase 1 = tasks with explicit constraints (active Fern `prefer`/`pin` rules
 * targeting them, or an FSRS `dueAt`). Phase 2 = everything else. Phase 1 sorts
 * before Phase 2 within the same topological layer so they claim the slots
 * they care about before unconstrained tasks burn the inventory.
 */
function isPhaseOne(
  task: PlanTask,
  rules: PlacementRule[] | undefined,
  phaseCount: number
): boolean {
  if (task.dueAt) return true;
  if (!rules || rules.length === 0) return false;
  for (const rule of rules) {
    if (rule.kind === "prefer") {
      if (taskMatchesFilter(task, rule.filter, phaseCount)) return true;
    } else if (rule.kind === "pin") {
      // pin rules target a session id, not a task id directly. Treat any
      // pin rule as constraint-bearing for the related task — the packer
      // doesn't actually consume pin rules (the edit-ops applier does), but
      // tasks under active edit deserve phase-1 priority anyway.
      return true;
    }
  }
  return false;
}

/**
 * Topological sort: every task whose predecessor is in the set must come
 * after. Within a layer, phase-1 (explicitly-constrained) tasks sort first,
 * then by priority (core before stretch), weekIndex, dayOffsetInWeek.
 */
function topologicalOrder(
  tasks: PlanTask[],
  rules: PlacementRule[] | undefined,
  phaseCount: number
): PlanTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const remaining = new Set(tasks.map((t) => t.id));
  const out: PlanTask[] = [];

  while (remaining.size > 0) {
    const ready: PlanTask[] = [];
    for (const id of remaining) {
      const task = byId.get(id);
      if (!task) continue;
      const dep = task.mustFollowTaskId;
      if (!dep || !remaining.has(dep) || !byId.has(dep)) {
        ready.push(task);
      }
    }
    if (ready.length === 0) {
      // Cycle or dangling reference — break by adding everything remaining.
      for (const id of remaining) {
        const t = byId.get(id);
        if (t) out.push(t);
      }
      break;
    }
    ready.sort((a, b) => {
      const phA = isPhaseOne(a, rules, phaseCount) ? 0 : 1;
      const phB = isPhaseOne(b, rules, phaseCount) ? 0 : 1;
      if (phA !== phB) return phA - phB;
      const pa = a.priority ?? "core";
      const pb = b.priority ?? "core";
      if (pa !== pb) return pa === "core" ? -1 : 1;
      if (a.weekIndex !== b.weekIndex) return a.weekIndex - b.weekIndex;
      if (a.dayOffsetInWeek !== b.dayOffsetInWeek)
        return a.dayOffsetInWeek - b.dayOffsetInWeek;
      return a.id.localeCompare(b.id);
    });
    for (const t of ready) {
      out.push(t);
      remaining.delete(t.id);
    }
  }
  return out;
}

function enumerateCandidates(
  task: PlanTask,
  ctx: ScoringContext,
  earliestStart: Date,
  busy: BusyInterval[],
  dailyMinutesUsed: Map<string, number>
): Candidate[] {
  const dur = clampDur(task, ctx);
  const candidates: Candidate[] = [];
  let cursor = startOfDayInTz(earliestStart, ctx.tz);
  const end = startOfDayInTz(ctx.deadline, ctx.tz);
  for (let d = 0; d < PLAN_DAY_LIMIT; d++) {
    if (cursor > end) break;
    const usedToday = dailyMinutesUsed.get(dayKey(cursor, ctx.tz)) ?? 0;
    if (usedToday + dur <= ctx.maxMinutesPerDay) {
      const frags = freeIntervalsForDay(cursor, ctx.timeWindows, busy, ctx.tz);
      for (const frag of frags) {
        let slotStart = frag.start;
        if (slotStart < earliestStart) slotStart = earliestStart;
        if (slotStart < frag.start) slotStart = frag.start;
        const slotEnd = new Date(slotStart.getTime() + dur * 60_000);
        if (slotEnd > frag.end) continue;
        if (slotEnd > ctx.deadline) continue;
        candidates.push({
          start: slotStart,
          end: slotEnd,
          durationMinutes: dur,
        });
      }
    }
    cursor = addDaysInTz(cursor, 1, ctx.tz);
  }
  return candidates;
}

// -----------------------------------------------------------------------------
// Scoring (four buckets)
// -----------------------------------------------------------------------------

/**
 * Time-of-day match for the task's `preferredTimeOfDay` hint. Reduced from
 * the legacy weights (was ±8 / −2) because learned hour-utility now carries
 * the same kind of preference signal more directly.
 */
function todMatchScore(task: PlanTask, slot: Candidate, tz: string): number {
  const tod = task.preferredTimeOfDay ?? "any";
  if (tod === "any") return 0;
  const hr = hourInTz(slot.start, tz);
  const isMorning = hr < 12;
  const isAfternoon = hr >= 12 && hr < 17;
  const isEvening = hr >= 17;
  if (
    (tod === "morning" && isMorning) ||
    (tod === "afternoon" && isAfternoon) ||
    (tod === "evening" && isEvening)
  ) {
    return 4;
  }
  return -1;
}

function idealWeekScore(task: PlanTask, slot: Candidate, ctx: ScoringContext): number {
  const slotWeek = Math.floor(
    (startOfDayInTz(slot.start, ctx.tz).getTime() -
      startOfDayInTz(ctx.startDate, ctx.tz).getTime()) /
      (7 * 86_400_000)
  );
  const delta = Math.abs(slotWeek - task.weekIndex);
  return Math.max(0, 10 - delta * 5);
}

function idealDayScore(task: PlanTask, slot: Candidate, tz: string): number {
  const slotDow = dowMonZeroInTz(slot.start, tz);
  const delta = Math.abs(slotDow - task.dayOffsetInWeek);
  return Math.max(0, 6 - delta * 2);
}

/**
 * Heavily-weighted soft preference for review tasks: prefer slots near
 * the FSRS-recommended `dueAt`. Linear decay around the due date — same day
 * is worth +30, one day off +23, a week off -19. Returns 0 for tasks
 * without a `dueAt` so non-review tasks are unaffected.
 */
function dueAtProximityScore(task: PlanTask, slot: Candidate): number {
  if (!task.dueAt) return 0;
  const due = new Date(task.dueAt).getTime();
  if (Number.isNaN(due)) return 0;
  const deltaDays = Math.abs(slot.start.getTime() - due) / 86_400_000;
  return Math.max(-30, 30 - deltaDays * 7);
}

function standaloneScore(
  task: PlanTask,
  slot: Candidate,
  dailyMinutesUsed: Map<string, number>,
  tz: string
): number {
  if (!task.preferStandalone) return 0;
  const used = dailyMinutesUsed.get(dayKey(slot.start, tz)) ?? 0;
  return used === 0 ? 4 : -6;
}

/** Bucket: learned hour-of-week utility, duration-weighted across cells. */
function learnedUtilityScore(slot: Candidate, ctx: ScoringContext): number {
  return readUtilityForSlot(
    ctx.hourUtility,
    slot.start,
    slot.durationMinutes,
    ctx.now
  );
}

/** Bucket: task-structural (the four hint-driven scores combined). */
function taskStructuralScore(
  task: PlanTask,
  slot: Candidate,
  ctx: ScoringContext,
  dailyMinutesUsed: Map<string, number>
): number {
  return (
    todMatchScore(task, slot, ctx.tz) +
    idealWeekScore(task, slot, ctx) +
    idealDayScore(task, slot, ctx.tz) +
    standaloneScore(task, slot, dailyMinutesUsed, ctx.tz) +
    dueAtProximityScore(task, slot)
  );
}

/** Bucket: Fern declarative rules. */
function fernRuleScore(
  task: PlanTask,
  slot: Candidate,
  ctx: ScoringContext
): number {
  if (!ctx.placementRules || ctx.placementRules.length === 0) return 0;
  return preferRuleScore(task, slot, ctx.placementRules, ctx.phaseCount ?? 1);
}

function scoreCandidate(
  task: PlanTask,
  slot: Candidate,
  ctx: ScoringContext,
  dailyMinutesUsed: Map<string, number>
): number {
  return (
    learnedUtilityScore(slot, ctx) +
    taskStructuralScore(task, slot, ctx, dailyMinutesUsed) +
    fernRuleScore(task, slot, ctx)
  );
}

// -----------------------------------------------------------------------------
// Stochastic placement (top-K softmax sampling)
// -----------------------------------------------------------------------------

/** FNV-1a 32-bit hash → seed for mulberry32. Deterministic and cheap. */
function hashSeed(s: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Pick a candidate from `candidates` given parallel `scores`. Returns the
 * index. Top-K filtering, greedy escape on dominance, and softmax with
 * temperature `T` for the rest.
 */
function pickCandidate(
  scores: number[],
  rand: () => number
): number {
  if (scores.length === 0) return -1;
  if (scores.length === 1) return 0;

  // Sort indices by score desc and clip to top-K.
  const indexed = scores.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => b.s - a.s);
  const topK = indexed.slice(0, SOFTMAX_TOP_K);

  // Greedy escape: top-1 dominates top-2 by enough that exploration is harmful.
  if (
    topK.length >= 2 &&
    topK[0].s - topK[1].s >= GREEDY_DOMINANCE_THRESHOLD
  ) {
    return topK[0].i;
  }
  if (topK.length === 1) return topK[0].i;

  // Numerically-stable softmax: subtract the max before exponentiation.
  const maxS = topK[0].s;
  const exps = topK.map((c) => Math.exp((c.s - maxS) / SOFTMAX_TEMPERATURE));
  const sum = exps.reduce((a, b) => a + b, 0);
  const r = rand() * sum;
  let acc = 0;
  for (let i = 0; i < exps.length; i++) {
    acc += exps[i];
    if (r <= acc) return topK[i].i;
  }
  return topK[topK.length - 1].i;
}

// -----------------------------------------------------------------------------
// Schedule emission
// -----------------------------------------------------------------------------

function mergeIntoDailyAgendas(
  placements: PlacementRecord[],
  tz: string
): ScheduledSession[] {
  const byDay = new Map<string, PlacementRecord[]>();
  for (const p of placements) {
    const k = dayKey(p.start, tz);
    const list = byDay.get(k);
    if (list) list.push(p);
    else byDay.set(k, [p]);
  }

  const out: ScheduledSession[] = [];
  for (const [, list] of byDay) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime());
    const standalones = list.filter((p) => p.task.preferStandalone);
    const groupable = list.filter((p) => !p.task.preferStandalone);

    for (const s of standalones) {
      out.push({
        id: `sess-${s.task.id}`,
        planTaskId: s.task.id,
        title: s.task.title,
        type: s.task.type,
        start: s.start.toISOString(),
        end: s.end.toISOString(),
      });
    }

    // Split groupable placements into clusters of strictly-contiguous tasks
    // (prev.end === next.start). Non-contiguous placements emit separate
    // sessions so a merged block never spans an external event sitting in
    // the gap between placements.
    let clusterStart = 0;
    for (let i = 1; i <= groupable.length; i++) {
      const continues =
        i < groupable.length &&
        groupable[i].start.getTime() === groupable[i - 1].end.getTime();
      if (continues) continue;
      const cluster = groupable.slice(clusterStart, i);
      if (cluster.length === 1) {
        const only = cluster[0];
        out.push({
          id: `sess-${only.task.id}`,
          planTaskId: only.task.id,
          title: only.task.title,
          type: only.task.type,
          start: only.start.toISOString(),
          end: only.end.toISOString(),
        });
      } else {
        const first = cluster[0];
        const last = cluster[cluster.length - 1];
        out.push({
          id: `sess-${first.task.id}`,
          planTaskId: first.task.id,
          title: `Learning session: ${cluster.map((g) => g.task.title).join(" · ")}`,
          type: first.task.type,
          start: first.start.toISOString(),
          end: last.end.toISOString(),
          agenda: cluster.map((g) => ({
            planTaskId: g.task.id,
            title: g.task.title,
            type: g.task.type,
            minutes: Math.max(
              15,
              Math.round((g.end.getTime() - g.start.getTime()) / 60_000)
            ),
          })),
        });
      }
      clusterStart = i;
    }
  }
  return out.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );
}

/**
 * Defensive dedup: keep the FIRST occurrence of each session id, drop subsequent
 * ones. Used when concatenating `[past, lockedFuture, ...newlyPacked]`.
 */
export function dedupeScheduleById(
  sessions: ScheduledSession[]
): ScheduledSession[] {
  const seen = new Set<string>();
  const out: ScheduledSession[] = [];
  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export function packIntoExistingSchedule(args: {
  newTasks: PlanTask[];
  existingSchedule: ScheduledSession[];
  startDate: Date;
  deadline: Date;
  timeWindows: TimeWindows;
  externalBusy: BusyInterval[];
  maxMinutesPerDay: number;
  hourUtility: HourUtilityMap;
  now: Date;
  planId: string;
  /** IANA timezone — see ScoringContext.tz. */
  tz: string;
  /**
   * Optional pre-existing per-day minutes from sources outside `existingSchedule`
   * — typically OTHER active plans' schedules (multi-sprout shared-cap support).
   */
  extraDailyMinutesUsed?: Map<string, number>;
  placementRules?: PlacementRule[];
  phaseCount?: number;
}): { schedule: ScheduledSession[]; overflow: PlanTask[] } {
  const existingAsBusy: BusyInterval[] = args.existingSchedule.map((sess) => ({
    start: new Date(sess.start),
    end: new Date(sess.end),
  }));

  const initialDailyMinutesUsed = new Map<string, number>(
    args.extraDailyMinutesUsed ?? []
  );
  for (const sess of args.existingSchedule) {
    const start = new Date(sess.start);
    const end = new Date(sess.end);
    const minutes = Math.max(0, (end.getTime() - start.getTime()) / 60_000);
    const k = dayKey(start, args.tz);
    initialDailyMinutesUsed.set(k, (initialDailyMinutesUsed.get(k) ?? 0) + minutes);
  }

  const result = packWithScoring(args.newTasks, {
    startDate: args.startDate,
    deadline: args.deadline,
    timeWindows: args.timeWindows,
    busy: [...existingAsBusy, ...args.externalBusy],
    maxMinutesPerDay: args.maxMinutesPerDay,
    hourUtility: args.hourUtility,
    now: args.now,
    planId: args.planId,
    tz: args.tz,
    initialDailyMinutesUsed,
    placementRules: args.placementRules,
    phaseCount: args.phaseCount,
  });

  const merged = [...args.existingSchedule, ...result.schedule].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );
  return { schedule: merged, overflow: result.overflow };
}

export function packWithScoring(
  tasks: PlanTask[],
  ctx: ScoringContext
): PackResult {
  const ordered = topologicalOrder(
    tasks,
    ctx.placementRules,
    ctx.phaseCount ?? 1
  );
  const placedById = new Map<string, PlacementRecord>();
  const placedBusy: BusyInterval[] = [];
  const dailyMinutesUsed = new Map<string, number>(
    ctx.initialDailyMinutesUsed ?? []
  );
  const overflow: PlanTask[] = [];

  for (const task of ordered) {
    let earliest = ctx.startDate;
    if (task.mustFollowTaskId) {
      const pred = placedById.get(task.mustFollowTaskId);
      if (pred) {
        const minDays = task.minDaysAfterPredecessor ?? 0;
        const after = addDaysInTz(startOfDayInTz(pred.end, ctx.tz), minDays, ctx.tz);
        if (after > earliest) earliest = after;
      }
    }
    const candidates = enumerateCandidates(
      task,
      ctx,
      earliest,
      [...ctx.busy, ...placedBusy],
      dailyMinutesUsed
    );
    if (candidates.length === 0) {
      overflow.push(task);
      continue;
    }
    const scores = candidates.map((c) =>
      scoreCandidate(task, c, ctx, dailyMinutesUsed)
    );
    const seed = hashSeed(`${ctx.planId}|${task.id}`);
    const rand = mulberry32(seed);
    const pickedIdx = pickCandidate(scores, rand);
    const best = candidates[pickedIdx];
    placedById.set(task.id, { task, start: best.start, end: best.end });
    placedBusy.push({ start: best.start, end: best.end });
    const k = dayKey(best.start, ctx.tz);
    dailyMinutesUsed.set(
      k,
      (dailyMinutesUsed.get(k) ?? 0) + best.durationMinutes
    );
  }

  return {
    schedule: mergeIntoDailyAgendas(Array.from(placedById.values()), ctx.tz),
    overflow,
  };
}

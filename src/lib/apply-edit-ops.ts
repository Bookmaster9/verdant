/**
 * Deterministic applier for AI-emitted edits (design Q-edit-llm).
 *
 * Two responsibilities:
 *   1. Apply imperative `ops` (extend_task, insert_task, remove_task,
 *      set_priority) by mutating the SproutPlan in place.
 *   2. Translate declarative `rules` (prefer/forbid/pin) into packer-ready
 *      inputs: forbid → BusyInterval[], pin → mutate the named session and
 *      treat as busy, prefer → pass through to ScoringContext.placementRules.
 *
 * Hard constraints (deadline, daily cap, free-window matching) are owned by
 * the scoring packer; this module's job is to translate AI intent into
 * packer inputs, not to re-implement constraint solving.
 */
import { parseISO, startOfDay } from "date-fns";
import type {
  PlacementRule,
  PlanTask,
  ScheduledSession,
  SproutPlan,
  TimeWindows,
} from "@/types/plan";
import type { BusyInterval } from "@/lib/calendar-read";
import type { EditOp } from "@/lib/edit-plan";
import { dedupeScheduleById, packWithScoring } from "@/lib/scoring-pack";
import { parseBlackouts, blackoutsToBusy } from "@/lib/blackouts";
import { buildId } from "@/lib/ids";
import {
  applyPinRules,
  compileForbidRulesToBusy,
} from "@/lib/placement-rules";
import type { HourUtilityMap } from "@/lib/hour-utility";

export interface ApplyContext {
  plan: SproutPlan;
  schedule: ScheduledSession[];
  manualBlackoutsJson: string;
  startDate: Date;
  deadline: Date;
  timeWindows: TimeWindows;
  busy: BusyInterval[];
  maxMinutesPerDay: number;
  hourUtility: HourUtilityMap;
  now: Date;
  /** Stable plan id for RNG seeding inside the packer. */
  planId: string;
  /**
   * Persistent placement rules already saved on the plan. Merged with any new
   * rules emitted by this edit before the packer runs. Persisting new rules
   * is opt-in (see route handler) — by default new rules are one-shot.
   */
  persistentRules?: PlacementRule[];
  /**
   * FSRS-projected review tasks (from `loadProjectedReviewTasks`). These are
   * NOT in `plan.tasks`; without passing them in, every repack silently drops
   * every unlocked future review. Pass them so reviews ride along.
   */
  projectedReviews?: PlanTask[];
}

type AuditEntry = {
  kind: EditOp["op"] | "prefer" | "forbid" | "pin";
  ok: boolean;
  note?: string;
};

export interface ApplyResult {
  plan: SproutPlan;
  schedule: ScheduledSession[];
  manualBlackoutsJson: string;
  /** Per-edit short audit log. */
  appliedOps: AuditEntry[];
  /**
   * Rules effectively applied to this packer run: persistent ∪ new. The
   * caller decides what subset to persist back to `LearningPlan.placementRules`
   * (default: only the persistent set, i.e. new rules are one-shot).
   */
  effectiveRules: PlacementRule[];
}

function clampMinutes(m: number): number {
  return Math.max(15, Math.min(90, Math.round(m)));
}

export function applyEditOps(
  ops: EditOp[],
  rules: PlacementRule[],
  ctx: ApplyContext
): ApplyResult {
  let plan: SproutPlan = {
    ...ctx.plan,
    tasks: ctx.plan.tasks.map((t) => ({ ...t })),
    phases: ctx.plan.phases.map((p) => ({ ...p })),
  };
  let schedule = ctx.schedule.map((s) => ({ ...s }));
  const manualBlackouts = parseBlackouts(ctx.manualBlackoutsJson);
  const appliedOps: AuditEntry[] = [];
  let structuralChanged = false;

  for (const op of ops) {
    switch (op.op) {
      case "extend_task": {
        const task = plan.tasks.find((t) => t.id === op.taskId);
        if (!task) {
          appliedOps.push({ kind: op.op, ok: false, note: "task not found" });
          break;
        }
        task.minutes = clampMinutes(task.minutes + op.addMinutes);
        structuralChanged = true;
        appliedOps.push({ kind: op.op, ok: true });
        break;
      }
      case "insert_task": {
        const after = plan.tasks.find((t) => t.id === op.afterTaskId);
        if (!after) {
          appliedOps.push({
            kind: op.op,
            ok: false,
            note: "afterTaskId not found",
          });
          break;
        }
        const newTask: PlanTask = {
          id: buildId("t", "ai-edit", String(plan.tasks.length)),
          title: op.title,
          type: op.type,
          minutes: clampMinutes(op.minutes),
          weekIndex: after.weekIndex,
          dayOffsetInWeek: Math.min(6, after.dayOffsetInWeek + 1),
          priority: op.priority ?? "core",
          mustFollowTaskId: after.id,
          minDaysAfterPredecessor: 1,
        };
        const idx = plan.tasks.findIndex((t) => t.id === after.id);
        plan.tasks = [
          ...plan.tasks.slice(0, idx + 1),
          newTask,
          ...plan.tasks.slice(idx + 1),
        ];
        structuralChanged = true;
        appliedOps.push({ kind: op.op, ok: true });
        break;
      }
      case "remove_task": {
        const before = plan.tasks.length;
        plan.tasks = plan.tasks.filter((t) => t.id !== op.taskId);
        if (plan.tasks.length === before) {
          appliedOps.push({ kind: op.op, ok: false, note: "task not found" });
          break;
        }
        schedule = schedule.flatMap((s) => {
          if (s.agenda) {
            const remainingAgenda = s.agenda.filter(
              (a) => a.planTaskId !== op.taskId
            );
            if (remainingAgenda.length === 0) return [];
            if (remainingAgenda.length === s.agenda.length) return [s];
            return [{ ...s, agenda: remainingAgenda }];
          }
          return s.planTaskId === op.taskId ? [] : [s];
        });
        structuralChanged = true;
        appliedOps.push({ kind: op.op, ok: true });
        break;
      }
      case "set_priority": {
        const task = plan.tasks.find((t) => t.id === op.taskId);
        if (!task) {
          appliedOps.push({ kind: op.op, ok: false, note: "task not found" });
          break;
        }
        task.priority = op.priority;
        appliedOps.push({ kind: op.op, ok: true });
        break;
      }
    }
  }

  const persistentRules = ctx.persistentRules ?? [];
  const effectiveRules: PlacementRule[] = [...persistentRules, ...rules];

  // Pin rules mutate the schedule directly. We do this before the repack so
  // pinned sessions are visible as locked-busy to the packer.
  const pinResult = applyPinRules(rules, schedule);
  schedule = pinResult.schedule;
  for (const rule of rules) {
    if (rule.kind === "pin") {
      const found = pinResult.pinnedSessionIds.has(rule.sessionId);
      appliedOps.push({
        kind: "pin",
        ok: found,
        note: found ? undefined : "session not found",
      });
    } else if (rule.kind === "forbid") {
      const hasWindow =
        (rule.window.dayOfWeek && rule.window.dayOfWeek.length > 0) ||
        !!rule.window.date ||
        !!rule.window.dateRange;
      appliedOps.push({
        kind: "forbid",
        ok: hasWindow,
        note: hasWindow ? undefined : "empty window — ignored",
      });
    } else if (rule.kind === "prefer") {
      appliedOps.push({ kind: "prefer", ok: true });
    }
  }

  // Always repack the future portion: any rule (prefer/forbid) might shift
  // unlocked sessions, and structural ops always need a reflow.
  const needsRepack =
    structuralChanged || rules.length > 0 || pinResult.pinned.length > 0;

  if (needsRepack) {
    const fromDate = ctx.now;
    const past = schedule.filter((s) => parseISO(s.end) < fromDate);
    const lockedFuture = schedule.filter(
      (s) => parseISO(s.start) >= fromDate && s.locked
    );
    const placedTaskIds = new Set<string>();
    for (const s of [...past, ...lockedFuture]) {
      if (s.agenda) for (const a of s.agenda) placedTaskIds.add(a.planTaskId);
      else placedTaskIds.add(s.planTaskId);
    }
    // Repack covers BOTH plan tasks (lessons + milestones from planJson) and
    // FSRS-projected reviews. Reviews aren't in plan.tasks; if we leave them
    // out, every repack drops every unlocked future review.
    const tasksToRepack = [
      ...plan.tasks.filter((t) => !placedTaskIds.has(t.id)),
      ...(ctx.projectedReviews ?? []).filter((t) => !placedTaskIds.has(t.id)),
    ];

    const lockedAsBusy: BusyInterval[] = lockedFuture.map((s) => ({
      start: parseISO(s.start),
      end: parseISO(s.end),
    }));
    const blackoutBusy = blackoutsToBusy(manualBlackouts);
    const forbidBusy = compileForbidRulesToBusy(effectiveRules, {
      startDate: ctx.startDate,
      deadline: ctx.deadline,
    });
    const repackStart =
      startOfDay(fromDate) > ctx.startDate ? startOfDay(fromDate) : ctx.startDate;

    const result = packWithScoring(tasksToRepack, {
      startDate: repackStart,
      deadline: ctx.deadline,
      timeWindows: ctx.timeWindows,
      busy: [...ctx.busy, ...lockedAsBusy, ...blackoutBusy, ...forbidBusy],
      maxMinutesPerDay: ctx.maxMinutesPerDay,
      hourUtility: ctx.hourUtility,
      now: ctx.now,
      planId: ctx.planId,
      placementRules: effectiveRules,
      phaseCount: plan.phases.length,
    });

    schedule = dedupeScheduleById(
      [...past, ...lockedFuture, ...result.schedule].sort(
        (a, b) => parseISO(a.start).getTime() - parseISO(b.start).getTime()
      )
    );
    if (result.overflow.length > 0) {
      appliedOps.push({
        kind: "extend_task",
        ok: false,
        note: `${result.overflow.length} task(s) couldn't fit before the deadline after this edit`,
      });
    }
  }

  schedule = dedupeScheduleById(
    schedule.sort(
      (a, b) => parseISO(a.start).getTime() - parseISO(b.start).getTime()
    )
  );
  plan = { ...plan, sessionsPlanned: plan.tasks.length };

  return {
    plan,
    schedule,
    manualBlackoutsJson: JSON.stringify(manualBlackouts),
    appliedOps,
    effectiveRules,
  };
}

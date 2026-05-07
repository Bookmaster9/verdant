import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { ensureUserPreferences } from "@/lib/user";
import { rescheduleUncompleted } from "@/lib/time-windows";
import { getExternalBusy } from "@/lib/calendar-read";
import { loadPlanState } from "@/lib/load-plan-state";
import { parseBlackouts, blackoutsToBusy, type ManualBlackout } from "@/lib/blackouts";
import { interpretEdit, placementRuleSchema } from "@/lib/edit-plan";
import { applyEditOps } from "@/lib/apply-edit-ops";
import { dedupeScheduleById, packWithScoring } from "@/lib/scoring-pack";
import { applyTaskFeedback } from "@/lib/task-feedback";
import { loadCrossPlanBusy } from "@/lib/cross-plan-busy";
import type { PlacementRule, ScheduledSession, SproutPlan } from "@/types/plan";
import {
  compileForbidRulesToBusy,
  parsePlacementRules,
} from "@/lib/placement-rules";
import { loadProjectedReviewTasks } from "@/lib/load-projected-reviews";
import { parseTimeWindowsJson } from "@/lib/default-preferences";
import { parseHourUtility } from "@/lib/hour-utility";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";

const patch = z.object({
  status: z.enum(["active", "archived", "paused"]).optional(),
  scheduleJson: z.string().optional(),
  naturalLanguage: z.string().optional(),
  /**
   * When true, any placement rules emitted by the NL editor for this PATCH
   * are appended to `LearningPlan.placementRules` and re-applied on every
   * future packer run. Default false → rules are one-shot.
   */
  persistRules: z.boolean().optional(),
  rescheduleFrom: z.string().optional(),
  lockSession: z
    .object({ sessionId: z.string(), locked: z.boolean() })
    .optional(),
  /**
   * One-shot operation: drop the `locked` flag on every future session in
   * this plan. Used by the "clear locks" button on the plan page so a stack
   * of pinned sessions doesn't permanently constrain rebalance/reoptimize.
   */
  clearLocks: z.boolean().optional(),
  freeformNote: z.string().max(2000).nullable().optional(),
  /** Rebuild the schedule from the existing planJson tasks via the scoring packer. Recovery action. */
  rebuildSchedule: z.boolean().optional(),
  manualBlackouts: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        reason: z.string().max(200).optional(),
      })
    )
    .optional(),
  /**
   * Full replacement of the plan's persistent placement rules. Used by the
   * settings UI to delete individual rules (caller sends the kept subset).
   * The schedule is reflowed against the new rule set.
   */
  placementRules: z.array(placementRuleSchema).max(50).optional(),
  taskFeedback: z
    .object({
      taskId: z.string(),
      completed: z.boolean().optional(),
      /** FSRS-aligned 4-button rating: 1=Again, 2=Hard, 4=Good, 5=Easy. */
      rating: z
        .number()
        .int()
        .refine((v) => v === 1 || v === 2 || v === 4 || v === 5, {
          message: "rating must be one of 1, 2, 4, 5",
        })
        .optional(),
    })
    .optional(),
});


type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const state = await loadPlanState({
    planId: id,
    userId: s.user.id,
    accessToken: s.accessToken,
  });
  if (!state) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    plan: state.plan,
    completions: state.completions,
    drift: {
      adoptedIds: state.drift.adoptedIds,
      removedIds: state.drift.removedIds,
    },
    conflicts: {
      locked: state.conflicts.lockedConflicts.map((c) => ({
        sessionId: c.session.id,
        sessionTitle: c.session.title,
        sessionStart: c.session.start,
        sessionEnd: c.session.end,
        overlappingCount: c.overlapping.length,
      })),
      unlockedIds: state.conflicts.unlockedConflictIds,
    },
  });
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
  });
  if (!plan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = await request.json();
  const p = patch.safeParse(body);
  if (!p.success) {
    return NextResponse.json({ error: p.error.message }, { status: 400 });
  }

  let outSchedule = plan.scheduleJson;
  if (p.data.scheduleJson) {
    outSchedule = p.data.scheduleJson;
  }
  let editSummary: string | null = null;
  let editDrops: Array<{ kind: string; reason: string; ref?: string }> = [];
  let outManualBlackoutsFromAI: string | null = null;
  let outPlanJsonFromAI: string | null = null;
  let outPlacementRulesFromAI: string | null = null;

  // Tasks the user has already committed should NEVER be re-packed by an
  // edit / rebuild / rebalance. Without this, a future-completed task (whose
  // schedule entry was removed at commit time) gets pulled back into
  // tasksToPack and a phantom future entry gets created — visible as the
  // "journal entries disappear after rebuild" symptom on the sprout page.
  const completedRows = await prisma.taskCompletion.findMany({
    where: { planId: id, completed: true },
    select: { taskId: true },
  });
  const completedTaskIds = new Set(completedRows.map((c) => c.taskId));
  if (p.data.naturalLanguage) {
    const sessions = JSON.parse(outSchedule || "[]") as ScheduledSession[];
    const sproutPlan = JSON.parse(plan.planJson || "{}") as SproutPlan;
    const now = new Date();
    const userPref = await ensureUserPreferences(s.user.id);
    const llm = await interpretEdit({
      request: p.data.naturalLanguage,
      plan: sproutPlan,
      schedule: sessions,
      now,
      userTimeZone: userPref.userTimeZone,
      planStartDate: plan.startDate,
      planDeadline: plan.deadline,
    });
    if (!llm.ok) {
      // No fallback. The HuggingFace path was deleted because it bypassed
      // every constraint the structured packer enforces; if interpretEdit
      // can't translate the request into ops/rules, surface that to the user.
      const reasonMap: Record<string, string> = {
        "no-api-key": "Natural language editing requires OPENAI_API_KEY in the environment.",
        "empty-response": "The model returned no content. Try again or rephrase.",
        "interpret-failed": "Couldn't interpret that request. Try rephrasing it more concretely.",
      };
      const message = reasonMap[llm.reason] ?? llm.reason;
      return NextResponse.json({ error: message }, { status: 400 });
    }
    const pref = await ensureUserPreferences(s.user.id);
    const tz = pref.userTimeZone || "UTC";
    const tw = parseTimeWindowsJson(pref.timeWindows);
    const hourUtility = parseHourUtility(pref.hourUtility);
    const [calRead, crossPlan] = await Promise.all([
      getExternalBusy({
        userId: s.user.id,
        accessToken: s.accessToken,
        from: now,
        to: new Date(plan.deadline.getTime() + 864e5),
      }),
      loadCrossPlanBusy({ userId: s.user.id, excludePlanId: id, tz }),
    ]);
    const externalBusy = calRead.intervals;
    const persistentRules = parsePlacementRules(plan.placementRules);
    const projectedReviews = await loadProjectedReviewTasks({
      planId: id,
      sproutPlan,
      planStartDate: plan.startDate,
    });
    const result = applyEditOps(llm.ops, llm.rules as PlacementRule[], {
      plan: sproutPlan,
      schedule: sessions,
      manualBlackoutsJson: plan.manualBlackouts,
      startDate: plan.startDate,
      deadline: new Date(plan.deadline.getTime() + 864e5),
      timeWindows: tw,
      busy: [...externalBusy, ...crossPlan.busy],
      maxMinutesPerDay: pref.maxMinutesDay,
      hourUtility,
      now,
      planId: id,
      tz,
      persistentRules,
      projectedReviews,
      completedTaskIds,
    });
    outSchedule = JSON.stringify(result.schedule);
    outPlanJsonFromAI = JSON.stringify(result.plan);
    outManualBlackoutsFromAI = result.manualBlackoutsJson;
    editSummary = llm.summary;
    editDrops = llm.drops;
    if (p.data.persistRules && llm.rules.length > 0) {
      // Append new rules to the persistent set. Pin rules are intentionally
      // skipped — they reference a specific sessionId and don't make sense
      // to apply to future packer runs.
      const toPersist = (llm.rules as PlacementRule[]).filter(
        (r) => r.kind !== "pin"
      );
      outPlacementRulesFromAI = JSON.stringify([
        ...persistentRules,
        ...toPersist,
      ]);
    }
  }
  if (p.data.lockSession) {
    const sessions = JSON.parse(outSchedule || "[]") as ScheduledSession[];
    const next = sessions.map((sess) =>
      sess.id === p.data.lockSession!.sessionId
        ? { ...sess, locked: p.data.lockSession!.locked }
        : sess
    );
    outSchedule = JSON.stringify(next);
  }
  if (p.data.clearLocks) {
    const sessions = JSON.parse(outSchedule || "[]") as ScheduledSession[];
    const nowAt = new Date();
    const next = sessions.map((sess) =>
      new Date(sess.start) >= nowAt && sess.locked
        ? { ...sess, locked: false }
        : sess
    );
    outSchedule = JSON.stringify(next);
    if (!editSummary) editSummary = "Cleared all locked sessions.";
  }
  // Direct rule replacement (settings UI uses this to delete individual rules).
  // Reflows the future schedule against the new rule set so removing a forbid
  // rule frees up its window and removing a prefer rule lets the packer rescore.
  if (p.data.placementRules) {
    const pref = await ensureUserPreferences(s.user.id);
    const tz = pref.userTimeZone || "UTC";
    const tw = parseTimeWindowsJson(pref.timeWindows);
    const hourUtility = parseHourUtility(pref.hourUtility);
    const sessions = JSON.parse(outSchedule || "[]") as ScheduledSession[];
    const sproutPlan = JSON.parse(plan.planJson || "{}") as SproutPlan;
    const now = new Date();
    const [calRead, crossPlan] = await Promise.all([
      getExternalBusy({
        userId: s.user.id,
        accessToken: s.accessToken,
        from: now,
        to: new Date(plan.deadline.getTime() + 864e5),
      }),
      loadCrossPlanBusy({ userId: s.user.id, excludePlanId: id, tz }),
    ]);
    const externalBusy = calRead.intervals;
    const newRules = p.data.placementRules as PlacementRule[];
    const deadlinePlus1 = new Date(plan.deadline.getTime() + 864e5);
    const past = sessions.filter((sess) => new Date(sess.end) < now);
    const lockedFuture = sessions.filter(
      (sess) => new Date(sess.start) >= now && sess.locked
    );
    const placedTaskIds = new Set<string>();
    for (const sess of [...past, ...lockedFuture]) {
      if (sess.agenda) for (const a of sess.agenda) placedTaskIds.add(a.planTaskId);
      else placedTaskIds.add(sess.planTaskId);
    }
    const projectedReviews = await loadProjectedReviewTasks({
      planId: id,
      sproutPlan,
      planStartDate: plan.startDate,
    });
    const tasksToPack = [
      ...(sproutPlan.tasks ?? []).filter(
        (t) => !placedTaskIds.has(t.id) && !completedTaskIds.has(t.id)
      ),
      ...projectedReviews.filter((t) => !placedTaskIds.has(t.id)),
    ];
    const lockedAsBusy = lockedFuture.map((sess) => ({
      start: new Date(sess.start),
      end: new Date(sess.end),
    }));
    const blackoutBusy = blackoutsToBusy(parseBlackouts(plan.manualBlackouts));
    const forbidBusy = compileForbidRulesToBusy(newRules, {
      startDate: now,
      deadline: deadlinePlus1,
    });
    const result = packWithScoring(tasksToPack, {
      startDate: now,
      deadline: deadlinePlus1,
      timeWindows: tw,
      busy: [
        ...externalBusy,
        ...crossPlan.busy,
        ...lockedAsBusy,
        ...blackoutBusy,
        ...forbidBusy,
      ],
      maxMinutesPerDay: pref.maxMinutesDay,
      hourUtility,
      now,
      planId: id,
      tz,
      placementRules: newRules,
      phaseCount: (sproutPlan.phases ?? []).length,
    });
    const merged = dedupeScheduleById(
      [...past, ...lockedFuture, ...result.schedule].sort(
        (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
      )
    );
    outSchedule = JSON.stringify(merged);
    outPlacementRulesFromAI = JSON.stringify(newRules);
  }
  // Manual blackouts: persist immediately. Triggers a reschedule on the
  // remaining unlocked future sessions (design Q4 γ-fallback).
  let outManualBlackouts: string | null = null;
  if (p.data.manualBlackouts) {
    outManualBlackouts = JSON.stringify(p.data.manualBlackouts);
    if (!p.data.rescheduleFrom) {
      const pref = await ensureUserPreferences(s.user.id);
      const tz = pref.userTimeZone || "UTC";
      const tw = parseTimeWindowsJson(pref.timeWindows);
      const sessions = JSON.parse(outSchedule || "[]") as ScheduledSession[];
      const from = new Date();
      const [calRead, crossPlan] = await Promise.all([
        getExternalBusy({
          userId: s.user.id,
          accessToken: s.accessToken,
          from,
          to: new Date(plan.deadline.getTime() + 864e5),
        }),
        loadCrossPlanBusy({ userId: s.user.id, excludePlanId: id, tz }),
      ]);
      const externalBusy = calRead.intervals;
      const blackoutBusy = blackoutsToBusy(p.data.manualBlackouts as ManualBlackout[]);
      const rescheduled = rescheduleUncompleted(
        sessions,
        from,
        new Date(plan.deadline.getTime() + 864e5),
        tw,
        pref.maxMinutesDay,
        [...externalBusy, ...crossPlan.busy, ...blackoutBusy],
        tz
      );
      outSchedule = JSON.stringify(rescheduled);
    }
  }
  if (p.data.rescheduleFrom) {
    const pref = await ensureUserPreferences(s.user.id);
    const tz = pref.userTimeZone || "UTC";
    const tw = parseTimeWindowsJson(pref.timeWindows);
    const sessions = JSON.parse(outSchedule || "[]") as ScheduledSession[];
    const from = new Date(p.data.rescheduleFrom);
    const [busyRead, crossPlan] = await Promise.all([
      getExternalBusy({
        userId: s.user.id,
        accessToken: s.accessToken,
        from,
        to: new Date(plan.deadline.getTime() + 864e5),
      }),
      loadCrossPlanBusy({ userId: s.user.id, excludePlanId: id, tz }),
    ]);
    const externalBusy = busyRead.intervals;
    const blackoutsJson = outManualBlackouts ?? plan.manualBlackouts;
    const blackoutBusy = blackoutsToBusy(parseBlackouts(blackoutsJson || "[]"));
    const rescheduled = rescheduleUncompleted(
      sessions,
      from,
      new Date(plan.deadline.getTime() + 864e5),
      tw,
      pref.maxMinutesDay,
      [...externalBusy, ...crossPlan.busy, ...blackoutBusy],
      tz
    );
    outSchedule = JSON.stringify(rescheduled);
  }

  // Rebuild schedule from the existing planJson (recovery action). Skips the
  // LLM. Preserves locked future sessions and packs everything else.
  if (p.data.rebuildSchedule) {
    const pref = await ensureUserPreferences(s.user.id);
    const tz = pref.userTimeZone || "UTC";
    const tw = parseTimeWindowsJson(pref.timeWindows);
    const hourUtility = parseHourUtility(pref.hourUtility);
    const sproutPlan = JSON.parse(plan.planJson || "{}") as SproutPlan;
    const sessions = JSON.parse(outSchedule || "[]") as ScheduledSession[];
    const now = new Date();
    const lockedFuture = sessions.filter(
      (sess) => new Date(sess.start) >= now && sess.locked
    );
    const placedTaskIds = new Set<string>();
    for (const sess of lockedFuture) {
      if (sess.agenda) for (const a of sess.agenda) placedTaskIds.add(a.planTaskId);
      else placedTaskIds.add(sess.planTaskId);
    }
    const projectedReviews = await loadProjectedReviewTasks({
      planId: id,
      sproutPlan,
      planStartDate: plan.startDate,
    });
    const tasksToPack = [
      ...(sproutPlan.tasks ?? []).filter(
        (t) => !placedTaskIds.has(t.id) && !completedTaskIds.has(t.id)
      ),
      ...projectedReviews.filter((t) => !placedTaskIds.has(t.id)),
    ];

    const [calRead, crossPlan] = await Promise.all([
      getExternalBusy({
        userId: s.user.id,
        accessToken: s.accessToken,
        from: now,
        to: new Date(plan.deadline.getTime() + 864e5),
      }),
      loadCrossPlanBusy({ userId: s.user.id, excludePlanId: id, tz }),
    ]);
    const externalBusy = calRead.intervals;
    const lockedAsBusy = lockedFuture.map((sess) => ({
      start: new Date(sess.start),
      end: new Date(sess.end),
    }));
    const blackoutBusy = blackoutsToBusy(parseBlackouts(plan.manualBlackouts));
    const persistentRules = parsePlacementRules(plan.placementRules);
    const forbidBusy = compileForbidRulesToBusy(persistentRules, {
      startDate: now,
      deadline: new Date(plan.deadline.getTime() + 864e5),
    });

    const result = packWithScoring(tasksToPack, {
      startDate: now,
      deadline: new Date(plan.deadline.getTime() + 864e5),
      timeWindows: tw,
      busy: [
        ...externalBusy,
        ...crossPlan.busy,
        ...lockedAsBusy,
        ...blackoutBusy,
        ...forbidBusy,
      ],
      maxMinutesPerDay: pref.maxMinutesDay,
      hourUtility,
      now,
      planId: id,
      tz,
      initialDailyMinutesUsed: crossPlan.initialDailyMinutesUsed,
      placementRules: persistentRules,
      phaseCount: (sproutPlan.phases ?? []).length,
    });
    const newSchedule = dedupeScheduleById(
      [...lockedFuture, ...result.schedule].sort(
        (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
      )
    );
    outSchedule = JSON.stringify(newSchedule);
    editSummary = `Rebuilt schedule. ${result.overflow.length} task(s) didn't fit.`;
  }

  if (p.data.taskFeedback) {
    const fbResult = await applyTaskFeedback({
      planId: id,
      userId: s.user.id,
      accessToken: s.accessToken,
      plan,
      currentScheduleJson: outSchedule,
      taskId: p.data.taskFeedback.taskId,
      completed: p.data.taskFeedback.completed,
      rating: p.data.taskFeedback.rating,
    });
    if (!fbResult.ok) {
      return NextResponse.json({ error: fbResult.error }, { status: fbResult.status });
    }
    outSchedule = fbResult.scheduleJson;
  }

  const data: {
    status?: string;
    scheduleJson?: string;
    planJson?: string;
    freeformNote?: string | null;
    manualBlackouts?: string;
    placementRules?: string;
  } = {};
  if (p.data.status !== undefined) {
    data.status = p.data.status;
  }
  if (outSchedule !== plan.scheduleJson) {
    data.scheduleJson = outSchedule;
  }
  if (outPlanJsonFromAI !== null) {
    data.planJson = outPlanJsonFromAI;
  }
  if (p.data.freeformNote !== undefined) {
    data.freeformNote = p.data.freeformNote;
  }
  if (outManualBlackouts !== null) {
    data.manualBlackouts = outManualBlackouts;
  } else if (outManualBlackoutsFromAI !== null) {
    data.manualBlackouts = outManualBlackoutsFromAI;
  }
  if (outPlacementRulesFromAI !== null) {
    data.placementRules = outPlacementRulesFromAI;
  }
  const updated = await prisma.learningPlan.update({
    where: { id },
    data,
  });

  // Drop the App-Router client cache for every surface that reads scheduleJson
  // / planJson / placementRules. Without this, the user can apply a Fern
  // reschedule and see the new time on /schedule but a stale time on the
  // sprout page (or vice versa) for ~30s.
  revalidatePath(`/plan/${id}`);
  revalidatePath(`/plan/${id}/session/[taskId]`, "page");
  revalidatePath("/schedule");
  revalidatePath("/");

  return NextResponse.json({
    plan: updated,
    summary: editSummary,
    drops: editDrops.length > 0 ? editDrops : undefined,
  });
}

export async function DELETE(_: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
    select: { id: true },
  });
  if (!plan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.learningPlan.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

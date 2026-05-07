import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { ensureUserPreferences } from "@/lib/user";
import { parseTimeWindowsJson } from "@/lib/default-preferences";
import { getExternalBusy } from "@/lib/calendar-read";
import { parseBlackouts, blackoutsToBusy } from "@/lib/blackouts";
import {
  compileForbidRulesToBusy,
  parsePlacementRules,
} from "@/lib/placement-rules";
import { packIntoExistingSchedule } from "@/lib/scoring-pack";
import { parseHourUtility } from "@/lib/hour-utility";
import { loadCrossPlanBusy } from "@/lib/cross-plan-busy";
import type { ScheduledSession, SproutPlan, PlanTask } from "@/types/plan";
import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * Overbook: force-place a specific list of overflow tasks into the schedule
 * by ignoring the daily-minutes cap. All other constraints still apply (time
 * windows, no double-booking with this plan or other active sprouts, deadline).
 *
 * The user opts into this explicitly via the create-result overflow panel
 * after seeing "N tasks couldn't fit before your deadline." See Q4 last
 * grilling: one-shot, this placement only — the user's normal cap is unchanged.
 */

const body = z.object({
  taskIds: z.array(z.string().min(1)).min(1),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const raw = await request.json();
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
  });
  if (!plan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sproutPlan = JSON.parse(plan.planJson || "{}") as SproutPlan;
  const tasks = (sproutPlan.tasks ?? []).filter((t) =>
    parsed.data.taskIds.includes(t.id)
  );
  if (tasks.length === 0) {
    return NextResponse.json(
      { error: "No matching tasks found in this plan." },
      { status: 400 }
    );
  }

  const now = new Date();
  const existingSchedule = JSON.parse(
    plan.scheduleJson || "[]"
  ) as ScheduledSession[];

  const [pref, calRead, crossPlan] = await Promise.all([
    ensureUserPreferences(s.user.id),
    getExternalBusy({
      userId: s.user.id,
      accessToken: s.accessToken,
      from: now,
      to: new Date(plan.deadline.getTime() + 864e5),
    }),
    loadCrossPlanBusy({ userId: s.user.id, excludePlanId: id }),
  ]);
  const tw = parseTimeWindowsJson(pref.timeWindows);
  const hourUtility = parseHourUtility(pref.hourUtility);
  const externalBusy = calRead.intervals;
  const blackoutBusy = blackoutsToBusy(parseBlackouts(plan.manualBlackouts));
  const persistentRules = parsePlacementRules(plan.placementRules);
  const forbidBusy = compileForbidRulesToBusy(persistentRules, {
    startDate: now,
    deadline: new Date(plan.deadline.getTime() + 864e5),
  });

  // The whole point of this endpoint: lift the daily cap for this placement
  // only. Number.MAX_SAFE_INTEGER is effectively "no cap" — clampDur in the
  // packer will min(task.minutes, this) → task.minutes wins. Other constraints
  // (windows, busy, deadline, persistent placement rules) are unchanged.
  const result = packIntoExistingSchedule({
    newTasks: tasks as PlanTask[],
    existingSchedule,
    startDate: now,
    deadline: new Date(plan.deadline.getTime() + 864e5),
    timeWindows: tw,
    externalBusy: [
      ...externalBusy,
      ...crossPlan.busy,
      ...blackoutBusy,
      ...forbidBusy,
    ],
    maxMinutesPerDay: Number.MAX_SAFE_INTEGER,
    hourUtility,
    now,
    planId: id,
    extraDailyMinutesUsed: crossPlan.initialDailyMinutesUsed,
    placementRules: persistentRules,
    phaseCount: (sproutPlan.phases ?? []).length,
  });

  await prisma.learningPlan.update({
    where: { id },
    data: { scheduleJson: JSON.stringify(result.schedule) },
  });

  return NextResponse.json({
    placed: tasks.length - result.overflow.length,
    stillOverflow: result.overflow.map((t) => ({
      id: t.id,
      title: t.title,
    })),
  });
}

import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { ensureUserPreferences } from "@/lib/user";
import { parseTimeWindowsJson } from "@/lib/default-preferences";
import { getExternalBusy, type BusyInterval } from "@/lib/calendar-read";
import { loadCrossPlanBusy } from "@/lib/cross-plan-busy";
import { parseBlackouts, blackoutsToBusy } from "@/lib/blackouts";
import { dedupeScheduleById, packWithScoring } from "@/lib/scoring-pack";
import { loadProjectedReviewTasks } from "@/lib/load-projected-reviews";
import {
  compileForbidRulesToBusy,
  parsePlacementRules,
} from "@/lib/placement-rules";
import { firstSlotFrom } from "@/lib/time-windows";
import type { ScheduledSession, SproutPlan } from "@/types/plan";
import { ensureVerdantCalendar, updateSessionInGoogle } from "@/lib/google-calendar";
import { z } from "zod";

const body = z.object({
  sessionId: z.string().min(1),
  action: z.enum(["move_to_next_free", "skip_and_rebalance"]),
});

type RouteParams = { params: Promise<{ id: string }> };

function sessionsToVerdantBusy(
  sessions: ScheduledSession[],
  excludeId: string
): BusyInterval[] {
  return sessions
    .filter((s) => s.id !== excludeId)
    .map((sess) => ({
      start: new Date(sess.start),
      end: new Date(sess.end),
    }));
}

async function repackAfterRemovingSession(
  planId: string,
  plan: {
    planJson: string | null;
    manualBlackouts: string | null;
    placementRules: string | null;
    startDate: Date;
    deadline: Date;
  },
  sessionsSansRemoved: ScheduledSession[],
  userId: string,
  accessToken: string | undefined
): Promise<{ scheduleJson: string; summary: string }> {
  const pref = await ensureUserPreferences(userId);
  const tw = parseTimeWindowsJson(pref.timeWindows);
  const slotEff = JSON.parse(pref.slotEffectiveness || "{}") as Record<
    string,
    number
  >;
  const sproutPlan = JSON.parse(plan.planJson || "{}") as SproutPlan;
  const now = new Date();
  const lockedFuture = sessionsSansRemoved.filter(
    (sess) => new Date(sess.start) >= now && sess.locked
  );
  const placedTaskIds = new Set<string>();
  for (const sess of lockedFuture) {
    if (sess.agenda) {
      for (const a of sess.agenda) placedTaskIds.add(a.planTaskId);
    } else placedTaskIds.add(sess.planTaskId);
  }
  const projectedReviews = await loadProjectedReviewTasks({
    planId,
    sproutPlan,
    planStartDate: plan.startDate,
  });
  const tasksToPack = [
    ...(sproutPlan.tasks ?? []).filter((t) => !placedTaskIds.has(t.id)),
    ...projectedReviews.filter((t) => !placedTaskIds.has(t.id)),
  ];

  const [calRead, crossPlan] = await Promise.all([
    getExternalBusy({
      userId,
      accessToken,
      from: now,
      to: new Date(plan.deadline.getTime() + 864e5),
    }),
    loadCrossPlanBusy({ userId, excludePlanId: planId }),
  ]);
  const externalBusy = calRead.intervals;
  const lockedAsBusy = lockedFuture.map((sess) => ({
    start: new Date(sess.start),
    end: new Date(sess.end),
  }));
  const blackoutBusy = blackoutsToBusy(
    parseBlackouts(plan.manualBlackouts ?? "[]")
  );
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
    slotEffectiveness: slotEff,
    initialDailyMinutesUsed: crossPlan.initialDailyMinutesUsed,
    placementRules: persistentRules,
    phaseCount: (sproutPlan.phases ?? []).length,
  });
  const newSchedule = dedupeScheduleById(
    [...lockedFuture, ...result.schedule].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    )
  );
  return {
    scheduleJson: JSON.stringify(newSchedule),
    summary: `Rebalanced plan. ${result.overflow.length} task(s) didn't fit.`,
  };
}

export async function POST(request: Request, { params }: RouteParams) {
  const { NextResponse: NR, after: runAfter } = await import("next/server");
  const s = await auth();
  if (!s?.user?.id) {
    return NR.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const raw = await request.json();
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return NR.json({ error: parsed.error.message }, { status: 400 });
  }
  const { sessionId, action } = parsed.data;

  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
  });
  if (!plan) {
    return NR.json({ error: "Not found" }, { status: 404 });
  }

  const sessions = JSON.parse(plan.scheduleJson || "[]") as ScheduledSession[];
  const target = sessions.find((sess) => sess.id === sessionId);
  if (!target) {
    return NR.json({ error: "Session not found" }, { status: 404 });
  }

  const pref = await ensureUserPreferences(s.user.id);
  const tw = parseTimeWindowsJson(pref.timeWindows);
  const deadlineEnd = new Date(plan.deadline.getTime() + 864e5);
  const now = new Date();

  if (action === "move_to_next_free") {
    const [calRead, crossPlan] = await Promise.all([
      getExternalBusy({
        userId: s.user.id,
        accessToken: s.accessToken,
        from: now,
        to: deadlineEnd,
        noCache: true,
      }),
      loadCrossPlanBusy({ userId: s.user.id, excludePlanId: id }),
    ]);
    const externalBusy = calRead.intervals;
    const blackoutBusy = blackoutsToBusy(
      parseBlackouts(plan.manualBlackouts ?? "[]")
    );
    const otherVerdant = sessionsToVerdantBusy(sessions, sessionId);
    const busy: BusyInterval[] = [
      ...externalBusy,
      ...crossPlan.busy,
      ...otherVerdant,
      ...blackoutBusy,
    ];

    const durationMin = Math.max(
      15,
      Math.floor(
        (new Date(target.end).getTime() - new Date(target.start).getTime()) /
          60_000
      )
    );
    const searchFrom = new Date(
      Math.max(new Date(target.end).getTime(), now.getTime())
    );

    const slot = firstSlotFrom(
      searchFrom,
      durationMin,
      tw,
      deadlineEnd,
      busy
    );
    if (!slot) {
      return NR.json(
        { error: "No free slot found before the sprout deadline." },
        { status: 409 }
      );
    }
    const newEnd = new Date(slot.getTime() + durationMin * 60_000);
    const startISO = slot.toISOString();
    const endISO = newEnd.toISOString();
    const prevEventId = target.calendarEventId;

    const updated: ScheduledSession[] = sessions.map((sess) =>
      sess.id === sessionId
        ? {
            ...sess,
            start: startISO,
            end: endISO,
            locked: false,
            googleSynced: false,
          }
        : sess
    );

    await prisma.learningPlan.update({
      where: { id },
      data: { scheduleJson: JSON.stringify(updated) },
    });

    const accessToken = s.accessToken;
    const userId = s.user.id;
    if (accessToken && prevEventId) {
      const moved: ScheduledSession = {
        ...target,
        start: startISO,
        end: endISO,
        locked: false,
        calendarEventId: prevEventId,
      };
      runAfter(async () => {
        try {
          const calendarId = await ensureVerdantCalendar({
            userId,
            accessToken,
          });
          await updateSessionInGoogle(accessToken, calendarId, moved);
          const fresh = await prisma.learningPlan.findUnique({ where: { id } });
          if (!fresh) return;
          const list = JSON.parse(
            fresh.scheduleJson || "[]"
          ) as ScheduledSession[];
          const next = list.map((sess) =>
            sess.id === sessionId ? { ...sess, googleSynced: true } : sess
          );
          await prisma.learningPlan.update({
            where: { id },
            data: { scheduleJson: JSON.stringify(next) },
          });
        } catch {
          /* leave googleSynced=false */
        }
      });
    }

    return NR.json({ ok: true, message: "Moved to the next available slot." });
  }

  // skip_and_rebalance
  const sans = sessions.filter((sess) => sess.id !== sessionId);
  const { scheduleJson, summary } = await repackAfterRemovingSession(
    id,
    plan,
    sans,
    s.user.id,
    s.accessToken
  );
  await prisma.learningPlan.update({
    where: { id },
    data: { scheduleJson },
  });
  return NR.json({ ok: true, message: summary });
}

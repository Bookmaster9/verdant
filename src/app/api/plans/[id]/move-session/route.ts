import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { ensureVerdantCalendar, updateSessionInGoogle } from "@/lib/google-calendar";
import {
  applySignals,
  parseHourUtility,
  stringifyHourUtility,
  SIGNAL_MAGNITUDE,
} from "@/lib/hour-utility";
import type { ScheduledSession } from "@/types/plan";
import { revalidatePath } from "next/cache";
import { z } from "zod";

const body = z.object({
  sessionId: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
});

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Move a scheduled session to a new time and lock it. Used by the schedule
 * page's drag-and-drop. Locking prevents `rescheduleUncompleted` from later
 * picking this session up and re-packing it.
 *
 * Refuses overlap with another Verdant session in the same plan as a backstop
 * for the client-side check. External calendar overlaps are allowed (the
 * conflict banner on the sprout page surfaces them).
 *
 * Google Calendar update is deferred to `after()` so the user-perceived
 * latency is just the DB write.
 */
export async function POST(request: Request, { params }: RouteParams) {
  // Turbopack can strip static `import { NextResponse, after } from "next/server"` bindings.
  const { NextResponse, after } = await import("next/server");
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
  const { sessionId, start, end } = parsed.data;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (
    Number.isNaN(startDate.getTime()) ||
    Number.isNaN(endDate.getTime()) ||
    endDate <= startDate
  ) {
    return NextResponse.json({ error: "Invalid start/end" }, { status: 400 });
  }

  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
  });
  if (!plan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sessions = JSON.parse(plan.scheduleJson || "[]") as ScheduledSession[];
  const target = sessions.find((sess) => sess.id === sessionId);
  if (!target) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Refuse Verdant-on-Verdant overlap.
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  for (const other of sessions) {
    if (other.id === sessionId) continue;
    const oStart = new Date(other.start).getTime();
    const oEnd = new Date(other.end).getTime();
    if (oEnd <= startMs) continue;
    if (oStart >= endMs) continue;
    return NextResponse.json(
      { error: "Overlaps another sprout session" },
      { status: 409 }
    );
  }

  // Drops outside the plan window are refused.
  if (startDate < plan.startDate) {
    return NextResponse.json(
      { error: "Before the sprout's start date" },
      { status: 400 }
    );
  }
  const deadlineEnd = new Date(plan.deadline.getTime() + 86_400_000);
  if (endDate > deadlineEnd) {
    return NextResponse.json(
      { error: "After the sprout's deadline" },
      { status: 400 }
    );
  }

  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();
  const previousCalendarEventId = target.calendarEventId;
  const updated: ScheduledSession[] = sessions.map((sess) =>
    sess.id === sessionId
      ? {
          ...sess,
          start: startISO,
          end: endISO,
          locked: true,
          // Mark out-of-sync until the post-response Google PATCH completes.
          googleSynced: false,
        }
      : sess
  );

  await prisma.learningPlan.update({
    where: { id },
    data: { scheduleJson: JSON.stringify(updated) },
  });

  // Drop any cached RSC payload that renders this plan's schedule. Without
  // this, the user can move a session on /schedule and then navigate to
  // /plan/[id] (or the dashboard) and see the old slot for ~30s of stale
  // App-Router client cache. Revalidate every surface that reads scheduleJson.
  revalidatePath(`/plan/${id}`);
  revalidatePath(`/plan/${id}/session/[taskId]`, "page");
  revalidatePath("/schedule");
  revalidatePath("/");

  // Hour-utility signal: move emits a paired (origin, destination) signal.
  // If the original start was already in the past, classify as "pushed back"
  // (stronger negative); otherwise treat as a routine manual shift.
  const moveNow = new Date();
  const originalStart = new Date(target.start);
  const wasPast = originalStart.getTime() < moveNow.getTime();
  const originMag = wasPast
    ? SIGNAL_MAGNITUDE.pushedBackOrigin
    : SIGNAL_MAGNITUDE.manualShiftOrigin;
  const destMag = wasPast
    ? SIGNAL_MAGNITUDE.pushedBackDestination
    : SIGNAL_MAGNITUDE.manualShiftDestination;
  try {
    const pref = await prisma.userPreference.findUnique({
      where: { userId: s.user.id },
      select: { hourUtility: true },
    });
    const cur = parseHourUtility(pref?.hourUtility ?? null);
    const nextMap = applySignals(
      cur,
      [
        { at: originalStart, magnitude: originMag },
        { at: startDate, magnitude: destMag },
      ],
      moveNow
    );
    await prisma.userPreference.update({
      where: { userId: s.user.id },
      data: { hourUtility: stringifyHourUtility(nextMap) },
    });
  } catch {
    // Signal write is best-effort — the move itself already succeeded.
  }

  // Update Google Calendar after the response is sent.
  const accessToken = s.accessToken;
  const userId = s.user.id;
  if (accessToken && previousCalendarEventId) {
    after(async () => {
      const movedSession: ScheduledSession = {
        ...target,
        start: startISO,
        end: endISO,
        locked: true,
        calendarEventId: previousCalendarEventId,
      };
      try {
        const pref = await prisma.userPreference.findUnique({
          where: { userId },
          select: { userTimeZone: true },
        });
        const userTimeZone =
          pref?.userTimeZone ??
          Intl.DateTimeFormat().resolvedOptions().timeZone;
        const calendarId = await ensureVerdantCalendar({
          userId,
          accessToken,
          userTimeZone,
        });
        await updateSessionInGoogle(
          accessToken,
          calendarId,
          userTimeZone,
          movedSession
        );
        // Mark synced=true once Google confirms.
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
        // Leave googleSynced=false; user can hit "↻ sync to Google" to retry.
      }
    });
  }

  return NextResponse.json({ ok: true });
}

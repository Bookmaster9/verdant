import { auth } from "@/auth";
import {
  ensureVerdantCalendar,
  syncUnsyncedSessions,
} from "@/lib/google-calendar";
import { prisma } from "@/lib/db";
import type { ScheduledSession } from "@/types/plan";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

/** POST — create Google Calendar events for scheduled learning sessions not yet synced. */
export async function POST(_: Request, { params }: RouteParams) {
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

  const schedule = JSON.parse(plan.scheduleJson || "[]") as ScheduledSession[];
  const accessToken = s.accessToken;

  // Pre-warm calendar provisioning before the per-session loop. The loop
  // itself is sequential, but ensuring this happens once (validated against
  // Google) keeps the contract identical to the parallel call sites.
  let calendarId: string | undefined;
  if (accessToken) {
    try {
      calendarId = await ensureVerdantCalendar({
        userId: s.user.id,
        accessToken,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Calendar setup failed";
      return NextResponse.json(
        { syncedCount: 0, pendingCount: schedule.length, errors: [message], ok: false },
        { status: 502 }
      );
    }
  }

  const { sessions, errors, syncedCount, allAlreadySynced } =
    await syncUnsyncedSessions(accessToken, calendarId, schedule);

  await prisma.learningPlan.update({
    where: { id },
    data: { scheduleJson: JSON.stringify(sessions) },
  });

  const pending = sessions.filter((x) => !x.googleSynced).length;

  return NextResponse.json({
    syncedCount,
    pendingCount: pending,
    allAlreadySynced,
    errors,
    ok: errors.length === 0 || syncedCount > 0,
  });
}

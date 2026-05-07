import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { invalidateBusyIntervalsCacheForUser } from "@/lib/calendar-read";
import type { ScheduledSession } from "@/types/plan";
import { NextResponse } from "next/server";

/**
 * "Nuke from orbit" reset for the user's Verdant calendar wiring. After this
 * call, the next push will create a fresh secondary calendar in Google.
 *
 * Wipes:
 *   - `UserPreference.verdantCalendarId` → forces a fresh calendar on next
 *     `ensureVerdantCalendar`.
 *   - `calendarEventId` and `googleSynced` on every session in every plan
 *     owned by this user → forces every session to be re-pushed and prevents
 *     drift from misreading stale ids as "deleted in Google".
 *
 * Does NOT delete any calendars in Google. The user must remove orphan
 * "Verdant" calendars from their Google Calendar sidebar manually. This is
 * deliberate: deleting calendars via API is destructive and out of scope for
 * a small recovery action.
 */
export async function POST() {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = s.user.id;

  await prisma.userPreference.upsert({
    where: { userId },
    create: {
      userId,
      timeWindows: JSON.stringify({}),
      verdantCalendarId: null,
      legacyVerdantEventsAckAt: new Date(0),
    },
    update: { verdantCalendarId: null },
  });

  const plans = await prisma.learningPlan.findMany({
    where: { userId },
    select: { id: true, scheduleJson: true },
  });

  let plansTouched = 0;
  let sessionsCleared = 0;
  for (const p of plans) {
    const sessions = JSON.parse(p.scheduleJson || "[]") as ScheduledSession[];
    let touched = false;
    const next: ScheduledSession[] = sessions.map((sess) => {
      if (sess.calendarEventId === undefined && !sess.googleSynced) {
        return sess;
      }
      touched = true;
      sessionsCleared++;
      const cleaned: ScheduledSession = { ...sess };
      delete cleaned.calendarEventId;
      delete cleaned.googleSynced;
      return cleaned;
    });
    if (!touched) continue;
    plansTouched++;
    await prisma.learningPlan.update({
      where: { id: p.id },
      data: { scheduleJson: JSON.stringify(next) },
    });
  }

  invalidateBusyIntervalsCacheForUser(userId);

  return NextResponse.json({
    ok: true,
    plansTouched,
    sessionsCleared,
  });
}

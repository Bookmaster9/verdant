/**
 * Write-side Google Calendar access for Verdant.
 *
 * After the calendar-scope migration, Verdant only owns events on its own
 * secondary calendar (created via the `calendar.app.created` scope). The
 * calendar id is stored per-user on `UserPreference.verdantCalendarId` and
 * provisioned lazily on the first push.
 *
 * Read companion: `calendar-read.ts` (FreeBusy on primary; events.list on the
 * Verdant secondary).
 */
import { prisma } from "@/lib/db";
import type { ScheduledSession } from "@/types/plan";

const VERDANT_CALENDAR_NAME = "Verdant";
const VERDANT_CALENDAR_DESCRIPTION =
  "Study sessions Verdant scheduled into your week. Edits here flow back into Verdant.";

interface CalendarResource {
  id: string;
  summary?: string;
}

/**
 * Render a human-readable error from a Calendar REST failure (avoids dumping
 * giant JSON into the UI). Recognises the most common 400/403 shapes.
 */
function calendarHttpError(status: number, body: string): string {
  if (status === 403 || status === 400) {
    try {
      const j = JSON.parse(body) as {
        error?: {
          message?: string;
          details?: Array<{ reason?: string; metadata?: Record<string, string> }>;
        };
      };
      const details = j.error?.details ?? [];
      const disabled = details.some(
        (d) =>
          d.reason === "SERVICE_DISABLED" ||
          d.metadata?.reason === "SERVICE_DISABLED"
      );
      const msg = j.error?.message ?? "";
      if (
        disabled ||
        msg.includes("has not been used in project") ||
        msg.includes("accessNotConfigured")
      ) {
        const activation =
          details.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl ??
          "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com";
        return (
          `Google Calendar API is off for your OAuth app's Cloud project. ` +
          `Enable "Google Calendar API" for that project (APIs & Services → Library), wait a few minutes, then retry. ` +
          `Open: ${activation}`
        );
      }
      if (status === 403 && msg.toLowerCase().includes("insufficient")) {
        return "Google denied the request — you may need to reconnect Google so Verdant has the right calendar permissions.";
      }
      if (msg) return `Google Calendar: ${msg}`;
    } catch {
      /* fall through */
    }
  }
  const clip = body.length > 400 ? `${body.slice(0, 400)}…` : body;
  return `Calendar HTTP ${status}: ${clip}`;
}

function calendarEventDescription(session: ScheduledSession): string {
  if (session.agenda && session.agenda.length > 0) {
    const lines = session.agenda.map(
      (a, i) => `${i + 1}. ${a.title} (~${a.minutes} min)`
    );
    return ["Verdant — accomplish during this session:", "", ...lines].join("\n");
  }
  return "Verdant sprout session";
}

/**
 * Get-or-create the Verdant secondary calendar for `userId`. Returns the
 * calendar id. Persists the id on `UserPreference.verdantCalendarId` so
 * subsequent calls are a single DB read.
 *
 * Recovers from "calendar deleted in Google" by clearing the stored id and
 * recreating on the next call (caller passes `forceRecreate=true` after a
 * 404 from an event write).
 */
export async function ensureVerdantCalendar(args: {
  userId: string;
  accessToken: string;
  forceRecreate?: boolean;
}): Promise<string> {
  const { userId, accessToken, forceRecreate } = args;
  if (!forceRecreate) {
    const pref = await prisma.userPreference.findUnique({
      where: { userId },
      select: { verdantCalendarId: true },
    });
    if (pref?.verdantCalendarId) return pref.verdantCalendarId;
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: VERDANT_CALENDAR_NAME,
        description: VERDANT_CALENDAR_DESCRIPTION,
        timeZone,
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(calendarHttpError(res.status, body));
  }
  const j = (await res.json()) as CalendarResource;
  if (!j.id) {
    throw new Error("Calendar create response missing id");
  }

  await prisma.userPreference.upsert({
    where: { userId },
    create: {
      userId,
      timeWindows: JSON.stringify({}),
      verdantCalendarId: j.id,
      legacyVerdantEventsAckAt: new Date(0),
    },
    update: { verdantCalendarId: j.id },
  });
  return j.id;
}

interface InsertResult {
  id: string;
}

/**
 * Create a single Google Calendar event on the user's Verdant secondary
 * calendar. If the calendar is missing in Google (404 on insert), recreates it
 * and retries once.
 */
export async function syncSessionToGoogle(
  userId: string,
  accessToken: string,
  session: ScheduledSession
): Promise<InsertResult> {
  let calendarId = await ensureVerdantCalendar({ userId, accessToken });
  const attempt = async (calId: string): Promise<Response> => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const summary =
      session.title.length > 900 ? `${session.title.slice(0, 897)}…` : session.title;
    return fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
        calId
      )}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary,
          start: { dateTime: session.start, timeZone },
          end: { dateTime: session.end, timeZone },
          description: calendarEventDescription(session),
        }),
      }
    );
  };

  let res = await attempt(calendarId);
  if (res.status === 404) {
    // Calendar deleted in Google. Recreate and retry once.
    calendarId = await ensureVerdantCalendar({
      userId,
      accessToken,
      forceRecreate: true,
    });
    res = await attempt(calendarId);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(calendarHttpError(res.status, body));
  }
  const j = (await res.json()) as { id: string };
  return { id: j.id };
}

/**
 * Insert one session, returning a copy with `calendarEventId` + `googleSynced`
 * set. Failure is non-fatal: returns the session with `googleSynced=false`.
 */
export async function insertOrSkip(
  userId: string,
  accessToken: string | undefined,
  session: ScheduledSession
): Promise<ScheduledSession> {
  if (!accessToken) {
    return { ...session, googleSynced: false };
  }
  try {
    const { id } = await syncSessionToGoogle(userId, accessToken, session);
    return { ...session, calendarEventId: id, googleSynced: true };
  } catch {
    return { ...session, googleSynced: false };
  }
}

/**
 * PATCH an existing event on the Verdant secondary calendar to new times.
 * Used by the drag-to-move flow on the schedule page when the session was
 * already synced. Throws on non-OK; callers mark `googleSynced=false` on
 * failure.
 */
export async function updateSessionInGoogle(
  userId: string,
  accessToken: string,
  session: ScheduledSession
): Promise<void> {
  if (!session.calendarEventId) {
    throw new Error("session has no calendarEventId — call syncSessionToGoogle instead");
  }
  const calendarId = await ensureVerdantCalendar({ userId, accessToken });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const summary =
    session.title.length > 900 ? `${session.title.slice(0, 897)}…` : session.title;
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events/${encodeURIComponent(session.calendarEventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary,
        start: { dateTime: session.start, timeZone },
        end: { dateTime: session.end, timeZone },
        description: calendarEventDescription(session),
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(calendarHttpError(res.status, body));
  }
}

/**
 * Create Google Calendar events for sessions not yet marked synced. Runs
 * sequentially to reduce rate-limit risk.
 */
export async function syncUnsyncedSessions(
  userId: string,
  accessToken: string | undefined,
  sessions: ScheduledSession[]
): Promise<{
  sessions: ScheduledSession[];
  errors: string[];
  syncedCount: number;
}> {
  const errors: string[] = [];
  if (!accessToken) {
    return {
      sessions,
      errors: [
        "No Google session token. Sign out and sign in again so Verdant can use Calendar.",
      ],
      syncedCount: 0,
    };
  }

  let syncedCount = 0;
  const out: ScheduledSession[] = [];
  let fatalApiOff = false;

  for (const sess of sessions) {
    if (fatalApiOff) {
      out.push(sess);
      continue;
    }
    if (sess.googleSynced && sess.calendarEventId) {
      out.push(sess);
      continue;
    }
    try {
      const { id } = await syncSessionToGoogle(userId, accessToken, sess);
      syncedCount++;
      out.push({ ...sess, calendarEventId: id, googleSynced: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push({ ...sess, googleSynced: false });
      const apiOff = msg.includes("Google Calendar API is off");
      if (apiOff) {
        fatalApiOff = true;
        errors.push(msg);
        continue;
      }
      errors.push(`${sess.title}: ${msg}`);
    }
  }

  return { sessions: out, errors, syncedCount };
}

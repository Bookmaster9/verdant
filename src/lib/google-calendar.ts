/**
 * Write-side Google Calendar access for Verdant.
 *
 * After the calendar-scope migration, Verdant only owns events on its own
 * secondary calendar (created via the `calendar.app.created` scope). The
 * calendar id is stored per-user on `UserPreference.verdantCalendarId` and
 * provisioned lazily via `ensureVerdantCalendar`.
 *
 * Concurrency contract: callers that fan out (Promise.all over many sessions)
 * MUST pre-warm by calling `ensureVerdantCalendar` once and passing the result
 * down to every per-session function. Calling `ensureVerdantCalendar` from
 * inside a parallel loop races the DB read against the create+upsert, which
 * causes N concurrent calendar creates and leaves N-1 orphaned calendars in
 * the user's Google sidebar.
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

async function createVerdantCalendar(accessToken: string): Promise<string> {
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
  return j.id;
}

async function calendarStillExists(
  calendarId: string,
  accessToken: string
): Promise<boolean> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (res.ok) return true;
  if (res.status === 404 || res.status === 410) return false;
  const body = await res.text();
  throw new Error(calendarHttpError(res.status, body));
}

async function persistCalendarId(userId: string, id: string): Promise<void> {
  await prisma.userPreference.upsert({
    where: { userId },
    create: {
      userId,
      timeWindows: JSON.stringify({}),
      verdantCalendarId: id,
      legacyVerdantEventsAckAt: new Date(0),
    },
    update: { verdantCalendarId: id },
  });
}

/**
 * Get-or-create the Verdant secondary calendar for `userId`. Returns a
 * verified-live calendar id.
 *
 * Steps:
 *   1. Read `UserPreference.verdantCalendarId` from the DB.
 *   2. If present, validate by GET on the calendar resource. If it 404s
 *      (user deleted it in Google), fall through to recreate.
 *   3. Otherwise call `POST /calendars`, persist the new id, return it.
 *
 * Concurrency: every fanned-out write path MUST call this once before the
 * fan-out and reuse the returned id. Calling it in parallel from N tasks
 * results in N calendar creates because step 1 races the persist in step 3.
 */
export async function ensureVerdantCalendar(args: {
  userId: string;
  accessToken: string;
}): Promise<string> {
  const { userId, accessToken } = args;
  const pref = await prisma.userPreference.findUnique({
    where: { userId },
    select: { verdantCalendarId: true },
  });
  if (pref?.verdantCalendarId) {
    const live = await calendarStillExists(pref.verdantCalendarId, accessToken);
    if (live) return pref.verdantCalendarId;
    // Calendar was deleted in Google — fall through and recreate.
  }
  const id = await createVerdantCalendar(accessToken);
  await persistCalendarId(userId, id);
  return id;
}

interface InsertResult {
  id: string;
}

/**
 * Create a single Google Calendar event on the user's Verdant secondary
 * calendar. Caller MUST pass a `calendarId` returned from `ensureVerdantCalendar`.
 */
export async function syncSessionToGoogle(
  accessToken: string,
  calendarId: string,
  session: ScheduledSession
): Promise<InsertResult> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const summary =
    session.title.length > 900 ? `${session.title.slice(0, 897)}…` : session.title;
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
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
  if (!res.ok) {
    const body = await res.text();
    throw new Error(calendarHttpError(res.status, body));
  }
  const j = (await res.json()) as { id: string };
  return { id: j.id };
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
 * Insert one session, returning a copy with `calendarEventId` + `googleSynced`
 * set. Failure is non-fatal: returns the session with `googleSynced=false`.
 *
 * Caller is responsible for pre-warming `calendarId` via `ensureVerdantCalendar`.
 */
export async function insertOrSkip(
  accessToken: string | undefined,
  calendarId: string | undefined,
  session: ScheduledSession
): Promise<ScheduledSession> {
  if (!accessToken || !calendarId) {
    return { ...session, googleSynced: false };
  }
  try {
    const { id } = await syncSessionToGoogle(accessToken, calendarId, session);
    return { ...session, calendarEventId: id, googleSynced: true };
  } catch {
    return { ...session, googleSynced: false };
  }
}

/**
 * PATCH an existing event on the Verdant secondary calendar to new times.
 * Used by the drag-to-move flow. Throws on non-OK; callers mark
 * `googleSynced=false` on failure.
 */
export async function updateSessionInGoogle(
  accessToken: string,
  calendarId: string,
  session: ScheduledSession
): Promise<void> {
  if (!session.calendarEventId) {
    throw new Error("session has no calendarEventId — call syncSessionToGoogle instead");
  }
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
 * sequentially to reduce rate-limit risk. Caller pre-warms `calendarId`.
 */
export async function syncUnsyncedSessions(
  accessToken: string | undefined,
  calendarId: string | undefined,
  sessions: ScheduledSession[]
): Promise<{
  sessions: ScheduledSession[];
  errors: string[];
  syncedCount: number;
  /** True if every session is already on Google — UI can show "all synced". */
  allAlreadySynced: boolean;
}> {
  const errors: string[] = [];
  if (!accessToken) {
    return {
      sessions,
      errors: [
        "No Google session token. Sign out and sign in again so Verdant can use Calendar.",
      ],
      syncedCount: 0,
      allAlreadySynced: false,
    };
  }
  if (!calendarId) {
    return {
      sessions,
      errors: [
        "Verdant calendar isn't ready yet. Try again in a moment.",
      ],
      syncedCount: 0,
      allAlreadySynced: false,
    };
  }

  let syncedCount = 0;
  let pendingCount = 0;
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
    pendingCount++;
    try {
      const { id } = await syncSessionToGoogle(accessToken, calendarId, sess);
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

  return {
    sessions: out,
    errors,
    syncedCount,
    allAlreadySynced: pendingCount === 0,
  };
}

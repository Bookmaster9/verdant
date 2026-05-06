import type { ScheduledSession } from "@/types/plan";

const CAL_PRIMARY = "primary";

/** Human-readable error from Calendar REST failures (avoids repeating huge JSON per session). */
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
          (d.metadata?.reason === "SERVICE_DISABLED")
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
          `Google Calendar API is off for your OAuth app’s Cloud project. ` +
          `Enable “Google Calendar API” for that project (APIs & Services → Library), wait a few minutes, then retry. ` +
          `Open: ${activation}`
        );
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
 * Create a Google Calendar event. Requires
 * https://www.googleapis.com/auth/calendar.events
 */
export async function syncSessionToGoogle(
  accessToken: string,
  session: ScheduledSession
): Promise<{ id: string }> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const summary =
    session.title.length > 900 ? `${session.title.slice(0, 897)}…` : session.title;
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      CAL_PRIMARY
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
    const errBody = await res.text();
    throw new Error(calendarHttpError(res.status, errBody));
  }
  const j = (await res.json()) as { id: string };
  return { id: j.id };
}

export async function insertOrSkip(
  accessToken: string | undefined,
  session: ScheduledSession
): Promise<ScheduledSession> {
  if (!accessToken) {
    return { ...session, googleSynced: false };
  }
  try {
    const { id } = await syncSessionToGoogle(accessToken, session);
    return { ...session, calendarEventId: id, googleSynced: true };
  } catch {
    return { ...session, googleSynced: false };
  }
}

/**
 * PATCH an existing Google Calendar event to new start/end times. Used by the
 * drag-to-move flow on the schedule page when the session was already synced.
 * Throws on non-OK responses; callers should mark `googleSynced=false` on failure.
 */
export async function updateSessionInGoogle(
  accessToken: string,
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
      CAL_PRIMARY
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
    const errBody = await res.text();
    throw new Error(calendarHttpError(res.status, errBody));
  }
}

/**
 * Create Google Calendar events for sessions that are not marked synced yet.
 * Runs sequentially to reduce API rate issues.
 */
export async function syncUnsyncedSessions(
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
      const { id } = await syncSessionToGoogle(accessToken, sess);
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

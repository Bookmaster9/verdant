/**
 * Write-side Google Calendar access for Verdant.
 *
 * After the calendar-scope migration, Verdant only owns events on its own
 * secondary calendar (created via the `calendar.app.created` scope). The
 * calendar id is stored per-user on `UserPreference.verdantCalendarId` and
 * provisioned lazily via `ensureVerdantCalendar`.
 *
 * Concurrency contract:
 *   1. Within a single request: callers that fan out (Promise.all over many
 *      sessions) MUST pre-warm by calling `ensureVerdantCalendar` once and
 *      passing the result down to every per-session function.
 *   2. Across concurrent requests: `ensureVerdantCalendar` itself is
 *      protected by a Postgres advisory lock so two requests racing against a
 *      null `verdantCalendarId` won't each create a new calendar.
 *
 * Timezone contract:
 *   Stored ScheduledSession.start/end ISO strings are produced by the packer
 *   and SSR renderer using `date-fns` runtime-local arithmetic. On Vercel
 *   that runtime is UTC, so the strings represent "naive user-local"
 *   clock-times tagged with `Z`. The schedule UI works because both the
 *   producer and the renderer are in the same (server's UTC) tz, so the
 *   illusion holds. At the GCal sync boundary that illusion would break —
 *   GCal correctly interprets a `Z`-tagged datetime as UTC and shifts the
 *   event by the user's UTC offset. We compensate here:
 *     - WRITE: strip the `Z`, send the naive clock-time + the user's IANA
 *       tz in the `timeZone` field. GCal then stores at the correct instant.
 *     - READ (drift): the GCal API returns events with an explicit offset.
 *       Convert the actual instant *back* to the user's local clock-time and
 *       re-tag with `Z`, matching the storage convention.
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

async function createVerdantCalendar(
  accessToken: string,
  timeZone: string
): Promise<string> {
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

/**
 * Hash a string userId into a 64-bit signed integer suitable for
 * `pg_advisory_xact_lock`. FNV-1a 64-bit, then bitcast unsigned → signed.
 */
function hashUserIdToBigInt(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & mask;
  }
  if (h >= 0x8000000000000000n) h -= 0x10000000000000000n;
  return h;
}

/**
 * Get-or-create the Verdant secondary calendar for `userId`. Returns a
 * verified-live calendar id.
 *
 * Lock semantics:
 *   - Fast path: if the DB already has a `verdantCalendarId` AND that calendar
 *     still exists in Google, return it without acquiring a lock. This is the
 *     hot path on every sync.
 *   - Slow path: take a Postgres transactional advisory lock keyed on a hash
 *     of the userId, re-check inside the lock (in case another concurrent
 *     request just persisted), then create + persist. The lock releases at
 *     transaction commit.
 *
 * Without the slow-path lock, two requests racing against `verdantCalendarId
 * = null` (e.g., plan-creation's background `after()` and a clicked
 * "sync to Google") would each call `POST /calendars` and leave one orphaned.
 */
export async function ensureVerdantCalendar(args: {
  userId: string;
  accessToken: string;
  /** IANA tz used when creating a fresh calendar's default zone. Optional. */
  userTimeZone?: string | null;
}): Promise<string> {
  const { userId, accessToken } = args;

  // Fast path — no lock needed if we have a live id.
  const initial = await prisma.userPreference.findUnique({
    where: { userId },
    select: { verdantCalendarId: true },
  });
  if (initial?.verdantCalendarId) {
    const live = await calendarStillExists(
      initial.verdantCalendarId,
      accessToken
    );
    if (live) return initial.verdantCalendarId;
  }

  // Slow path — take an advisory lock so concurrent provisioning serializes.
  const lockKey = hashUserIdToBigInt(userId);
  const tz =
    args.userTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;
    // Re-check inside the lock — another concurrent caller may have just
    // persisted a fresh id.
    const locked = await tx.userPreference.findUnique({
      where: { userId },
      select: { verdantCalendarId: true },
    });
    if (locked?.verdantCalendarId) {
      const live = await calendarStillExists(
        locked.verdantCalendarId,
        accessToken
      );
      if (live) return locked.verdantCalendarId;
    }
    const id = await createVerdantCalendar(accessToken, tz);
    await tx.userPreference.upsert({
      where: { userId },
      create: {
        userId,
        timeWindows: JSON.stringify({}),
        verdantCalendarId: id,
        legacyVerdantEventsAckAt: new Date(0),
      },
      update: { verdantCalendarId: id },
    });
    return id;
  });
}

// ---------------------------------------------------------------------------
// Timezone helpers (see "Timezone contract" at top of file).

/**
 * Strip a trailing `Z` or `±HH:MM` offset from an ISO datetime string. The
 * result is a naive (unzoned) clock-time, suitable as `dateTime` when paired
 * with an explicit `timeZone` field in the GCal API.
 */
function naivelocalISO(iso: string): string {
  return iso.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "");
}

/**
 * Convert an absolute Date into a `Z`-tagged ISO string whose clock-time
 * matches what that instant looks like in `tz`. This is the inverse of how
 * the packer produces sessions: stored strings represent the user's local
 * clock-time but use `Z` notation. After this helper, drift-adopted times
 * stored back into `scheduleJson` follow the same convention so SSR
 * formatters render them identically to packer-produced sessions.
 */
function absoluteToNaiveLocalISO(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  let hour = get("hour");
  if (hour === "24") hour = "00"; // some Intl backends emit 24 for midnight
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get(
    "minute"
  )}:${get("second")}.000Z`;
}

/** Exposed for `calendar-read.ts` (drift) to convert GCal → storage form. */
export { absoluteToNaiveLocalISO as toNaiveLocalISO };

// ---------------------------------------------------------------------------
// Event write functions.

interface InsertResult {
  id: string;
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
 * Create a single event on the user's Verdant secondary calendar. Caller
 * MUST pre-warm `calendarId` and pass `userTimeZone` (IANA, e.g.
 * "America/New_York") so GCal interprets the stored clock-time correctly.
 */
export async function syncSessionToGoogle(
  accessToken: string,
  calendarId: string,
  userTimeZone: string,
  session: ScheduledSession
): Promise<InsertResult> {
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
        start: { dateTime: naivelocalISO(session.start), timeZone: userTimeZone },
        end: { dateTime: naivelocalISO(session.end), timeZone: userTimeZone },
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

/**
 * Insert one session, returning a copy with `calendarEventId` + `googleSynced`
 * set. Failure is non-fatal: returns the session with `googleSynced=false`.
 */
export async function insertOrSkip(
  accessToken: string | undefined,
  calendarId: string | undefined,
  userTimeZone: string | undefined,
  session: ScheduledSession
): Promise<ScheduledSession> {
  if (!accessToken || !calendarId || !userTimeZone) {
    return { ...session, googleSynced: false };
  }
  try {
    const { id } = await syncSessionToGoogle(
      accessToken,
      calendarId,
      userTimeZone,
      session
    );
    return { ...session, calendarEventId: id, googleSynced: true };
  } catch {
    return { ...session, googleSynced: false };
  }
}

/** PATCH an existing event on the Verdant secondary calendar to new times. */
export async function updateSessionInGoogle(
  accessToken: string,
  calendarId: string,
  userTimeZone: string,
  session: ScheduledSession
): Promise<void> {
  if (!session.calendarEventId) {
    throw new Error("session has no calendarEventId — call syncSessionToGoogle instead");
  }
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
        start: { dateTime: naivelocalISO(session.start), timeZone: userTimeZone },
        end: { dateTime: naivelocalISO(session.end), timeZone: userTimeZone },
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
  accessToken: string | undefined,
  calendarId: string | undefined,
  userTimeZone: string | undefined,
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
      errors: ["Verdant calendar isn't ready yet. Try again in a moment."],
      syncedCount: 0,
      allAlreadySynced: false,
    };
  }
  if (!userTimeZone) {
    return {
      sessions,
      errors: [
        "Verdant doesn't know your timezone yet. Refresh the page once and try again.",
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
      const { id } = await syncSessionToGoogle(
        accessToken,
        calendarId,
        userTimeZone,
        sess
      );
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

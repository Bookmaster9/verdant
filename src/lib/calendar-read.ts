/**
 * Read-side Google Calendar access for Verdant.
 *
 * Two distinct sources after the calendar-scope migration:
 *
 *   - `getExternalBusy` — POSTs to FreeBusy on the user's primary calendar.
 *     Returns `{start, end}` intervals with NO event metadata (id, title,
 *     transparency, attendee state). The FreeBusy endpoint already filters
 *     out cancelled / transparent / declined events server-side, so callers
 *     just consume opaque busy ranges. This is what the planner, conflict
 *     check, and onboarding auto-fill use.
 *
 *   - `getVerdantEvents` — GET on the Verdant secondary calendar
 *     (`UserPreference.verdantCalendarId`). Returns full event objects (id,
 *     start, end). Used only by drift reconciliation, since drift needs to
 *     match live calendar event ids back to stored sessions.
 *
 * Auth: writes/reads through these functions require a valid access token
 * minted with both `calendar.app.created` and `calendar.events.freebusy`
 * scopes. Functions return `{ok: false}` discriminated results on missing
 * token or API failure — callers must distinguish "no events" from "couldn't
 * read" (especially drift, which would otherwise wipe every synced session).
 */

import { toNaiveLocalISO } from "@/lib/google-calendar";

const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const EVENTS_LIST_URL = (calendarId: string): string =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    calendarId
  )}/events`;

/** Opaque external busy interval. No id, no title — FreeBusy doesn't expose them. */
export interface BusyInterval {
  start: Date;
  end: Date;
}

/** Verdant-owned event read from the secondary calendar. Used only by drift. */
export interface VerdantEvent {
  start: Date;
  end: Date;
  /** Google Calendar event id on the Verdant secondary calendar. */
  calendarEventId: string;
}

export interface BusyIntervalsResult {
  /** True when the read succeeded (even if it returned zero intervals). */
  ok: boolean;
  intervals: BusyInterval[];
}

export interface VerdantEventsResult {
  ok: boolean;
  events: VerdantEvent[];
}

const CACHE_TTL_MS = 60_000;

interface BusyCacheEntry {
  expiresAt: number;
  intervals: BusyInterval[];
  ok: boolean;
}
interface VerdantCacheEntry {
  expiresAt: number;
  events: VerdantEvent[];
  ok: boolean;
}

const busyCache = new Map<string, BusyCacheEntry>();
const verdantCache = new Map<string, VerdantCacheEntry>();

function cacheKey(prefix: string, userId: string, from: Date, to: Date): string {
  return `${prefix}|${userId}|${from.toISOString()}|${to.toISOString()}`;
}

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason?: string }> }>;
}

interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}
interface GoogleEvent {
  id: string;
  status?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
}
interface GoogleEventsListResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

export interface GetExternalBusyOptions {
  userId: string;
  accessToken: string | undefined;
  from: Date;
  to: Date;
  /** Bypass the TTL cache. */
  noCache?: boolean;
}

/**
 * Fetch external busy intervals for `userId` on their primary calendar between
 * `from` (inclusive) and `to` (exclusive).
 *
 * Returns `{ ok, intervals }`. `ok = false` means the read was unavailable
 * (no token, scope denied, API error). Callers MUST NOT confuse this with
 * "no events" — e.g. the planner should treat ok=false as "trust nothing"
 * rather than "the user is wide open all week".
 */
export async function getExternalBusy(
  opts: GetExternalBusyOptions
): Promise<BusyIntervalsResult> {
  const { userId, accessToken, from, to, noCache } = opts;
  if (!accessToken) return { ok: false, intervals: [] };
  if (to <= from) return { ok: true, intervals: [] };

  const key = cacheKey("freebusy", userId, from, to);
  const now = Date.now();
  if (!noCache) {
    const hit = busyCache.get(key);
    if (hit && hit.expiresAt > now) {
      return { ok: hit.ok, intervals: hit.intervals };
    }
  }

  try {
    const res = await fetch(FREEBUSY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: "primary" }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`FreeBusy HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    const j = (await res.json()) as FreeBusyResponse;
    const cal = j.calendars?.primary;
    if (cal?.errors && cal.errors.length > 0) {
      throw new Error(
        `FreeBusy reported errors on primary: ${cal.errors
          .map((e) => e.reason ?? "unknown")
          .join(", ")}`
      );
    }
    const intervals: BusyInterval[] = (cal?.busy ?? [])
      .map((b) => {
        const start = new Date(b.start);
        const end = new Date(b.end);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          return null;
        }
        if (end <= start) return null;
        return { start, end };
      })
      .filter((b): b is BusyInterval => b !== null)
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    busyCache.set(key, { expiresAt: now + CACHE_TTL_MS, intervals, ok: true });
    return { ok: true, intervals };
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[getExternalBusy] FreeBusy failed:", err);
    }
    busyCache.set(key, { expiresAt: now + CACHE_TTL_MS, intervals: [], ok: false });
    return { ok: false, intervals: [] };
  }
}

export interface GetVerdantEventsOptions {
  userId: string;
  accessToken: string | undefined;
  /** Verdant secondary calendar id (UserPreference.verdantCalendarId). */
  calendarId: string | null | undefined;
  /**
   * IANA tz the user views events in. GCal returns events with an explicit
   * offset; we convert each back to the same naive-local-Z storage format
   * the packer uses, so drift comparisons against `ScheduledSession.start`
   * are apples-to-apples. Pass `null` to skip the conversion (events come
   * back as their absolute UTC instant — only correct if the consumer is
   * also UTC-naive, which is fragile).
   */
  userTimeZone: string | null | undefined;
  from: Date;
  to: Date;
  noCache?: boolean;
}

/**
 * List events on the Verdant secondary calendar between `from` and `to`.
 * Used by drift reconciliation.
 *
 * If the user hasn't provisioned a Verdant calendar yet (`calendarId` is null
 * or empty), returns `{ ok: true, events: [] }` — there's nothing to drift
 * against, so the schedule is unchanged.
 */
export async function getVerdantEvents(
  opts: GetVerdantEventsOptions
): Promise<VerdantEventsResult> {
  const { userId, accessToken, calendarId, userTimeZone, from, to, noCache } =
    opts;
  if (!accessToken) return { ok: false, events: [] };
  if (!calendarId) return { ok: true, events: [] };
  if (to <= from) return { ok: true, events: [] };

  const key = cacheKey(`verdant:${calendarId}`, userId, from, to);
  const now = Date.now();
  if (!noCache) {
    const hit = verdantCache.get(key);
    if (hit && hit.expiresAt > now) {
      return { ok: hit.ok, events: hit.events };
    }
  }

  const events: VerdantEvent[] = [];
  try {
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await fetch(`${EVENTS_LIST_URL(calendarId)}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          `Verdant calendar list HTTP ${res.status}: ${body.slice(0, 400)}`
        );
      }
      const page = (await res.json()) as GoogleEventsListResponse;
      for (const ev of page.items ?? []) {
        if (ev.status === "cancelled") continue;
        const startISO = ev.start?.dateTime;
        const endISO = ev.end?.dateTime;
        if (!startISO || !endISO) continue;
        const startAbs = new Date(startISO);
        const endAbs = new Date(endISO);
        if (Number.isNaN(startAbs.getTime()) || Number.isNaN(endAbs.getTime()))
          continue;
        if (endAbs <= startAbs) continue;
        // Convert the absolute instant back to the storage convention
        // (naive user-local clock-time tagged with `Z`). Without this,
        // drift comparisons would compare apples (UTC instant from GCal)
        // to oranges (naive-local-Z from the packer).
        const start = userTimeZone
          ? new Date(toNaiveLocalISO(startAbs, userTimeZone))
          : startAbs;
        const end = userTimeZone
          ? new Date(toNaiveLocalISO(endAbs, userTimeZone))
          : endAbs;
        events.push({ start, end, calendarEventId: ev.id });
      }
      pageToken = page.nextPageToken;
      pages++;
    } while (pageToken && pages < 10);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[getVerdantEvents] list failed:", err);
    }
    verdantCache.set(key, { expiresAt: now + CACHE_TTL_MS, events: [], ok: false });
    return { ok: false, events: [] };
  }

  events.sort((a, b) => a.start.getTime() - b.start.getTime());
  verdantCache.set(key, { expiresAt: now + CACHE_TTL_MS, events, ok: true });
  return { ok: true, events };
}

/** Drop cached reads for one user (e.g. after "refresh calendar"). */
export function invalidateBusyIntervalsCacheForUser(userId: string): void {
  for (const key of busyCache.keys()) {
    if (key.includes(`|${userId}|`)) busyCache.delete(key);
  }
  for (const key of verdantCache.keys()) {
    if (key.includes(`|${userId}|`)) verdantCache.delete(key);
  }
}

/** Test/dev helper — clears the in-memory caches. */
export function _clearBusyIntervalsCache(): void {
  busyCache.clear();
  verdantCache.clear();
}

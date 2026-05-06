/**
 * Read-side Google Calendar access for Verdant.
 *
 * Companion to `google-calendar.ts` (write-only). Provides a single chokepoint
 * `getBusyIntervals` that fetches the user's calendar events in a window and
 * returns busy intervals for the planner and packer to consume.
 *
 * Filtering rules (settled in design Q2):
 *   - status === "cancelled"      → skip
 *   - transparency === "transparent" ("free") → skip
 *   - own attendee responseStatus === "declined" → skip
 *   - all-day events (date, no dateTime) → skip
 *   - Verdant-sourced events are tagged on the returned interval but NOT skipped
 *     here; callers decide whether to include them based on per-session lock state.
 *
 * Verdant-sourced detection: events whose description starts with the marker
 * written by `calendarEventDescription` in google-calendar.ts. (Future PR may
 * switch to `extendedProperties.private.verdant` once the writer sets it.)
 */

const CAL_PRIMARY = "primary";
const VERDANT_DESCRIPTION_MARKER = "Verdant";

export interface BusyInterval {
  start: Date;
  end: Date;
  /** Google Calendar event id (always present for events we read). */
  calendarEventId: string;
  /** True if this event was created by Verdant (description marker match). */
  isVerdant: boolean;
}

interface CacheEntry {
  expiresAt: number;
  intervals: BusyInterval[];
  ok: boolean;
}

export interface BusyIntervalsResult {
  /** True when the calendar read succeeded (even if it returned no events). */
  ok: boolean;
  intervals: BusyInterval[];
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(userId: string, from: Date, to: Date): string {
  return `${userId}|${from.toISOString()}|${to.toISOString()}`;
}

interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GoogleAttendee {
  self?: boolean;
  responseStatus?: string;
  email?: string;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  transparency?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  attendees?: GoogleAttendee[];
}

interface GoogleEventsListResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

function isVerdantEvent(ev: GoogleEvent): boolean {
  const desc = ev.description ?? "";
  return desc.trimStart().startsWith(VERDANT_DESCRIPTION_MARKER);
}

function ownDeclined(ev: GoogleEvent): boolean {
  if (!ev.attendees) return false;
  const me = ev.attendees.find((a) => a.self);
  return me?.responseStatus === "declined";
}

function eventToInterval(ev: GoogleEvent): BusyInterval | null {
  if (ev.status === "cancelled") return null;
  if (ev.transparency === "transparent") return null;
  if (ownDeclined(ev)) return null;
  const startISO = ev.start?.dateTime;
  const endISO = ev.end?.dateTime;
  if (!startISO || !endISO) return null; // all-day or malformed
  const start = new Date(startISO);
  const end = new Date(endISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end <= start) return null;
  return {
    start,
    end,
    calendarEventId: ev.id,
    isVerdant: isVerdantEvent(ev),
  };
}

async function fetchEventsPage(
  accessToken: string,
  from: Date,
  to: Date,
  pageToken?: string
): Promise<GoogleEventsListResponse> {
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  if (pageToken) params.set("pageToken", pageToken);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    CAL_PRIMARY
  )}/events?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar list HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  return (await res.json()) as GoogleEventsListResponse;
}

export interface GetBusyIntervalsOptions {
  userId: string;
  accessToken: string | undefined;
  from: Date;
  to: Date;
  /** Bypass the TTL cache. */
  noCache?: boolean;
}

/**
 * Fetch busy intervals for `userId` between `from` (inclusive) and `to` (exclusive).
 *
 * Returns `{ ok, intervals }`. `ok = false` means the calendar read was
 * unavailable (no token, API error, expired credentials). Callers MUST NOT
 * confuse `ok=false` with "no events" — e.g. drift reconciliation should skip
 * when `ok=false` to avoid concluding that every Verdant event was deleted.
 */
export async function getBusyIntervals(
  opts: GetBusyIntervalsOptions
): Promise<BusyIntervalsResult> {
  const { userId, accessToken, from, to, noCache } = opts;
  if (!accessToken) return { ok: false, intervals: [] };
  if (to <= from) return { ok: true, intervals: [] };

  const key = cacheKey(userId, from, to);
  const now = Date.now();
  if (!noCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      return { ok: hit.ok, intervals: hit.intervals };
    }
  }

  const intervals: BusyInterval[] = [];
  try {
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await fetchEventsPage(accessToken, from, to, pageToken);
      for (const ev of page.items ?? []) {
        const iv = eventToInterval(ev);
        if (iv) intervals.push(iv);
      }
      pageToken = page.nextPageToken;
      pages++;
    } while (pageToken && pages < 10);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[getBusyIntervals] calendar read failed:", err);
    }
    // Cache the failure briefly so we don't hammer Google when token is bad.
    cache.set(key, { expiresAt: now + CACHE_TTL_MS, intervals: [], ok: false });
    return { ok: false, intervals: [] };
  }

  intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, intervals, ok: true });
  return { ok: true, intervals };
}

/** Drop cached Google reads for one user (e.g. after “refresh calendar”). */
export function invalidateBusyIntervalsCacheForUser(userId: string): void {
  const prefix = `${userId}|`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Test/dev helper — clears the in-memory cache. */
export function _clearBusyIntervalsCache(): void {
  cache.clear();
}

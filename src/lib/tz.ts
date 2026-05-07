/**
 * Timezone-aware date helpers used everywhere we need to render or compare
 * times in the user's local zone instead of the server's. The server runs in
 * UTC on Vercel; without these, every `getDay()` / `getHours()` call against a
 * stored ISO returns UTC-day / UTC-hour, which is the root cause of the
 * "session jumped to a grayed-out time on a different day" symptom on the
 * schedule grid.
 *
 * All formatting goes through `Intl.DateTimeFormat`. DST transitions and
 * non-standard offsets are handled correctly because we never carry a
 * wall-clock time across the offset boundary.
 */

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "YYYY-MM-DD" of `d` as observed in `tz`. */
export function ymdInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** "HH:mm" (24h) of `d` as observed in `tz`. */
export function hmInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** Short weekday name ("Mon") of `d` as observed in `tz`. */
export function dowShortInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(d);
}

/** Mon=0..Sun=6 weekday index of `d` as observed in `tz`. */
export function dowMonZeroInTz(d: Date, tz: string): number {
  const short = dowShortInTz(d, tz);
  const sunZero = DOW_SHORT.indexOf(short);
  if (sunZero < 0) return 0;
  return (sunZero + 6) % 7;
}

/** Sun=0..Sat=6 weekday index of `d` as observed in `tz`. Mirrors JS Date.getDay. */
export function dowSunZeroInTz(d: Date, tz: string): number {
  const short = dowShortInTz(d, tz);
  const idx = DOW_SHORT.indexOf(short);
  return idx < 0 ? 0 : idx;
}

/** Hour (0–23) of `d` as observed in `tz`. */
export function hourInTz(d: Date, tz: string): number {
  const hh = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).format(d);
  // "24" can show up at the local stroke of midnight in some locales — fold to 0.
  const n = parseInt(hh, 10);
  return Number.isFinite(n) ? (n === 24 ? 0 : n) : 0;
}

/** Minute (0–59) of `d` as observed in `tz`. */
export function minuteInTz(d: Date, tz: string): number {
  const mm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    minute: "2-digit",
    hour12: false,
  }).format(d);
  const n = parseInt(mm, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Local-tz minutes-from-midnight of `d` (i.e. hour*60 + minute, in tz). */
export function localMinutesInTz(d: Date, tz: string): number {
  return hourInTz(d, tz) * 60 + minuteInTz(d, tz);
}

/**
 * Convert a tz-local wall-clock (`YYYY-MM-DD` + `HH:mm`) to the corresponding
 * UTC ISO string. Probes the offset for that instant via `Intl` so DST
 * transitions resolve to the correct side. Returns null on malformed input.
 */
export function localWallClockToUtcIso(
  date: string,
  time: string,
  tz: string
): string | null {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  if (![y, mo, d, h, mi].every(Number.isFinite)) return null;
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const partsFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = partsFmt.formatToParts(new Date(utcGuess));
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  const tzWallMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    0
  );
  const offsetMs = tzWallMs - utcGuess;
  return new Date(utcGuess - offsetMs).toISOString();
}

/**
 * Add `days` to a `YYYY-MM-DD` string. Pure date arithmetic; DST-safe because
 * we operate on the date string, not on a Date instance with a wall time.
 */
export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Find the YYYY-MM-DD of Monday of the week containing `d`, observed in `tz`.
 * Used by the schedule grid so the user's "this week" maps to their local
 * Mon→Sun, regardless of where the server is.
 */
export function mondayYmdInTz(d: Date, tz: string): string {
  const todayYmd = ymdInTz(d, tz);
  const dow = dowMonZeroInTz(d, tz); // Mon=0..Sun=6
  return addDaysYmd(todayYmd, -dow);
}

/**
 * UTC instant of tz-local midnight on the calendar day containing `d`. The
 * scheduler uses this in place of date-fns `startOfDay` so day boundaries
 * follow the user's wall clock rather than the server's.
 */
export function startOfDayInTz(d: Date, tz: string): Date {
  const ymd = ymdInTz(d, tz);
  const iso = localWallClockToUtcIso(ymd, "00:00", tz);
  return iso ? new Date(iso) : d;
}

/**
 * Add `days` to `d` in the user's tz, preserving the local wall-clock
 * time-of-day across DST transitions. Equivalent to date-fns `addDays` when
 * tz matches the server, but DST-correct everywhere else.
 */
export function addDaysInTz(d: Date, days: number, tz: string): Date {
  const ymd = ymdInTz(d, tz);
  const time = hmInTz(d, tz);
  const newYmd = addDaysYmd(ymd, days);
  const iso = localWallClockToUtcIso(newYmd, time, tz);
  return iso ? new Date(iso) : new Date(d.getTime() + days * 86_400_000);
}

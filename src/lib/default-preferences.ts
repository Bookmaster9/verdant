import type { TimeWindow, TimeWindows } from "@/types/plan";

/**
 * Default mask: 06:00 → midnight, every day. Anything between midnight and
 * 6am is opted-out by default (sleep). Users opt back in via the heatmap.
 * Keys are `Date.getDay()` indices (Sun=0..Sat=6).
 */
const DEFAULT_DAY_WINDOWS = [{ start: "06:00", end: "24:00" }];
export const DEFAULT_TIME_WINDOWS: TimeWindows = {
  "0": DEFAULT_DAY_WINDOWS,
  "1": DEFAULT_DAY_WINDOWS,
  "2": DEFAULT_DAY_WINDOWS,
  "3": DEFAULT_DAY_WINDOWS,
  "4": DEFAULT_DAY_WINDOWS,
  "5": DEFAULT_DAY_WINDOWS,
  "6": DEFAULT_DAY_WINDOWS,
};

export function defaultTimeWindowsJson(): string {
  return JSON.stringify(DEFAULT_TIME_WINDOWS);
}

function isWindowLike(v: unknown): v is TimeWindow {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { start?: unknown }).start === "string" &&
    typeof (v as { end?: unknown }).end === "string"
  );
}

/**
 * Normalize an arbitrary parsed `timeWindows` blob into the canonical
 * `Record<dayKey, TimeWindow[]>` shape. Tolerates the legacy single-window
 * shape (`{start, end}`) and drops anything malformed. Used at every read
 * boundary so DB rows written before the array migration still load cleanly.
 */
export function normalizeTimeWindows(raw: unknown): TimeWindows {
  if (!raw || typeof raw !== "object") return {};
  const out: TimeWindows = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      const list = v.filter(isWindowLike);
      if (list.length > 0) out[k] = list;
      continue;
    }
    if (isWindowLike(v)) {
      out[k] = [v];
    }
  }
  return out;
}

/** JSON.parse + normalize. Returns `{}` for empty / invalid JSON. */
export function parseTimeWindowsJson(raw: string | null | undefined): TimeWindows {
  if (!raw) return {};
  try {
    return normalizeTimeWindows(JSON.parse(raw));
  } catch {
    return {};
  }
}

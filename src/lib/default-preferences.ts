import type { TimeWindow, TimeWindows } from "@/types/plan";

/** Mon–Fri 7–10p, Sat 10–1, Sun 3–6p */
export const DEFAULT_TIME_WINDOWS: TimeWindows = {
  "0": [{ start: "15:00", end: "18:00" }],
  "1": [{ start: "19:00", end: "22:00" }],
  "2": [{ start: "19:00", end: "22:00" }],
  "3": [{ start: "19:00", end: "22:00" }],
  "4": [{ start: "19:00", end: "22:00" }],
  "5": [{ start: "19:00", end: "22:00" }],
  "6": [{ start: "10:00", end: "13:00" }],
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

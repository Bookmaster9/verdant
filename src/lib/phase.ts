/**
 * Map a task's weekIndex to a phase index.
 *
 * When `planWeeks` is provided, buckets are sized to the actual plan length
 * (`ceil(planWeeks / totalPhases)`), so a 4-phase 8-week plan gets 2-week
 * buckets and every phase has tasks. Without `planWeeks`, falls back to the
 * legacy 16-week assumption for callers that don't have plan duration handy.
 */
export function phaseForWeek(
  weekIndex: number,
  totalPhases: number,
  planWeeks?: number
): number {
  if (totalPhases <= 0) return 0;
  const span =
    planWeeks && planWeeks > 0 ? planWeeks : 16;
  const bucket = Math.floor(
    weekIndex / Math.max(1, Math.ceil(span / totalPhases))
  );
  return Math.max(0, Math.min(totalPhases - 1, bucket));
}

/**
 * Defensive display title — falls back to a typed placeholder when the
 * upstream value is empty/whitespace, so a row never renders blank.
 */
export function displayTitle(
  title: string | null | undefined,
  type: "lesson" | "review" | "milestone"
): string {
  const t = (title ?? "").trim();
  if (t) return t;
  return type === "milestone"
    ? "Milestone session"
    : type === "review"
      ? "Review session"
      : "Lesson session";
}

/**
 * Best-effort YouTube video ID extraction from a URL/string.
 * Supports:
 *   - bare 11-char ids
 *   - youtu.be/<id>
 *   - youtube.com/watch?...v=<id>...
 *   - youtube.com/embed/<id>
 *   - youtube.com/v/<id>
 *   - youtube.com/shorts/<id>
 *   - youtube.com/live/<id>
 *   - m.youtube.com / music.youtube.com
 */
export function youtubeId(input: string | null | undefined): string | null {
  if (!input) return null;
  const url = input.trim();
  if (!url) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  const m = url.match(
    /(?:(?:m|music|www)\.)?youtube\.com\/(?:embed\/|watch\?(?:[^#&\s]*&)*v=|v\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/
  );
  if (m) return m[1];
  const short = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  return short ? short[1] : null;
}

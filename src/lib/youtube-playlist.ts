import type { PlanTask, SproutPlan } from "@/types/plan";
import { youtubeId } from "@/lib/phase";

/**
 * Extract YouTube playlist id from common URL shapes:
 * - https://www.youtube.com/playlist?list=PLxxx
 * - https://www.youtube.com/watch?v=abcd&list=PLxxx
 */
export function extractYoutubePlaylistId(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    const host = u.hostname.replace(/^www\./, "");
    if (
      !host.includes("youtube.com") &&
      !host.includes("youtube-nocookie.com") &&
      host !== "youtu.be"
    ) {
      return null;
    }
    const list = u.searchParams.get("list");
    if (list && list.length >= 13) return list;
    return null;
  } catch {
    return null;
  }
}

export function findYoutubePlaylistIdInResources(urls: string[]): string | null {
  for (const u of urls) {
    const id = extractYoutubePlaylistId(u);
    if (id) return id;
  }
  return null;
}

const MAX_PLAYLIST_ITEMS = 200;

/** Parse YouTube contentDetails.duration (ISO 8601, e.g. PT15M33S) to seconds. */
export function iso8601DurationToSeconds(iso: string): number {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const sec = Number(m[3] || 0);
  return h * 3600 + min * 60 + sec;
}

/**
 * Whole-minute length of the video (rounded up), for scheduling.
 * e.g. 61 seconds → 2 minutes.
 */
export function youtubeDurationToWholeMinutes(isoDuration: string): number {
  const sec = iso8601DurationToSeconds(isoDuration);
  if (sec <= 0) return 1;
  return Math.max(1, Math.ceil(sec / 60));
}

/**
 * videos.list — returns video id → length in whole minutes (ceiling).
 */
export async function fetchYoutubeVideoLengthMinutesById(
  videoIds: string[],
  apiKey: string
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(videoIds)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const params = new URLSearchParams({
      part: "contentDetails",
      id: chunk.join(","),
      key: apiKey,
    });
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`
    );
    const json = (await res.json()) as {
      items?: Array<{ id: string; contentDetails?: { duration?: string } }>;
      error?: { message?: string };
    };
    if (!res.ok) {
      const msg =
        json.error?.message ??
        `YouTube videos.list HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`;
      throw new Error(msg);
    }
    for (const item of json.items ?? []) {
      const dur = item.contentDetails?.duration;
      if (!item.id || !dur) continue;
      out.set(item.id, youtubeDurationToWholeMinutes(dur));
    }
  }
  return out;
}

/**
 * For each **lesson** with a YouTube URL in `resourceRef`, set `minutes` to
 * (video length in whole minutes, rounded up) + 5, clamped to [5, 120].
 * Requires `YOUTUBE_API_KEY`. Missing/failed lookups leave `minutes` unchanged.
 */
export async function applyYoutubeVideoLengthsToLessonMinutes(
  tasks: PlanTask[],
  apiKey: string
): Promise<PlanTask[]> {
  const ids: string[] = [];
  for (const t of tasks) {
    if (t.type !== "lesson" || !t.resourceRef) continue;
    const id = youtubeId(t.resourceRef);
    if (id) ids.push(id);
  }
  if (ids.length === 0) return tasks;

  let lengths: Map<string, number>;
  try {
    lengths = await fetchYoutubeVideoLengthMinutesById(ids, apiKey);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[applyYoutubeVideoLengthsToLessonMinutes]", err);
    }
    return tasks;
  }

  return tasks.map((t) => {
    if (t.type !== "lesson" || !t.resourceRef) return t;
    const id = youtubeId(t.resourceRef);
    if (!id) return t;
    const vm = lengths.get(id);
    if (vm === undefined) return t;
    const sessionMin = Math.min(120, Math.max(5, vm + 5));
    return { ...t, minutes: sessionMin };
  });
}

/**
 * Page through playlistItems.list (YouTube Data API v3).
 * Requires `YOUTUBE_API_KEY` with YouTube Data API v3 enabled for the project.
 */
export async function fetchYoutubePlaylistVideoIds(
  playlistId: string,
  apiKey: string
): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      part: "contentDetails",
      playlistId,
      maxResults: "50",
      key: apiKey,
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`;
    const res = await fetch(url);
    const json = (await res.json()) as {
      items?: Array<{ contentDetails?: { videoId?: string } }>;
      nextPageToken?: string;
      error?: { message?: string };
    };

    if (!res.ok) {
      const msg =
        json.error?.message ??
        `YouTube API HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`;
      throw new Error(msg);
    }

    for (const item of json.items ?? []) {
      const vid = item.contentDetails?.videoId;
      if (vid) out.push(vid);
      if (out.length >= MAX_PLAYLIST_ITEMS) return out;
    }

    pageToken = json.nextPageToken;
  } while (pageToken && out.length < MAX_PLAYLIST_ITEMS);

  return out;
}

/** Lessons in curriculum order: week, day-of-week, then stable task order. */
function lessonTasksInPlanOrder(tasks: PlanTask[]): PlanTask[] {
  const indexById = new Map(tasks.map((t, i) => [t.id, i]));
  const lessons = tasks.filter((t) => t.type === "lesson");
  lessons.sort((a, b) => {
    if (a.weekIndex !== b.weekIndex) return a.weekIndex - b.weekIndex;
    if (a.dayOffsetInWeek !== b.dayOffsetInWeek)
      return a.dayOffsetInWeek - b.dayOffsetInWeek;
    return (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0);
  });
  return lessons;
}

/**
 * Assign watch URLs to each lesson task in order; if there are more lessons than
 * videos, cycle through the playlist.
 */
export function assignPlaylistVideosToLessonTasks(
  tasks: PlanTask[],
  videoIds: string[]
): PlanTask[] {
  if (videoIds.length === 0) return tasks;
  const orderedLessons = lessonTasksInPlanOrder(tasks);
  const refById = new Map<string, string>();
  orderedLessons.forEach((lesson, i) => {
    const vid = videoIds[i % videoIds.length];
    refById.set(lesson.id, `https://www.youtube.com/watch?v=${vid}`);
  });
  return tasks.map((t) => {
    if (t.type !== "lesson") return t;
    const ref = refById.get(t.id);
    return ref ? { ...t, resourceRef: ref } : t;
  });
}

/**
 * When `initialResources` contains a playlist URL, fetch video ids and set each
 * lesson task's `resourceRef` to the next video in playlist order.
 */
export async function enrichSproutWithYoutubePlaylist(
  sprout: SproutPlan,
  initialResources: string[]
): Promise<SproutPlan> {
  const playlistId = findYoutubePlaylistIdInResources(initialResources);
  if (!playlistId) return sprout;

  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "YOUTUBE_API_KEY is required when you include a YouTube playlist URL. Add it to .env and enable YouTube Data API v3 for your Google Cloud project."
    );
  }

  const ids = await fetchYoutubePlaylistVideoIds(playlistId, key);
  if (ids.length === 0) {
    throw new Error(
      "Could not load videos from that playlist. Use a public playlist and check the URL."
    );
  }

  return {
    ...sprout,
    tasks: assignPlaylistVideosToLessonTasks(sprout.tasks, ids),
  };
}

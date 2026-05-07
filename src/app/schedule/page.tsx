import { auth } from "@/auth";
import { Shell } from "@/components/Shell";
import { prisma } from "@/lib/db";
import { getExternalBusy } from "@/lib/calendar-read";
import { ensureUserPreferences } from "@/lib/user";
import { redirect } from "next/navigation";
import { format, addDays, parseISO } from "date-fns";
import type { ScheduledSession, FernNote } from "@/types/plan";
import { parseTimeWindowsJson } from "@/lib/default-preferences";
import { dedupeScheduleById } from "@/lib/scoring-pack";
import {
  type VerdantBlock,
  type ExternalBlock,
} from "@/components/verdant/WeekGrid";
import { ForestSprite } from "@/components/verdant/art";
import { displayTitle } from "@/lib/phase";
import { ScheduleHeader } from "./ScheduleHeader";
import { ScheduleClient } from "./ScheduleClient";
import {
  addDaysYmd,
  dowMonZeroInTz,
  localMinutesInTz,
  localWallClockToUtcIso,
  mondayYmdInTz,
} from "@/lib/tz";

// Schedule state mutates from the sprout page (regenerate / rebalance /
// reoptimize / NL edits / move-session). Force this route dynamic so a
// navigation here always re-renders against the latest scheduleJson rather
// than potentially serving a cached RSC payload from before the mutation.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ w?: string }>;

const VISIBLE_FIRST_HOUR = 0; // matches WeekGrid
const VISIBLE_LAST_HOUR = 24;

/**
 * Clamp a [start, end] interval to the visible band on its source day,
 * computing wall-clock minutes in the user's timezone (NOT the server's).
 * Without `tz`, every block on Vercel rendered against UTC and night-time
 * sessions appeared on the next calendar day in a grayed-out band.
 */
function clampToVisible(
  startDate: Date,
  endDate: Date,
  tz: string
): { startMin: number; endMin: number } | null {
  const startMin = Math.max(VISIBLE_FIRST_HOUR * 60, localMinutesInTz(startDate, tz));
  const endMin = Math.min(VISIBLE_LAST_HOUR * 60, localMinutesInTz(endDate, tz));
  if (endMin <= startMin) return null;
  return { startMin, endMin };
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const s = await auth();
  if (!s?.user?.id) redirect("/login");

  const sp = await searchParams;
  const weekOffset = Number.isFinite(Number(sp.w)) ? Number(sp.w) : 0;

  // Active plan (single-plan MVP); also pull all of the user's plans so the
  // sprout filter chips read meaningfully when there are several.
  const [plans, pref] = await Promise.all([
    prisma.learningPlan.findMany({
      where: { userId: s.user.id, status: "active" },
      orderBy: { createdAt: "desc" },
    }),
    ensureUserPreferences(s.user.id),
  ]);

  const timeWindows = parseTimeWindowsJson(pref.timeWindows);

  // Anchor week start = Monday of the requested week, computed in the user's
  // timezone. Without this, the server (UTC on Vercel) would compute the wrong
  // Monday for users far from UTC and a session at user-local Mon 11pm could
  // fall outside the [monday, sunday) range and disappear from the grid.
  const tz = pref.userTimeZone || "UTC";
  const today = new Date();
  const baseMondayYmd = mondayYmdInTz(today, tz);
  const mondayYmd = addDaysYmd(baseMondayYmd, weekOffset * 7);
  const sundayYmd = addDaysYmd(mondayYmd, 7);
  // mondayISO / sundayDate are the UTC instants corresponding to local
  // midnight on those calendar days in user tz. Used for date-range filtering
  // and as the anchor passed to the client-side `WeekGrid`.
  const mondayIsoStr = localWallClockToUtcIso(mondayYmd, "00:00", tz)
    ?? `${mondayYmd}T00:00:00.000Z`;
  const monday = new Date(mondayIsoStr);
  const sundayIsoStr = localWallClockToUtcIso(sundayYmd, "00:00", tz)
    ?? `${sundayYmd}T00:00:00.000Z`;
  const sunday = new Date(sundayIsoStr);

  // External busy intervals across the visible week (whole-day window).
  // Verdant sessions are sourced separately from `plan.scheduleJson`; the
  // FreeBusy read on primary already excludes them.
  const busy = await getExternalBusy({
    userId: s.user.id,
    accessToken: s.accessToken,
    from: monday,
    to: sunday,
  });

  const now = new Date();

  // Verdant sessions across all active plans, filtered to this week.
  const verdant: VerdantBlock[] = [];
  for (const plan of plans) {
    const sessions = dedupeScheduleById(
      JSON.parse(plan.scheduleJson || "[]") as ScheduledSession[]
    );
    for (const sess of sessions) {
      const start = parseISO(sess.start);
      const end = parseISO(sess.end);
      if (start < monday || start >= sunday) continue;
      const clamped = clampToVisible(start, end, tz);
      if (!clamped) continue;
      const taskId =
        sess.agenda && sess.agenda.length > 0
          ? sess.agenda[0].planTaskId
          : sess.planTaskId;
      verdant.push({
        id: sess.id,
        planId: plan.id,
        dayIndex: dowMonZeroInTz(start, tz),
        startMin: clamped.startMin,
        endMin: clamped.endMin,
        startISO: sess.start,
        endISO: sess.end,
        title: displayTitle(sess.title, sess.type),
        sproutTitle: plan.title,
        type: sess.type,
        locked: !!sess.locked,
        googleSynced: !!sess.googleSynced,
        pastImmovable: end < now,
        href: taskId
          ? `/plan/${plan.id}/session/${taskId}`
          : `/plan/${plan.id}`,
      });
    }
  }

  // External (non-Verdant) busy events for the week. FreeBusy on primary
  // returns only intervals — no titles or ids — and already excludes events
  // on the Verdant secondary calendar.
  const external: ExternalBlock[] = [];
  for (const iv of busy.intervals) {
    if (iv.start < monday || iv.start >= sunday) continue;
    const clamped = clampToVisible(iv.start, iv.end, tz);
    if (!clamped) continue;
    external.push({
      dayIndex: dowMonZeroInTz(iv.start, tz),
      startMin: clamped.startMin,
      endMin: clamped.endMin,
      title: "Calendar event",
    });
  }

  // Day labels read from each day's calendar date in the user's tz, so labels
  // match the column the block is rendered in. addDays on a UTC midnight
  // anchor + format would print the right day name only by coincidence when
  // the server's tz is close to the user's.
  const dateLabels = Array.from({ length: 7 }).map((_, i) => {
    const ymd = addDaysYmd(mondayYmd, i);
    return format(parseISO(`${ymd}T12:00:00Z`), "MMM d");
  });

  // todayIndex only when this week contains today (in user tz).
  const todayIdx =
    today >= monday && today < sunday ? dowMonZeroInTz(today, tz) : null;

  // First Fern note across plans → suggestion banner. Decorative when absent.
  let bannerNote: FernNote | null = null;
  for (const p of plans) {
    const notes = JSON.parse(p.fernNotes || "[]") as FernNote[];
    if (notes.length > 0) {
      bannerNote = notes[0];
      break;
    }
  }

  const sproutFilters = plans.map((p) => ({
    id: p.id,
    title: p.title,
    color: "var(--leaf-pale)" as const,
  }));

  const headerLabel = `${format(monday, "MMM d")} – ${format(
    addDays(monday, 6),
    "MMM d"
  )}`;

  // Plan-window bounds: earliest startDate, latest deadline across active plans.
  // The grid uses these for chevron-drop bounds checking.
  let earliestStart: Date | null = null;
  let latestDeadline: Date | null = null;
  for (const p of plans) {
    if (!earliestStart || p.startDate < earliestStart) earliestStart = p.startDate;
    if (!latestDeadline || p.deadline > latestDeadline) latestDeadline = p.deadline;
  }
  const startDateISO = (earliestStart ?? monday).toISOString();
  const deadlineISO = (
    latestDeadline ?? new Date(monday.getTime() + 365 * 86_400_000)
  ).toISOString();

  return (
    <Shell>
      <div style={{ padding: "12px 36px 60px" }}>
        <ScheduleHeader
          weekOffset={weekOffset}
          label={headerLabel}
          calendarConnected={busy.ok}
          activePlanIds={plans.map((p) => p.id)}
        />

        {bannerNote && (
          <div
            className="ink-card"
            style={{
              marginBottom: 14,
              padding: 16,
              background: "var(--leaf-pale)",
              position: "relative",
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: 16,
              alignItems: "center",
            }}
          >
            <ForestSprite size={56} />
            <div>
              <div className="tag" style={{ marginBottom: 2 }}>
                {bannerNote.kicker}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-fraunces)",
                  fontSize: 15,
                  lineHeight: 1.35,
                  color: "var(--ink)",
                }}
              >
                {bannerNote.body}
              </div>
            </div>
          </div>
        )}

        {plans.length === 0 ? (
          <div
            className="dotted"
            style={{
              padding: 48,
              textAlign: "center",
              color: "var(--ink-faded)",
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
            }}
          >
            no active sprouts. plant one to see your week.
          </div>
        ) : (
          <ScheduleClient
            verdant={verdant}
            external={external}
            timeWindows={timeWindows}
            mondayISO={monday.toISOString()}
            startDateISO={startDateISO}
            deadlineISO={deadlineISO}
            weekOffset={weekOffset}
            dateLabels={dateLabels}
            todayIndex={todayIdx}
            sproutFilters={sproutFilters.map((f) => ({ id: f.id, title: f.title }))}
          />
        )}
      </div>
    </Shell>
  );
}

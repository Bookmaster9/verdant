import { auth } from "@/auth";
import { Shell } from "@/components/Shell";
import { prisma } from "@/lib/db";
import { ensureUserPreferences } from "@/lib/user";
import type { SproutPlan, ScheduledSession } from "@/types/plan";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  format,
  parseISO,
  differenceInCalendarDays,
  isSameDay,
  startOfDay,
  addDays,
} from "date-fns";
import { getExternalBusy } from "@/lib/calendar-read";
import { Sprout, CalendarIcon } from "@/components/verdant/art";
import type { TimelineEvent } from "@/components/verdant/TodayTimeline";
import { DashboardTimelinePanel } from "@/components/verdant/DashboardTimelinePanel";
import { CalendarRefreshButton } from "@/components/verdant/CalendarRefreshButton";
import {
  LegacyEventsBanner,
  ScopeIssueBanner,
} from "@/components/verdant/CalendarMigrationBanner";
import { Greeting } from "@/components/verdant/Greeting";
import { displayTitle } from "@/lib/phase";
import {
  SproutGrid,
  type SortMode,
  type SproutGridItem,
} from "@/components/verdant/SproutGrid";
import { colorForSprout } from "@/lib/sprout-color";

function timeOfDay(iso: string) {
  return format(parseISO(iso), "HH:mm");
}

function classifyType(t: string): TimelineEvent["type"] {
  if (t === "review") return "verdant-review";
  if (t === "milestone") return "verdant-milestone";
  return "verdant-lesson";
}

/** Matches `TodayTimeline` hour rail (7–22). */
const TIMELINE_START_MIN = 7 * 60;
const TIMELINE_END_MIN = 22 * 60;

/** Clip [start,end) to today's calendar day in local time. */
function clipToToday(
  start: Date,
  end: Date,
  today: Date
): { start: Date; end: Date } | null {
  const day0 = startOfDay(today);
  const day1 = addDays(day0, 1);
  const lo = start < day0 ? day0 : start;
  const hi = end > day1 ? day1 : end;
  if (hi <= lo) return null;
  return { start: lo, end: hi };
}

/** Clip to the visible timeline band; supports intervals that cross local midnight. */
function clipToTimelineBand(start: Date, end: Date): { start: Date; end: Date } | null {
  const day0 = startOfDay(start);
  const startMinFromMidnight = (start.getTime() - day0.getTime()) / 60_000;
  const durationMin = (end.getTime() - start.getTime()) / 60_000;
  if (durationMin <= 0) return null;
  let sm = startMinFromMidnight;
  let em = startMinFromMidnight + durationMin;
  sm = Math.max(sm, TIMELINE_START_MIN);
  em = Math.min(em, TIMELINE_END_MIN);
  if (em <= sm) return null;
  return {
    start: new Date(day0.getTime() + sm * 60_000),
    end: new Date(day0.getTime() + em * 60_000),
  };
}

// Dashboard's "Today's plot" sources Verdant + calendar events live; force
// dynamic so a schedule mutation elsewhere is reflected on the next visit.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const s = await auth();
  if (!s?.user?.id) {
    redirect("/login");
  }
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = addDays(todayStart, 1);

  const [plans, pref, busyToday] = await Promise.all([
    prisma.learningPlan.findMany({
      where: { userId: s.user.id, status: "active" },
      orderBy: { createdAt: "desc" },
    }),
    ensureUserPreferences(s.user.id),
    getExternalBusy({
      userId: s.user.id,
      accessToken: s.accessToken,
      from: todayStart,
      to: todayEnd,
    }),
  ]);
  const pushToCalendar = pref.pushToCalendar;

  // No active sprouts: keep the welcome state from before.
  if (plans.length === 0) {
    const showLegacyBannerEmpty = pref.legacyVerdantEventsAckAt === null;
    const scopeIssueEmpty = pref.calendarScopeIssue ?? null;
    return (
      <Shell>
        <div style={{ padding: "12px 36px 60px" }}>
          {scopeIssueEmpty && <ScopeIssueBanner issue={scopeIssueEmpty} />}
          {showLegacyBannerEmpty && <LegacyEventsBanner />}
          <div className="tag">welcome</div>
          <h1
            className="serif-display"
            style={{
              fontSize: 56,
              margin: "4px 0 6px",
              fontWeight: 400,
              letterSpacing: "-0.02em",
            }}
          >
            <Greeting name={s.user.name?.split(" ")[0] || "friend"} />
          </h1>
          <p
            className="hand"
            style={{ fontSize: 15, color: "var(--ink-soft)", margin: "0 0 28px" }}
          >
            no sprouts in the soil yet — let&apos;s plant your first.
          </p>
          <div
            className="dotted"
            style={{
              padding: 48,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              color: "var(--ink-faded)",
              maxWidth: 520,
            }}
          >
            <Sprout size={120} growth={0.05} mood="sleepy" />
            <div className="hand" style={{ fontSize: 18, color: "var(--ink-soft)" }}>
              an empty plot
            </div>
            <p
              style={{
                margin: 0,
                textAlign: "center",
                fontSize: 14,
                color: "var(--ink-faded)",
              }}
            >
              You don&apos;t have an active sprout yet. Plant a goal and we&apos;ll
              schedule it into your week.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
              <Link href="/plan/new" className="btn primary">
                plant a sprout →
              </Link>
              {!pushToCalendar && (
                <Link href="/settings#calendars" className="btn">
                  <CalendarIcon size={16} /> turn on calendar push
                </Link>
              )}
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  // Pull all completion records for these plans in one query.
  const completions = await prisma.taskCompletion.findMany({
    where: { planId: { in: plans.map((p) => p.id) } },
  });
  const doneByPlan = new Map<string, Set<string>>();
  for (const c of completions) {
    if (!c.completed) continue;
    const set = doneByPlan.get(c.planId) ?? new Set<string>();
    set.add(c.taskId);
    doneByPlan.set(c.planId, set);
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Build per-sprout grid items + collect today's events + weekly minutes,
  // all aggregated across plans in one pass.
  const items: SproutGridItem[] = [];
  const events: TimelineEvent[] = [];
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday

  // dayMins: per-weekday total minutes; perPlanDayMins: same broken down by plan
  // so the bar can show stacked color contributions.
  const dayMins = [0, 0, 0, 0, 0, 0, 0];
  const perPlanDayMins = new Map<string, number[]>();
  let upcomingCount = 0;

  for (const plan of plans) {
    const sprout: SproutPlan = JSON.parse(plan.planJson) as SproutPlan;
    const schedule: ScheduledSession[] = JSON.parse(
      plan.scheduleJson || "[]"
    ) as ScheduledSession[];
    const done = doneByPlan.get(plan.id) ?? new Set<string>();
    const totalTasks = sprout.tasks?.length || schedule.length || 1;
    const doneCount = sprout.tasks?.filter((t) => done.has(t.id)).length || 0;
    const growth = Math.max(0.05, Math.min(1, doneCount / totalTasks));
    const daysToBloom = Math.max(
      0,
      differenceInCalendarDays(new Date(plan.deadline), now)
    );
    const tags = (plan.targetSkill || plan.title)
      .split(/[\s,/–-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((t) => t.toLowerCase());
    items.push({
      id: plan.id,
      title: plan.title,
      summary: sprout.summary,
      growth,
      daysToBloom,
      tags,
      mood: growth < 0.2 ? "sleepy" : "happy",
      createdAtISO: plan.createdAt.toISOString(),
      deadlineISO: plan.deadline.toISOString(),
    });

    // Today's events (across all sprouts).
    for (const row of schedule) {
      const start = parseISO(row.start);
      const end = parseISO(row.end);
      if (isSameDay(start, now)) {
        const taskId =
          row.agenda && row.agenda.length > 0
            ? row.agenda[0].planTaskId
            : row.planTaskId;
        events.push({
          id: row.id,
          title: displayTitle(row.title, row.type),
          sprout: plan.title,
          type: classifyType(row.type),
          start: timeOfDay(row.start),
          end: timeOfDay(row.end),
          href: taskId ? `/plan/${plan.id}/session/${taskId}` : undefined,
          planId: plan.id,
        });
      }
      if (end >= now) upcomingCount++;
      // Weekly rhythm: minutes per weekday in the current week.
      const idx = (start.getDay() + 6) % 7; // Mon=0
      const diffDays = differenceInCalendarDays(start, weekStart);
      if (diffDays >= 0 && diffDays < 7) {
        const minutes = Math.max(0, (end.getTime() - start.getTime()) / 60_000);
        dayMins[idx] += minutes;
        const arr = perPlanDayMins.get(plan.id) ?? [0, 0, 0, 0, 0, 0, 0];
        arr[idx] += minutes;
        perPlanDayMins.set(plan.id, arr);
      }
    }
  }

  // External Google Calendar meetings (same source as the schedule week grid).
  // FreeBusy already excludes Verdant-owned events, so no filter needed.
  let extCounter = 0;
  for (const iv of busyToday.intervals) {
    const todayClip = clipToToday(iv.start, iv.end, now);
    if (!todayClip) continue;
    const band = clipToTimelineBand(todayClip.start, todayClip.end);
    if (!band) continue;
    events.push({
      id: `gcal-${extCounter++}`,
      title: "Calendar event",
      type: "ext",
      start: format(band.start, "HH:mm"),
      end: format(band.end, "HH:mm"),
    });
  }

  // Sort today's events chronologically across all sprouts.
  events.sort((a, b) => a.start.localeCompare(b.start));

  // Up next: next future event today.
  const futureToday = events.filter((e) => {
    const [h, m] = e.start.split(":").map(Number);
    return h * 60 + m >= nowMinutes;
  });
  const upNext = futureToday[0];

  const maxMins = Math.max(140, ...dayMins);
  const dayLabels = ["M", "T", "W", "T", "F", "S", "S"];
  const niceDay = format(now, "EEEE, MMMM d");

  const showLegacyBanner = pref.legacyVerdantEventsAckAt === null;
  const scopeIssue = pref.calendarScopeIssue ?? null;

  return (
    <Shell>
      <div style={{ padding: "12px 36px 60px" }}>
        {scopeIssue && <ScopeIssueBanner issue={scopeIssue} />}
        {showLegacyBanner && <LegacyEventsBanner />}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            alignItems: "end",
            gap: 24,
            marginBottom: 24,
          }}
        >
          <div>
            <div className="tag">{niceDay.toUpperCase()}</div>
            <h1
              className="serif-display"
              style={{
                fontSize: 56,
                margin: "4px 0 6px",
                fontWeight: 400,
                letterSpacing: "-0.02em",
              }}
            >
              <Greeting name={s.user.name?.split(" ")[0] || "friend"} />
            </h1>
            <p
              className="hand"
              style={{ fontSize: 15, color: "var(--ink-soft)", margin: 0 }}
            >
              {events.length === 0
                ? "no sessions on the plot today — a quiet day."
                : `${events.length} little ${events.length === 1 ? "thing" : "things"} in the soil today.`}
            </p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {!pushToCalendar && (
              <Link href="/settings#calendars" className="btn">
                <CalendarIcon size={16} /> turn on calendar push
              </Link>
            )}
            <Link href="/plan/new" className="btn primary">
              + plant a sprout
            </Link>
          </div>
        </div>

        {busyToday.ok && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginBottom: 8,
              alignItems: "center",
            }}
          >
            <CalendarRefreshButton calendarConnected />
          </div>
        )}
        <DashboardTimelinePanel
          events={events}
          nowMinutes={nowMinutes}
          upNext={upNext}
          calendarConnected={busyToday.ok}
        />

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <h2
            className="serif-display"
            style={{
              fontSize: 36,
              margin: 0,
              fontWeight: 400,
              letterSpacing: "-0.01em",
            }}
          >
            Your{" "}
            <span style={{ fontStyle: "italic", color: "var(--moss-deep)" }}>garden</span>
          </h2>
          <div className="hand" style={{ fontSize: 14, color: "var(--ink-faded)" }}>
            {plans.length} sprout{plans.length === 1 ? "" : "s"} growing ·{" "}
            {upcomingCount} upcoming session{upcomingCount === 1 ? "" : "s"}
          </div>
        </div>

        <SproutGrid
          sprouts={items}
          initialSortMode={pref.sproutSortMode as SortMode}
          initialCustomOrder={
            JSON.parse(pref.sproutCustomOrder || "[]") as string[]
          }
        />

        {/* weekly rhythm — bars stacked by sprout color */}
        <div style={{ marginTop: 36 }}>
          <h2
            className="serif-display"
            style={{ fontSize: 28, margin: "0 0 14px", fontWeight: 500 }}
          >
            This week&apos;s rhythm
          </h2>
          <div className="ink-card" style={{ padding: 22 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(7, 1fr)",
                gap: 14,
                alignItems: "end",
                height: 160,
              }}
            >
              {dayMins.map((mins, i) => {
                const heightPct = (mins / maxMins) * 100;
                // Build the per-plan stack within this day so the bar visually
                // shows whose minutes contribute.
                const stacks: { planId: string; minutes: number }[] = [];
                for (const [pid, arr] of perPlanDayMins) {
                  if (arr[i] > 0) stacks.push({ planId: pid, minutes: arr[i] });
                }
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 8,
                      height: "100%",
                      justifyContent: "flex-end",
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "var(--font-jetbrains)",
                        fontSize: 11,
                        color: "var(--ink-faded)",
                      }}
                    >
                      {Math.round(mins)}m
                    </div>
                    <div
                      style={{
                        width: "70%",
                        height: `${Math.max(2, heightPct)}%`,
                        border: "1.5px solid var(--ink)",
                        borderRadius: "12px 12px 4px 4px",
                        background:
                          mins === 0 ? "var(--paper-deep)" : "transparent",
                        display: "flex",
                        flexDirection: "column-reverse",
                        overflow: "hidden",
                      }}
                    >
                      {stacks.map((seg) => {
                        const c = colorForSprout(seg.planId);
                        const pct = mins > 0 ? (seg.minutes / mins) * 100 : 0;
                        return (
                          <div
                            key={seg.planId}
                            style={{
                              width: "100%",
                              height: `${pct}%`,
                              background: c.swatch,
                            }}
                            title={`${Math.round(seg.minutes)} min`}
                          />
                        );
                      })}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-fraunces)",
                        fontWeight: 500,
                        fontSize: 14,
                      }}
                    >
                      {dayLabels[i]}
                    </div>
                  </div>
                );
              })}
            </div>
            <div
              className="hand"
              style={{
                marginTop: 12,
                fontSize: 14,
                color: "var(--ink-faded)",
                textAlign: "center",
              }}
            >
              {plans.length > 1
                ? "stacked colors show how each sprout contributes to the week."
                : "the bigger leaves are days with more practice planned."}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}

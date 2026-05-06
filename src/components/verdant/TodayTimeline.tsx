"use client";

import Link from "next/link";
import { CalendarIcon, Sprout, SunArt } from "./art";

export type TimelineEvent = {
  id: string;
  title: string;
  sprout?: string;
  type: "verdant-lesson" | "verdant-review" | "verdant-milestone" | "ext";
  start: string; // "HH:mm"
  end: string;
  /** When set, the verdant tile becomes a link to the session detail page. */
  href?: string;
  /** Owning sprout plan — used with calendar conflict resolution on the dashboard. */
  planId?: string;
};

const START_H = 7;
const END_H = 22;
const TOTAL_MIN = (END_H - START_H) * 60;

function toMin(t: string) {
  const [h, m] = t.split(":").map(Number);
  return (h - START_H) * 60 + m;
}

function colorFor(e: TimelineEvent) {
  if (e.type === "verdant-lesson") return "var(--leaf-pale)";
  if (e.type === "verdant-review") return "var(--sky-soft)";
  if (e.type === "verdant-milestone") return "var(--sun-soft)";
  return "rgba(139,111,74,0.18)";
}

function midnightMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function intervalsOverlapHHMM(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string
): boolean {
  const as = midnightMinutes(aStart);
  const ae = midnightMinutes(aEnd);
  const bs = midnightMinutes(bStart);
  const be = midnightMinutes(bEnd);
  return ae > bs && as < be;
}

function verdantOverlapsCalendar(e: TimelineEvent, extEvents: TimelineEvent[]): boolean {
  for (const x of extEvents) {
    if (intervalsOverlapHHMM(e.start, e.end, x.start, x.end)) return true;
  }
  return false;
}

export function TodayTimeline({
  events,
  nowMinutes,
  upNext,
  summaryHint,
  calendarConnected = true,
  onConflictSession,
}: {
  events: TimelineEvent[];
  /** minutes past midnight for the "now" line; clamp inside lane if outside range */
  nowMinutes: number;
  upNext?: TimelineEvent;
  summaryHint?: string;
  /**
   * When false, an empty Calendar lane shows the connect prompt. When true,
   * empty means no external meetings in the plotted window (or none today).
   */
  calendarConnected?: boolean;
  /** When set, clicking a conflicting verdant tile opens conflict UI instead of navigating. */
  onConflictSession?: (e: TimelineEvent) => void;
}) {
  const verdantEvents = events.filter((e) => e.type !== "ext");
  const extEvents = events.filter((e) => e.type === "ext");
  const nowFromStart = nowMinutes - START_H * 60;
  const nowPct = Math.max(0, Math.min(100, (nowFromStart / TOTAL_MIN) * 100));
  const showNow = nowFromStart >= 0 && nowFromStart <= TOTAL_MIN;

  const hint =
    summaryHint ||
    `${verdantEvents.length} Verdant session${verdantEvents.length === 1 ? "" : "s"} woven between ${extEvents.length} calendar event${extEvents.length === 1 ? "" : "s"}`;

  return (
    <div
      className="journal-edge"
      style={{ padding: 22, marginBottom: 28, position: "relative", overflow: "visible" }}
    >
      <div style={{ position: "absolute", right: 24, top: -32 }}>
        <SunArt size={56} className="float-y" />
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
        <h2 className="serif-display" style={{ fontSize: 26, margin: 0, fontWeight: 500 }}>
          Today&apos;s plot
        </h2>
        <span
          style={{
            fontFamily: "var(--font-fraunces)",
            fontStyle: "italic",
            fontSize: 14,
            color: "var(--ink-faded)",
          }}
        >
          {hint}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 8, marginTop: 14 }}>
        <div></div>
        {/* hour rail */}
        <div style={{ position: "relative", height: 18 }}>
          {Array.from({ length: END_H - START_H + 1 }).map((_, i) => {
            const h = START_H + i;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: `${(i / (END_H - START_H)) * 100}%`,
                  transform: "translateX(-50%)",
                  fontFamily: "var(--font-jetbrains)",
                  fontSize: 10,
                  color: "var(--ink-faded)",
                }}
              >
                {(h <= 12 ? h : h - 12) + (h < 12 ? "a" : "p")}
              </div>
            );
          })}
        </div>

        {/* Verdant lane */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            paddingRight: 4,
          }}
        >
          <Sprout size={26} growth={0.5} />
          <span style={{ fontFamily: "var(--font-fraunces)", fontWeight: 500, fontSize: 13 }}>
            Verdant
          </span>
        </div>
        <div
          style={{
            position: "relative",
            height: 44,
            background: "rgba(136, 167, 85, 0.08)",
            border: "1.25px dashed var(--ink-soft)",
            borderRadius: 10,
          }}
        >
          {Array.from({ length: END_H - START_H }).map((_, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${((i + 1) / (END_H - START_H)) * 100}%`,
                borderLeft: "1px dotted rgba(43,36,24,0.16)",
              }}
            />
          ))}
          {showNow && (
            <div
              style={{
                position: "absolute",
                top: -4,
                bottom: -4,
                left: `${nowPct}%`,
                width: 0,
                borderLeft: "2px solid var(--berry)",
                zIndex: 3,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: -8,
                  left: -5,
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "var(--berry)",
                  border: "1.5px solid var(--ink)",
                }}
              />
            </div>
          )}
          {verdantEvents.map((e) => {
            const left = (toMin(e.start) / TOTAL_MIN) * 100;
            const width = ((toMin(e.end) - toMin(e.start)) / TOTAL_MIN) * 100;
            const conflictsCal = verdantOverlapsCalendar(e, extEvents);
            const tileStyle = {
              position: "absolute" as const,
              left: `${left}%`,
              width: `max(110px, ${width}%)`,
              top: 4,
              bottom: 4,
              background: conflictsCal ? "rgba(194, 90, 90, 0.28)" : colorFor(e),
              border: conflictsCal
                ? "2px solid var(--berry)"
                : "1.5px solid var(--ink)",
              borderRadius: 8,
              padding: "3px 8px",
              overflow: "hidden" as const,
              boxShadow: conflictsCal
                ? "1.5px 2px 0 var(--berry)"
                : "1.5px 2px 0 var(--ink)",
              textDecoration: "none" as const,
              color: "inherit" as const,
              cursor: e.href ? "pointer" : ("default" as const),
              display: "block" as const,
            };
            const inner = (
              <>
                <div
                  style={{
                    fontFamily: "var(--font-fraunces)",
                    fontWeight: 500,
                    fontSize: 12,
                    lineHeight: 1.15,
                  }}
                >
                  {e.title}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-jetbrains)",
                    fontSize: 10,
                    color: "var(--ink-faded)",
                  }}
                >
                  {e.start}
                  {e.sprout ? ` · ${e.sprout}` : ""}
                </div>
              </>
            );
            const tip = conflictsCal ? "Overlaps a Google Calendar event" : undefined;
            if (
              conflictsCal &&
              e.planId &&
              onConflictSession
            ) {
              return (
                <button
                  key={e.id}
                  type="button"
                  title={tip}
                  onClick={() => onConflictSession(e)}
                  style={{
                    ...tileStyle,
                    cursor: "pointer",
                    font: "inherit",
                    textAlign: "left",
                  }}
                >
                  {inner}
                </button>
              );
            }
            return e.href ? (
              <Link key={e.id} href={e.href} style={tileStyle} title={tip}>
                {inner}
              </Link>
            ) : (
              <div key={e.id} style={tileStyle} title={tip}>
                {inner}
              </div>
            );
          })}
        </div>

        {/* Calendar lane */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            paddingRight: 4,
          }}
        >
          <CalendarIcon size={20} />
          <span style={{ fontFamily: "var(--font-fraunces)", fontWeight: 500, fontSize: 13 }}>
            Calendar
          </span>
        </div>
        <div
          style={{
            position: "relative",
            height: 36,
            background: "rgba(139,111,74,0.06)",
            border: "1.25px dashed var(--ink-soft)",
            borderRadius: 10,
            marginTop: 6,
          }}
        >
          {Array.from({ length: END_H - START_H }).map((_, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${((i + 1) / (END_H - START_H)) * 100}%`,
                borderLeft: "1px dotted rgba(43,36,24,0.16)",
              }}
            />
          ))}
          {showNow && (
            <div
              style={{
                position: "absolute",
                top: -2,
                bottom: -2,
                left: `${nowPct}%`,
                width: 0,
                borderLeft: "2px solid var(--berry)",
                zIndex: 3,
              }}
            />
          )}
          {extEvents.length === 0 ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                fontFamily: "var(--font-fraunces)",
                fontStyle: "italic",
                fontSize: 12,
                color: "var(--ink-faded)",
                textAlign: "center",
                padding: "0 8px",
              }}
            >
              {calendarConnected
                ? "no other meetings on your calendar in this window today"
                : "connect Google Calendar to weave around your meetings"}
            </div>
          ) : (
            extEvents.map((e) => {
              const left = (toMin(e.start) / TOTAL_MIN) * 100;
              const width = ((toMin(e.end) - toMin(e.start)) / TOTAL_MIN) * 100;
              return (
                <div
                  key={e.id}
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    width: `${width}%`,
                    top: 4,
                    bottom: 4,
                    background: "rgba(139,111,74,0.18)",
                    border: "1.25px dashed var(--ink-faded)",
                    borderRadius: 6,
                    padding: "2px 6px",
                    overflow: "hidden",
                    fontFamily: "var(--font-jetbrains)",
                    fontSize: 10,
                    color: "var(--ink-soft)",
                  }}
                >
                  <div
                    style={{
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {e.title}
                  </div>
                  <div style={{ color: "var(--ink-faded)" }}>{e.start}</div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {upNext && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: 16,
            paddingTop: 12,
            borderTop: "1.25px dashed var(--ink-soft)",
          }}
        >
          <span className="tag">up next</span>
          <span style={{ fontFamily: "var(--font-jetbrains)", fontSize: 12 }}>
            {upNext.start}
          </span>
          <span style={{ fontFamily: "var(--font-fraunces)", fontSize: 14, fontWeight: 500 }}>
            {upNext.title}
          </span>
          <span className="chip sun" style={{ marginLeft: "auto" }}>
            {durationLabel(upNext)}
          </span>
        </div>
      )}
    </div>
  );
}

function durationLabel(e: TimelineEvent) {
  const mins = toMin(e.end) - toMin(e.start);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h}h ${m}m`;
}

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type { TaskType, TimeWindows } from "@/types/plan";
import { ConflictResolveModal } from "@/components/verdant/ConflictResolveModal";

const HOUR_PX = 36;
const FIRST_HOUR = 5;
const LAST_HOUR = 24; // exclusive — show 5a..midnight (19 rows)
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }).map(
  (_, i) => FIRST_HOUR + i
);
const SNAP_MIN = 15;
const DRAG_THRESHOLD_PX = 4;
const RAIL_PX = 60;
const HEADER_PX = 56; // approx height of day-header row
const CHEVRON_ZONE_PX = 28;

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// JS Date.getDay() = Sun=0..Sat=6. TimeWindows keys mirror that.
const TW_KEY_FOR_DAY_INDEX = ["1", "2", "3", "4", "5", "6", "0"]; // Mon=0..Sun=6

export interface VerdantBlock {
  id: string;
  planId: string;
  dayIndex: number; // 0..6, Mon=0
  startMin: number; // minutes from midnight, local
  endMin: number;
  startISO: string;
  endISO: string;
  title: string;
  sproutTitle: string;
  type: TaskType;
  locked: boolean;
  googleSynced: boolean;
  pastImmovable: boolean;
  href: string; // session detail link
}

export interface ExternalBlock {
  dayIndex: number;
  startMin: number;
  endMin: number;
  title: string;
}

interface WeekGridProps {
  dateLabels: string[];
  todayIndex: number | null;
  verdant: VerdantBlock[];
  external: ExternalBlock[];
  timeWindows: TimeWindows;
  /** ISO date for Monday of this week (00:00 local). */
  mondayISO: string;
  /** Plan window — drops outside snap back. */
  startDateISO: string;
  deadlineISO: string;
  /** Current week offset from "this week"; used for chevron-drop nav. */
  weekOffset: number;
}

// --- helpers ---
function colorFor(type: TaskType): string {
  if (type === "review") return "var(--sky-soft)";
  if (type === "milestone") return "var(--sun-soft)";
  return "var(--leaf-pale)";
}

function iconFor(type: TaskType): string {
  if (type === "review") return "🐸";
  if (type === "milestone") return "🏆";
  return "🌱";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtHHMM(min: number): string {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

function parseTwHour(s: string | undefined): number | null {
  if (!s) return null;
  const [h, m] = s.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function dayWindowsMin(
  tw: TimeWindows,
  dayIndex: number
): Array<{ startMin: number; endMin: number }> {
  const list = tw[TW_KEY_FOR_DAY_INDEX[dayIndex]];
  if (!list || list.length === 0) return [];
  const out: Array<{ startMin: number; endMin: number }> = [];
  for (const w of list) {
    const s = parseTwHour(w.start);
    const e = parseTwHour(w.end);
    if (s == null || e == null || e <= s) continue;
    out.push({ startMin: s, endMin: e });
  }
  out.sort((a, b) => a.startMin - b.startMin);
  return out;
}

function clampMin(v: number): number {
  return Math.max(FIRST_HOUR * 60, Math.min(LAST_HOUR * 60, v));
}

/** True when a Verdant block's time range overlaps any external (Google) block on the same day. */
function overlapsExternalCalendar(
  startMin: number,
  endMin: number,
  dayExternal: ExternalBlock[]
): boolean {
  for (const x of dayExternal) {
    if (endMin <= x.startMin) continue;
    if (startMin >= x.endMin) continue;
    return true;
  }
  return false;
}

function snap15(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

function buildLocalDate(mondayISO: string, dayIndex: number, min: number): Date {
  const monday = new Date(mondayISO);
  monday.setHours(0, 0, 0, 0);
  const d = new Date(monday);
  d.setDate(d.getDate() + dayIndex);
  d.setHours(Math.floor(min / 60), min % 60, 0, 0);
  return d;
}

interface DragState {
  block: VerdantBlock;
  origin: { x: number; y: number };
  active: boolean;
  ghostDayIndex: number;
  ghostStartMin: number;
  /** chevron drop target while drag is over the side gutters */
  chevronZone: "prev" | "next" | null;
  /** drag is locked into its source position because the destination is invalid */
  invalid: boolean;
  saving: boolean;
}

interface Toast {
  msg: string;
  key: number;
}

export function WeekGrid({
  dateLabels,
  todayIndex,
  verdant: initialVerdant,
  external,
  timeWindows,
  mondayISO,
  startDateISO,
  deadlineISO,
  weekOffset,
}: WeekGridProps) {
  const router = useRouter();
  const [blocks, setBlocks] = useState<VerdantBlock[]>(initialVerdant);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [conflictModal, setConflictModal] = useState<{
    planId: string;
    sessionId: string;
    title: string;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const wasDraggingRef = useRef<Set<string>>(new Set());
  const totalH = HOUR_PX * HOURS.length;

  // Sync local state from props if a server refresh delivers fresh data.
  useEffect(() => {
    setBlocks(initialVerdant);
  }, [initialVerdant]);

  // Keep ref in sync for window-listener handlers.
  useEffect(() => {
    dragStateRef.current = drag;
  }, [drag]);

  function pushToast(msg: string) {
    const key = Date.now() + Math.random();
    setToasts((t) => [...t, { msg, key }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.key !== key));
    }, 3500);
  }

  // --- pointer event flow ---
  const onBlockPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, block: VerdantBlock) => {
      if (block.pastImmovable) return; // click only
      if (e.button !== 0) return;
      // Don't preventDefault yet — let click fire if the pointer doesn't move.
      const next: DragState = {
        block,
        origin: { x: e.clientX, y: e.clientY },
        active: false,
        ghostDayIndex: block.dayIndex,
        ghostStartMin: block.startMin,
        chevronZone: null,
        invalid: false,
        saving: false,
      };
      setDrag(next);
      dragStateRef.current = next;
    },
    []
  );

  // Compute ghost position from a clientX/Y pair.
  const computeGhost = useCallback(
    (
      block: VerdantBlock,
      clientX: number,
      clientY: number
    ): { dayIndex: number; startMin: number; chevronZone: "prev" | "next" | null } => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        return {
          dayIndex: block.dayIndex,
          startMin: block.startMin,
          chevronZone: null,
        };
      }
      // chevron drop zones at the left/right edges of the grid card
      if (clientX < rect.left + CHEVRON_ZONE_PX) {
        return { dayIndex: block.dayIndex, startMin: block.startMin, chevronZone: "prev" };
      }
      if (clientX > rect.right - CHEVRON_ZONE_PX) {
        return { dayIndex: block.dayIndex, startMin: block.startMin, chevronZone: "next" };
      }
      const colsLeft = rect.left + RAIL_PX;
      const dayWidth = (rect.right - colsLeft) / 7;
      const rawDay = Math.floor((clientX - colsLeft) / dayWidth);
      const dayIndex = Math.max(0, Math.min(6, rawDay));
      const yWithinCols = clientY - rect.top - HEADER_PX;
      const minutesFromTop = (yWithinCols / HOUR_PX) * 60;
      const dur = block.endMin - block.startMin;
      const rawStart = FIRST_HOUR * 60 + minutesFromTop;
      const snappedStart = snap15(clampMin(rawStart));
      // ensure block fits inside [FIRST_HOUR*60, LAST_HOUR*60]
      const maxStart = LAST_HOUR * 60 - dur;
      const startMin = Math.max(FIRST_HOUR * 60, Math.min(maxStart, snappedStart));
      return { dayIndex, startMin, chevronZone: null };
    },
    []
  );

  const overlapsVerdant = useCallback(
    (block: VerdantBlock, dayIndex: number, startMin: number): boolean => {
      const endMin = startMin + (block.endMin - block.startMin);
      for (const b of blocks) {
        if (b.id === block.id) continue;
        if (b.dayIndex !== dayIndex) continue;
        if (b.endMin <= startMin) continue;
        if (b.startMin >= endMin) continue;
        return true;
      }
      return false;
    },
    [blocks]
  );

  const onWindowPointerMove = useCallback(
    (e: PointerEvent) => {
      const cur = dragStateRef.current;
      if (!cur) return;
      const dx = e.clientX - cur.origin.x;
      const dy = e.clientY - cur.origin.y;
      const moved = Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
      if (!cur.active && !moved) return;
      if (!cur.active) {
        wasDraggingRef.current.add(cur.block.id);
      }
      e.preventDefault();
      const ghost = computeGhost(cur.block, e.clientX, e.clientY);
      const invalid =
        ghost.chevronZone == null &&
        overlapsVerdant(cur.block, ghost.dayIndex, ghost.startMin);
      const next: DragState = {
        ...cur,
        active: true,
        ghostDayIndex: ghost.dayIndex,
        ghostStartMin: ghost.startMin,
        chevronZone: ghost.chevronZone,
        invalid,
      };
      dragStateRef.current = next;
      setDrag(next);
    },
    [computeGhost, overlapsVerdant]
  );

  const persistMove = useCallback(
    async (
      block: VerdantBlock,
      newStart: Date,
      newEnd: Date
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const res = await fetch(`/api/plans/${block.planId}/move-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: block.id,
          start: newStart.toISOString(),
          end: newEnd.toISOString(),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j.error || res.statusText };
      }
      return { ok: true };
    },
    []
  );

  const onWindowPointerUp = useCallback(
    async (e: PointerEvent) => {
      const cur = dragStateRef.current;
      if (!cur) return;
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
      if (!cur.active) {
        // it's a click; let the click handler take over
        setDrag(null);
        dragStateRef.current = null;
        return;
      }
      e.preventDefault();
      const block = cur.block;

      // Cross-week chevron drop
      if (cur.chevronZone) {
        const offsetDelta = cur.chevronZone === "next" ? 7 : -7;
        const newStart = new Date(block.startISO);
        newStart.setDate(newStart.getDate() + offsetDelta);
        const newEnd = new Date(block.endISO);
        newEnd.setDate(newEnd.getDate() + offsetDelta);
        if (
          newStart < new Date(startDateISO) ||
          newEnd > new Date(deadlineISO)
        ) {
          pushToast("outside the sprout's window.");
          setDrag(null);
          dragStateRef.current = null;
          return;
        }
        // optimistic: bump local block out of view (it's no longer this week)
        setBlocks((bs) => bs.filter((b) => b.id !== block.id));
        setDrag({ ...cur, saving: true });
        const result = await persistMove(block, newStart, newEnd);
        if (!result.ok) {
          // revert
          setBlocks((bs) => [...bs, block]);
          pushToast(`couldn't move: ${result.error}`);
          setDrag(null);
          dragStateRef.current = null;
          return;
        }
        // Navigate to the destination week. Server will render the new spot.
        const nextOffset = weekOffset + (cur.chevronZone === "next" ? 1 : -1);
        router.push(`/schedule?w=${nextOffset}`);
        router.refresh();
        return;
      }

      // Same-week drop
      const dayIndex = cur.ghostDayIndex;
      const startMin = cur.ghostStartMin;
      const endMin = startMin + (block.endMin - block.startMin);

      // No-op?
      if (
        dayIndex === block.dayIndex &&
        startMin === block.startMin
      ) {
        setDrag(null);
        dragStateRef.current = null;
        return;
      }

      if (cur.invalid) {
        pushToast("can't overlap another sprout session.");
        setDrag(null);
        dragStateRef.current = null;
        return;
      }

      const newStart = buildLocalDate(mondayISO, dayIndex, startMin);
      const newEnd = buildLocalDate(mondayISO, dayIndex, endMin);
      if (newStart < new Date(startDateISO) || newEnd > new Date(deadlineISO)) {
        pushToast("outside the sprout's window.");
        setDrag(null);
        dragStateRef.current = null;
        return;
      }

      // Optimistic local move + saving badge
      setBlocks((bs) =>
        bs.map((b) =>
          b.id === block.id
            ? {
                ...b,
                dayIndex,
                startMin,
                endMin,
                startISO: newStart.toISOString(),
                endISO: newEnd.toISOString(),
                locked: true,
                googleSynced: false,
              }
            : b
        )
      );
      setDrag({ ...cur, saving: true });

      const result = await persistMove(block, newStart, newEnd);
      if (!result.ok) {
        // Snap back
        setBlocks((bs) =>
          bs.map((b) =>
            b.id === block.id
              ? { ...b, dayIndex: block.dayIndex, startMin: block.startMin, endMin: block.endMin, startISO: block.startISO, endISO: block.endISO, locked: block.locked, googleSynced: block.googleSynced }
              : b
          )
        );
        pushToast(`couldn't move: ${result.error}`);
        setDrag(null);
        dragStateRef.current = null;
        return;
      }
      setDrag(null);
      dragStateRef.current = null;
      router.refresh();
    },
    [
      mondayISO,
      startDateISO,
      deadlineISO,
      weekOffset,
      onWindowPointerMove,
      persistMove,
      router,
    ]
  );

  // Attach window listeners once a drag candidate exists.
  useEffect(() => {
    if (!drag) return;
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    return () => {
      window.removeEventListener("pointermove", onWindowPointerMove);
      window.removeEventListener("pointerup", onWindowPointerUp);
    };
    // we re-attach when `drag` toggles between null/non-null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag === null]);

  function onBlockClick(e: React.MouseEvent, block: VerdantBlock) {
    // Suppress click after drag.
    if (wasDraggingRef.current.has(block.id)) {
      e.preventDefault();
      wasDraggingRef.current.delete(block.id);
      return;
    }
    const dayEx = external.filter((x) => x.dayIndex === block.dayIndex);
    if (overlapsExternalCalendar(block.startMin, block.endMin, dayEx)) {
      e.preventDefault();
      setConflictModal({
        planId: block.planId,
        sessionId: block.id,
        title: block.title,
      });
      return;
    }
    router.push(block.href);
  }

  // Off-hours dimming bands per day, derived from timeWindows. With multiple
  // windows per day, the off-hours are the gaps before, between, and after
  // each declared window inside the visible band.
  const offHourBands = useMemo(() => {
    const out: Array<{ dayIndex: number; topPx: number; heightPx: number }> = [];
    const visibleStart = FIRST_HOUR * 60;
    const visibleEnd = LAST_HOUR * 60;
    const minToPx = (m: number) => ((m - visibleStart) / 60) * HOUR_PX;
    for (let di = 0; di < 7; di++) {
      const wins = dayWindowsMin(timeWindows, di);
      if (wins.length === 0) {
        out.push({ dayIndex: di, topPx: 0, heightPx: totalH });
        continue;
      }
      let cursor = visibleStart;
      for (const w of wins) {
        const ws = Math.max(visibleStart, w.startMin);
        const we = Math.min(visibleEnd, w.endMin);
        if (ws > cursor) {
          out.push({
            dayIndex: di,
            topPx: minToPx(cursor),
            heightPx: minToPx(ws) - minToPx(cursor),
          });
        }
        if (we > cursor) cursor = we;
      }
      if (cursor < visibleEnd) {
        out.push({
          dayIndex: di,
          topPx: minToPx(cursor),
          heightPx: minToPx(visibleEnd) - minToPx(cursor),
        });
      }
    }
    return out;
  }, [timeWindows, totalH]);

  return (
    <div
      ref={containerRef}
      className="ink-card"
      style={{ padding: 0, overflow: "hidden", position: "relative" }}
    >
      {/* day header row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `${RAIL_PX}px repeat(7, 1fr)`,
          borderBottom: "1.5px solid var(--ink)",
        }}
      >
        <div
          style={{
            padding: "10px 0",
            borderRight: "1.5px solid var(--ink)",
            background: "var(--paper-deep)",
          }}
        />
        {DAY_LABELS.map((d, i) => (
          <div
            key={d}
            style={{
              padding: "10px 12px",
              borderRight: i < 6 ? "1.5px dashed var(--ink-soft)" : "none",
              background:
                i === todayIndex ? "var(--sun-soft)" : "var(--paper-deep)",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-fraunces)",
                fontSize: 16,
                fontWeight: 600,
              }}
            >
              {d}
            </div>
            <div
              style={{
                fontFamily: "var(--font-jetbrains)",
                fontSize: 11,
                color: "var(--ink-faded)",
              }}
            >
              {dateLabels[i] ?? ""}
              {i === todayIndex && (
                <span style={{ color: "var(--berry)", marginLeft: 6 }}>· today</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* hour rail + day columns */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `${RAIL_PX}px repeat(7, 1fr)`,
          position: "relative",
        }}
      >
        <div
          style={{
            borderRight: "1.5px solid var(--ink)",
            background: "var(--paper)",
          }}
        >
          {HOURS.map((h) => (
            <div
              key={h}
              style={{
                height: HOUR_PX,
                padding: "2px 6px",
                fontFamily: "var(--font-jetbrains)",
                fontSize: 10,
                color: "var(--ink-faded)",
                textAlign: "right",
              }}
            >
              {h === 0 || h === 24
                ? "12a"
                : h === 12
                  ? "12p"
                  : `${h <= 12 ? h : h - 12}${h < 12 ? "a" : "p"}`}
            </div>
          ))}
        </div>

        {DAY_LABELS.map((_, di) => {
          const isWeekend = di === 5 || di === 6;
          const dayExternal = external.filter((e) => e.dayIndex === di);
          const dayVerdant = blocks.filter((e) => e.dayIndex === di);
          return (
            <div
              key={di}
              style={{
                position: "relative",
                height: totalH,
                borderRight: di < 6 ? "1.5px dashed var(--ink-soft)" : "none",
                background: isWeekend
                  ? "rgba(233, 196, 106, 0.05)"
                  : "transparent",
              }}
            >
              {/* off-hours dimming bands */}
              {offHourBands
                .filter((b) => b.dayIndex === di)
                .map((b, idx) => (
                  <div
                    key={`oh-${idx}`}
                    aria-hidden
                    style={{
                      position: "absolute",
                      top: b.topPx,
                      left: 0,
                      right: 0,
                      height: b.heightPx,
                      background:
                        "repeating-linear-gradient(135deg, rgba(43,36,24,0.04) 0 6px, transparent 6px 12px)",
                      pointerEvents: "none",
                    }}
                  />
                ))}

              {/* hour gridlines */}
              {HOURS.slice(1).map((h) => (
                <div
                  key={h}
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: (h - FIRST_HOUR) * HOUR_PX,
                    height: 0,
                    borderTop: "1px dotted rgba(43,36,24,0.18)",
                  }}
                />
              ))}

              {/* external events: dimmed dashed soil */}
              {dayExternal.map((e, i) => {
                const top = ((e.startMin - FIRST_HOUR * 60) / 60) * HOUR_PX;
                const h = ((e.endMin - e.startMin) / 60) * HOUR_PX;
                return (
                  <div
                    key={`x${di}-${i}`}
                    style={{
                      position: "absolute",
                      top,
                      left: 4,
                      right: 4,
                      height: Math.max(16, h - 2),
                      background: "rgba(139, 111, 74, 0.16)",
                      border: "1.25px dashed var(--ink-faded)",
                      borderRadius: 6,
                      padding: "3px 6px",
                      fontSize: 11,
                      fontFamily: "var(--font-jetbrains)",
                      color: "var(--ink-faded)",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                      pointerEvents: "none",
                    }}
                  >
                    {e.title}
                  </div>
                );
              })}

              {/* Verdant sessions */}
              {dayVerdant.map((e) => {
                const isDragSource = drag?.block.id === e.id && drag?.active;
                const top = ((e.startMin - FIRST_HOUR * 60) / 60) * HOUR_PX;
                const h = ((e.endMin - e.startMin) / 60) * HOUR_PX;
                const id = e.id;
                const isHover = hover === id;
                const isSaving =
                  drag?.block.id === e.id && drag?.saving === true;
                const showLock = e.locked;
                const conflictsCalendar = overlapsExternalCalendar(
                  e.startMin,
                  e.endMin,
                  dayExternal
                );
                const cursor = e.pastImmovable
                  ? "pointer"
                  : drag?.block.id === e.id
                    ? "grabbing"
                    : "grab";
                return (
                  <div
                    key={id}
                    role="button"
                    tabIndex={0}
                    title={
                      conflictsCalendar
                        ? "Overlaps a Google Calendar event"
                        : undefined
                    }
                    onMouseEnter={() => setHover(id)}
                    onMouseLeave={() => setHover(null)}
                    onPointerDown={(ev) => onBlockPointerDown(ev, e)}
                    onClick={(ev) => onBlockClick(ev, e)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        router.push(e.href);
                      }
                    }}
                    style={{
                      position: "absolute",
                      top,
                      left: 3,
                      right: 3,
                      height: Math.max(20, h - 2),
                      background: conflictsCalendar
                        ? "rgba(194, 90, 90, 0.28)"
                        : colorFor(e.type),
                      border: conflictsCalendar
                        ? "2px solid var(--berry)"
                        : "1.5px solid var(--ink)",
                      borderRadius: 8,
                      boxShadow: isHover
                        ? conflictsCalendar
                          ? "3px 3px 0 var(--berry)"
                          : "3px 3px 0 var(--ink)"
                        : conflictsCalendar
                          ? "1.5px 2px 0 var(--berry)"
                          : "1.5px 2px 0 var(--ink)",
                      padding: "4px 6px",
                      overflow: "hidden",
                      cursor,
                      transition: "transform .12s, box-shadow .12s, opacity .12s",
                      transform: isHover ? "translate(-1px,-1px)" : "none",
                      textAlign: "left",
                      fontFamily: "inherit",
                      color: "inherit",
                      opacity: isDragSource ? 0.4 : e.pastImmovable ? 0.7 : 1,
                      touchAction: "none",
                      userSelect: "none",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ fontSize: 12 }} aria-hidden>
                        {iconFor(e.type)}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-jetbrains)",
                          fontSize: 10,
                          color: "var(--ink-faded)",
                        }}
                      >
                        {fmtHHMM(e.startMin)}
                      </span>
                      {showLock && (
                        <span
                          aria-label="locked"
                          title="locked — won't be moved by auto-reshuffle"
                          style={{ marginLeft: "auto", fontSize: 11 }}
                        >
                          🔒
                        </span>
                      )}
                      {isSaving && (
                        <span
                          aria-label="saving"
                          title="saving…"
                          style={{
                            marginLeft: showLock ? 4 : "auto",
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: "var(--moss)",
                            display: "inline-block",
                          }}
                        />
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-fraunces)",
                        fontSize: 12,
                        fontWeight: 500,
                        lineHeight: 1.15,
                        marginTop: 1,
                        whiteSpace: "nowrap",
                        textOverflow: "ellipsis",
                        overflow: "hidden",
                      }}
                    >
                      {e.title}
                    </div>
                    {h > 30 && (
                      <div
                        style={{
                          fontFamily: "var(--font-fraunces)",
                          fontStyle: "italic",
                          fontSize: 11,
                          color: "var(--ink-faded)",
                          lineHeight: 1.1,
                          whiteSpace: "nowrap",
                          textOverflow: "ellipsis",
                          overflow: "hidden",
                        }}
                      >
                        {e.sproutTitle}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Drag ghost (only on the destination column) */}
              {drag?.active &&
                drag.chevronZone == null &&
                drag.ghostDayIndex === di && (
                  <DragGhost
                    block={drag.block}
                    startMin={drag.ghostStartMin}
                    invalid={drag.invalid}
                  />
                )}
            </div>
          );
        })}
      </div>

      <ConflictResolveModal
        open={conflictModal !== null}
        onClose={() => setConflictModal(null)}
        planId={conflictModal?.planId ?? ""}
        sessionId={conflictModal?.sessionId ?? ""}
        sessionTitle={conflictModal?.title ?? ""}
      />

      {/* chevron drop zones (visible only during drag) */}
      <ChevronZone
        side="left"
        active={drag?.active === true}
        highlighted={drag?.chevronZone === "prev"}
      />
      <ChevronZone
        side="right"
        active={drag?.active === true}
        highlighted={drag?.chevronZone === "next"}
      />

      {/* toasts */}
      {toasts.length > 0 && (
        <div
          style={{
            position: "fixed",
            right: 24,
            bottom: 24,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            zIndex: 50,
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.key}
              className="ink-card soft"
              style={{
                padding: "10px 14px",
                background: "var(--paper-warm)",
                fontFamily: "var(--font-fraunces)",
                fontSize: 14,
                color: "var(--ink)",
                maxWidth: 320,
                boxShadow: "2px 3px 0 var(--ink)",
              }}
            >
              {t.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DragGhost({
  block,
  startMin,
  invalid,
}: {
  block: VerdantBlock;
  startMin: number;
  invalid: boolean;
}) {
  const dur = block.endMin - block.startMin;
  const top = ((startMin - FIRST_HOUR * 60) / 60) * HOUR_PX;
  const h = (dur / 60) * HOUR_PX;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top,
        left: 3,
        right: 3,
        height: Math.max(20, h - 2),
        background: invalid ? "rgba(194, 90, 90, 0.18)" : colorFor(block.type),
        border: invalid
          ? "1.5px dashed var(--berry)"
          : "1.5px dashed var(--moss-deep)",
        borderRadius: 8,
        padding: "4px 6px",
        pointerEvents: "none",
        opacity: 0.85,
        zIndex: 4,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-jetbrains)",
          fontSize: 10,
          color: invalid ? "var(--berry)" : "var(--moss-deep)",
        }}
      >
        {invalid ? "overlaps a sprout session" : fmtHHMM(startMin)}
      </div>
      <div
        style={{
          fontFamily: "var(--font-fraunces)",
          fontSize: 12,
          fontWeight: 500,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {block.title}
      </div>
    </div>
  );
}

function ChevronZone({
  side,
  active,
  highlighted,
}: {
  side: "left" | "right";
  active: boolean;
  highlighted: boolean;
}) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side]: 0,
        width: CHEVRON_ZONE_PX,
        display: active ? "grid" : "none",
        placeItems: "center",
        background: highlighted
          ? "rgba(136, 167, 85, 0.30)"
          : "rgba(136, 167, 85, 0.10)",
        borderLeft: side === "right" ? "1.5px dashed var(--moss)" : undefined,
        borderRight: side === "left" ? "1.5px dashed var(--moss)" : undefined,
        pointerEvents: "none",
        zIndex: 3,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-fraunces)",
          fontSize: 22,
          fontWeight: 600,
          color: "var(--moss-deep)",
        }}
      >
        {side === "left" ? "‹" : "›"}
      </div>
    </div>
  );
}

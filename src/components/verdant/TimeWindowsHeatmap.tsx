"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TimeWindow, TimeWindows } from "@/types/plan";
import type { HourUtilityMap } from "@/lib/hour-utility";

const FIRST_HOUR = 0;
const LAST_HOUR = 24; // exclusive — show 12a..11p (24 cells)
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }).map(
  (_, i) => FIRST_HOUR + i
);
const DRAG_THRESHOLD_PX = 4;

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** TimeWindows keys are Date.getDay()-aligned: Sun=0..Sat=6. */
const DAY_LABEL_TO_KEY: Record<string, string> = {
  Mon: "1",
  Tue: "2",
  Wed: "3",
  Thu: "4",
  Fri: "5",
  Sat: "6",
  Sun: "0",
};

/** Half-life used by hour-utility decay; mirrored here so the overlay can
 * show *current* values without a network round-trip. */
const HALF_LIFE_DAYS = 30;
const DECAY_PER_MS = Math.LN2 / (HALF_LIFE_DAYS * 86_400_000);

interface Props {
  value: TimeWindows;
  onChange: (next: TimeWindows) => void;
  /**
   * Optional learned hour-utility map. When present, an "show learned utility"
   * dropdown is rendered below the editor. The dropdown's grid uses the
   * SAME 7×24 layout but is NOT masked by `value` — every cell shows its
   * decayed value on a red→neutral→green gradient regardless of whether the
   * cell is currently selected.
   */
  hourUtility?: HourUtilityMap;
}

interface Cell {
  dayIdx: number;
  hourIdx: number; // index into HOURS, not absolute clock hour
}

interface DragState {
  origin: Cell;
  current: Cell;
  originClient: { x: number; y: number };
  active: boolean;
  destinationOn: boolean;
  snapshot: Set<string>;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function cellKey(dayIdx: number, absoluteHour: number): string {
  return `${dayIdx}-${absoluteHour}`;
}

function timeWindowsToSelected(tw: TimeWindows): Set<string> {
  const out = new Set<string>();
  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const raw = tw[DAY_LABEL_TO_KEY[DAY_LABELS[dayIdx]]];
    if (!raw) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const w of list) {
      if (
        !w ||
        typeof (w as { start?: unknown }).start !== "string" ||
        typeof (w as { end?: unknown }).end !== "string"
      ) {
        continue;
      }
      const [sh, sm] = w.start.split(":").map(Number);
      const [eh, em] = w.end.split(":").map(Number);
      if (!Number.isFinite(sh) || !Number.isFinite(eh)) continue;
      const startHour = sh + (sm > 0 ? 1 : 0);
      const endHour = em > 0 ? eh + 1 : eh;
      for (let h = startHour; h < endHour; h++) {
        out.add(cellKey(dayIdx, h));
      }
    }
  }
  return out;
}

function selectedToTimeWindows(sel: Set<string>): TimeWindows {
  const out: TimeWindows = {};
  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const hours: number[] = [];
    for (let h = 0; h < 24; h++) {
      if (sel.has(cellKey(dayIdx, h))) hours.push(h);
    }
    if (hours.length === 0) continue;
    hours.sort((a, b) => a - b);
    const ranges: TimeWindow[] = [];
    let runStart = hours[0];
    let runEnd = hours[0] + 1;
    for (let i = 1; i < hours.length; i++) {
      if (hours[i] === runEnd) {
        runEnd = hours[i] + 1;
      } else {
        ranges.push({
          start: `${pad2(runStart)}:00`,
          end: runEnd === 24 ? "24:00" : `${pad2(runEnd)}:00`,
        });
        runStart = hours[i];
        runEnd = hours[i] + 1;
      }
    }
    ranges.push({
      start: `${pad2(runStart)}:00`,
      end: runEnd === 24 ? "24:00" : `${pad2(runEnd)}:00`,
    });
    out[DAY_LABEL_TO_KEY[DAY_LABELS[dayIdx]]] = ranges;
  }
  return out;
}

function applyRectToSnapshot(d: DragState): Set<string> {
  const next = new Set(d.snapshot);
  const minDay = Math.min(d.origin.dayIdx, d.current.dayIdx);
  const maxDay = Math.max(d.origin.dayIdx, d.current.dayIdx);
  const minH = Math.min(d.origin.hourIdx, d.current.hourIdx);
  const maxH = Math.max(d.origin.hourIdx, d.current.hourIdx);
  for (let dy = minDay; dy <= maxDay; dy++) {
    for (let h = minH; h <= maxH; h++) {
      const k = cellKey(dy, HOURS[h]);
      if (d.destinationOn) next.add(k);
      else next.delete(k);
    }
  }
  return next;
}

// -----------------------------------------------------------------------------
// Utility-overlay helpers
// -----------------------------------------------------------------------------

/**
 * Decay a stored cell to `now`. Mirrors `decayedValue` in `hour-utility.ts`
 * — duplicated here so the client renders without a server round trip.
 */
function decayCell(v: number, t: string, now: Date): number {
  const fromMs = new Date(t).getTime();
  if (Number.isNaN(fromMs)) return 0;
  const age = Math.max(0, now.getTime() - fromMs);
  return v * Math.exp(-DECAY_PER_MS * age);
}

/**
 * Map a signed utility value to a CSS color on the red → neutral → green
 * gradient. Saturates at ±10 (typical equilibrium). Neutral cells are pale
 * cream so the heatmap reads as "no signal yet" rather than "off".
 */
function utilityColor(v: number): string {
  const SATURATION_AT = 10;
  const t = Math.max(-1, Math.min(1, v / SATURATION_AT));
  const hue = 60 + t * 60; // -1 → 0 (red), 0 → 60 (yellow), +1 → 120 (green)
  const mag = Math.abs(t);
  const sat = 25 + mag * 60;
  const light = 92 - mag * 35;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

/** Day-of-week mapping for utility map keys (Date.getDay() / Sun=0..Sat=6). */
const DAY_INDEX_FOR_LABEL: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 0,
};

export function TimeWindowsHeatmap({ value, onChange, hourUtility }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() =>
    timeWindowsToSelected(value)
  );
  const lastValueRef = useRef<TimeWindows>(value);
  useEffect(() => {
    if (lastValueRef.current !== value) {
      lastValueRef.current = value;
      setSelected(timeWindowsToSelected(value));
    }
  }, [value]);

  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef<(HTMLButtonElement | null)[][]>(
    Array.from({ length: 7 }, () => Array(HOURS.length).fill(null))
  );

  const [outlineRect, setOutlineRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!drag?.active || !containerRef.current) {
      setOutlineRect(null);
      return;
    }
    const minDay = Math.min(drag.origin.dayIdx, drag.current.dayIdx);
    const maxDay = Math.max(drag.origin.dayIdx, drag.current.dayIdx);
    const minH = Math.min(drag.origin.hourIdx, drag.current.hourIdx);
    const maxH = Math.max(drag.origin.hourIdx, drag.current.hourIdx);
    const tl = cellRefs.current[minDay]?.[minH];
    const br = cellRefs.current[maxDay]?.[maxH];
    if (!tl || !br) return;
    const cont = containerRef.current.getBoundingClientRect();
    const tlR = tl.getBoundingClientRect();
    const brR = br.getBoundingClientRect();
    setOutlineRect({
      top: tlR.top - cont.top,
      left: tlR.left - cont.left,
      width: brR.right - tlR.left,
      height: brR.bottom - tlR.top,
    });
  }, [drag]);

  const commitOnChange = useCallback(
    (nextSelected: Set<string>) => {
      const tw = selectedToTimeWindows(nextSelected);
      lastValueRef.current = tw;
      onChange(tw);
    },
    [onChange]
  );

  function onCellPointerDown(
    e: React.PointerEvent<HTMLButtonElement>,
    dayIdx: number,
    hourIdx: number
  ) {
    e.preventDefault();
    const cell: Cell = { dayIdx, hourIdx };
    const originKey = cellKey(dayIdx, HOURS[hourIdx]);
    const snapshot = new Set(selected);
    const next: DragState = {
      origin: cell,
      current: cell,
      originClient: { x: e.clientX, y: e.clientY },
      active: false,
      destinationOn: !snapshot.has(originKey),
      snapshot,
    };
    setDrag(next);
    dragRef.current = next;
  }

  function onCellPointerEnter(dayIdx: number, hourIdx: number) {
    const cur = dragRef.current;
    if (!cur || !cur.active) return;
    if (
      cur.current.dayIdx === dayIdx &&
      cur.current.hourIdx === hourIdx
    ) {
      return;
    }
    const next: DragState = { ...cur, current: { dayIdx, hourIdx } };
    setDrag(next);
    dragRef.current = next;
    setSelected(applyRectToSnapshot(next));
  }

  useEffect(() => {
    if (!drag) return;

    function onMove(e: PointerEvent) {
      const cur = dragRef.current;
      if (!cur || cur.active) return;
      const dx = e.clientX - cur.originClient.x;
      const dy = e.clientY - cur.originClient.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      const next: DragState = { ...cur, active: true };
      setDrag(next);
      dragRef.current = next;
      setSelected(applyRectToSnapshot(next));
    }

    function onUp() {
      const cur = dragRef.current;
      if (!cur) return;
      if (cur.active) {
        commitOnChange(selectedRef.current);
      } else {
        const originAbsHour = HOURS[cur.origin.hourIdx];
        const originKey = cellKey(cur.origin.dayIdx, originAbsHour);
        const next = new Set(cur.snapshot);
        if (next.has(originKey)) next.delete(originKey);
        else next.add(originKey);
        setSelected(next);
        commitOnChange(next);
      }
      setDrag(null);
      dragRef.current = null;
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const cur = dragRef.current;
      if (!cur) return;
      setSelected(cur.snapshot);
      setDrag(null);
      dragRef.current = null;
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag === null]);

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          display: "grid",
          gridTemplateColumns: "48px repeat(24, 1fr)",
          gap: 2,
          alignItems: "center",
          position: "relative",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        <div />
        {HOURS.map((h) => (
          <div
            key={h}
            style={{
              fontFamily: "var(--font-jetbrains)",
              fontSize: 9,
              color: "var(--ink-faded)",
              textAlign: "center",
            }}
          >
            {hourGlyph(h)}
          </div>
        ))}
        {DAY_LABELS.map((day, dayIdx) => (
          <DayRow
            key={day}
            day={day}
            dayIdx={dayIdx}
            selected={selected}
            onCellPointerDown={onCellPointerDown}
            onCellPointerEnter={onCellPointerEnter}
            cellRefs={cellRefs}
          />
        ))}

        {drag?.active && outlineRect && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: outlineRect.top,
              left: outlineRect.left,
              width: outlineRect.width,
              height: outlineRect.height,
              border: "1.75px dashed var(--moss-deep)",
              borderRadius: 6,
              pointerEvents: "none",
              zIndex: 2,
            }}
          />
        )}
      </div>

      <div
        style={{
          fontFamily: "var(--font-fraunces)",
          fontStyle: "italic",
          marginTop: 12,
          fontSize: 13,
          color: "var(--ink-faded)",
        }}
      >
        click any cell to toggle, or drag across a region to fill or clear it.
        fern only plants in the green hours. press esc mid-drag to cancel.
      </div>

      {hourUtility && <UtilityOverlay hourUtility={hourUtility} />}
    </div>
  );
}

function hourGlyph(h: number): string {
  if (h === 0) return "12a";
  if (h === 12) return "12p";
  if (h < 12) return `${h}a`;
  return `${h - 12}p`;
}

function DayRow({
  day,
  dayIdx,
  selected,
  onCellPointerDown,
  onCellPointerEnter,
  cellRefs,
}: {
  day: string;
  dayIdx: number;
  selected: Set<string>;
  onCellPointerDown: (
    e: React.PointerEvent<HTMLButtonElement>,
    dayIdx: number,
    hourIdx: number
  ) => void;
  onCellPointerEnter: (dayIdx: number, hourIdx: number) => void;
  cellRefs: React.MutableRefObject<(HTMLButtonElement | null)[][]>;
}) {
  return (
    <>
      <div
        style={{
          fontFamily: "var(--font-fraunces)",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {day}
      </div>
      {HOURS.map((absHour, hourIdx) => {
        const on = selected.has(cellKey(dayIdx, absHour));
        return (
          <button
            key={absHour}
            ref={(el) => {
              cellRefs.current[dayIdx][hourIdx] = el;
            }}
            type="button"
            aria-label={`${day} ${absHour}:00 ${on ? "active" : "off"}`}
            data-cell-day={dayIdx}
            data-cell-hour={hourIdx}
            onPointerDown={(e) => onCellPointerDown(e, dayIdx, hourIdx)}
            onPointerEnter={() => onCellPointerEnter(dayIdx, hourIdx)}
            style={{
              height: 22,
              borderRadius: 3,
              background: on ? "var(--fern)" : "var(--paper-deep)",
              border: "1px solid var(--ink-soft)",
              cursor: "pointer",
              opacity: on ? 1 : 0.55,
              padding: 0,
              touchAction: "none",
              transition: "background .08s, opacity .08s",
            }}
          />
        );
      })}
    </>
  );
}

// -----------------------------------------------------------------------------
// Utility overlay (dropdown)
// -----------------------------------------------------------------------------

function UtilityOverlay({ hourUtility }: { hourUtility: HourUtilityMap }) {
  const [open, setOpen] = useState(false);
  // Decay-on-read at component-mount time. The user opens settings rarely
  // enough that re-decaying once per render is fine.
  const decayed = useMemo(() => {
    const now = new Date();
    const map = new Map<string, number>();
    for (const [key, cell] of Object.entries(hourUtility)) {
      if (!cell) continue;
      map.set(key, decayCell(cell.v, cell.t, now));
    }
    return map;
  }, [hourUtility]);

  const summary = useMemo(() => {
    let entries = 0;
    let pos = 0;
    let neg = 0;
    let bestKey: string | null = null;
    let bestVal = -Infinity;
    let worstKey: string | null = null;
    let worstVal = Infinity;
    for (const [key, v] of decayed) {
      entries++;
      if (v > 0) pos++;
      if (v < 0) neg++;
      if (v > bestVal) {
        bestVal = v;
        bestKey = key;
      }
      if (v < worstVal) {
        worstVal = v;
        worstKey = key;
      }
    }
    return { entries, pos, neg, bestKey, bestVal, worstKey, worstVal };
  }, [decayed]);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{
        marginTop: 14,
        background: "var(--paper-deep)",
        border: "1px solid var(--ink-soft)",
        borderRadius: 8,
        padding: "8px 12px",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontFamily: "var(--font-fraunces)",
          fontSize: 13,
          color: "var(--ink-soft)",
          listStyle: "none",
        }}
      >
        <span
          aria-hidden
          style={{ display: "inline-block", width: 10, marginRight: 4 }}
        >
          {open ? "▾" : "▸"}
        </span>
        learned utility — {summary.entries === 0
          ? "no signals yet"
          : `${summary.pos} bright, ${summary.neg} dim`}
      </summary>
      {open && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "48px repeat(24, 1fr)",
              gap: 2,
              alignItems: "center",
            }}
          >
            <div />
            {HOURS.map((h) => (
              <div
                key={h}
                style={{
                  fontFamily: "var(--font-jetbrains)",
                  fontSize: 9,
                  color: "var(--ink-faded)",
                  textAlign: "center",
                }}
              >
                {hourGlyph(h)}
              </div>
            ))}
            {DAY_LABELS.map((day) => (
              <UtilityRow
                key={day}
                day={day}
                dow={DAY_INDEX_FOR_LABEL[day]}
                decayed={decayed}
              />
            ))}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginTop: 10,
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 12,
              color: "var(--ink-faded)",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>worse</span>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 80,
                  height: 10,
                  borderRadius: 3,
                  background:
                    "linear-gradient(to right, hsl(0 85% 55%), hsl(60 30% 90%), hsl(120 85% 50%))",
                  border: "1px solid var(--ink-soft)",
                }}
              />
              <span>better</span>
            </div>
            <div>
              {summary.bestKey ? (
                <>
                  fern&apos;s favorite hour: <code>{summary.bestKey}</code> ({summary.bestVal.toFixed(1)})
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </details>
  );
}

function UtilityRow({
  day,
  dow,
  decayed,
}: {
  day: string;
  dow: number;
  decayed: Map<string, number>;
}) {
  return (
    <>
      <div
        style={{
          fontFamily: "var(--font-fraunces)",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {day}
      </div>
      {HOURS.map((absHour) => {
        const v = decayed.get(`${dow}-${pad2(absHour)}`) ?? 0;
        const bg = v === 0 ? "hsl(60 20% 95%)" : utilityColor(v);
        return (
          <div
            key={absHour}
            title={`${day} ${absHour}:00 — ${v.toFixed(2)}`}
            style={{
              height: 18,
              borderRadius: 3,
              background: bg,
              border: "1px solid var(--ink-soft)",
            }}
          />
        );
      })}
    </>
  );
}

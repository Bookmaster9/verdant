"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TimeWindow, TimeWindows } from "@/types/plan";

const FIRST_HOUR = 7;
const LAST_HOUR = 21; // exclusive — show 7a..8p (14 cells)
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }).map(
  (_, i) => FIRST_HOUR + i
);
const DRAG_THRESHOLD_PX = 4;

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LABEL_TO_KEY: Record<string, string> = {
  Mon: "1",
  Tue: "2",
  Wed: "3",
  Thu: "4",
  Fri: "5",
  Sat: "6",
  Sun: "0",
};

interface Props {
  value: TimeWindows;
  onChange: (next: TimeWindows) => void;
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

/** Convert TimeWindows to a Set<"dayIdx-absHour"> covering selected hours.
 *
 * Defensive: tolerates a legacy single-window value (`{start, end}`) on a day
 * key in case a stale prop bypasses the page-level normalizer. */
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
      // Each cell H represents the interval [H:00, H+1:00). Round-trip safely
      // by including the start hour and excluding the end hour.
      const startHour = sh + (sm > 0 ? 1 : 0);
      const endHour = em > 0 ? eh + 1 : eh;
      for (let h = startHour; h < endHour; h++) {
        out.add(cellKey(dayIdx, h));
      }
    }
  }
  return out;
}

/**
 * Coalesce per-hour selections back into the smallest set of {start, end}
 * ranges per day. Empty days are omitted from the output.
 */
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
          end: `${pad2(runEnd)}:00`,
        });
        runStart = hours[i];
        runEnd = hours[i] + 1;
      }
    }
    ranges.push({
      start: `${pad2(runStart)}:00`,
      end: `${pad2(runEnd)}:00`,
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

export function TimeWindowsHeatmap({ value, onChange }: Props) {
  // Internal source-of-truth: a Set of selected "dayIdx-absHour" cells.
  // Initialized from props; resynced when the parent commits a new value.
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

  // Track latest selected state in a ref so the window pointerup handler
  // can commit without stale closure.
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Drag state.
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  // Cell refs (for outline geometry).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef<(HTMLButtonElement | null)[][]>(
    Array.from({ length: 7 }, () => Array(HOURS.length).fill(null))
  );

  // Outline rect (in container-local coordinates).
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

  // Window-level pointermove (threshold), pointerup (commit), keydown (Esc).
  // Re-attached when drag toggles between null/non-null.
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
        // Treat as a click — toggle the origin cell.
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
      // Cancel: revert to snapshot, do not commit.
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
    // Re-attach only when drag toggles null/non-null. The handlers read latest
    // state via refs so we don't need them in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag === null]);

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          display: "grid",
          gridTemplateColumns: "60px repeat(14, 1fr)",
          gap: 4,
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
              fontSize: 10,
              color: "var(--ink-faded)",
              textAlign: "center",
            }}
          >
            {h <= 12 ? h : h - 12}
            {h < 12 ? "a" : "p"}
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

        {/* drag-rectangle outline overlay */}
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
    </div>
  );
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
          fontSize: 14,
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
              borderRadius: 4,
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

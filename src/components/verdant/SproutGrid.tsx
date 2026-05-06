"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SproutCard } from "./SproutCard";
import { colorForSprout } from "@/lib/sprout-color";

export type SortMode = "deadline" | "created" | "custom";

export interface SproutGridItem {
  id: string;
  title: string;
  summary?: string;
  growth: number;
  daysToBloom: number;
  tags: string[];
  mood: "happy" | "tired" | "sleepy";
  /** ISO string used by sort modes. */
  createdAtISO: string;
  deadlineISO: string;
}

const DRAG_THRESHOLD_PX = 6;

type DragState = {
  fromIndex: number;
  origin: { x: number; y: number };
  pointer: { x: number; y: number };
  active: boolean; // true once threshold crossed
  hoverIndex: number;
};

function applySort(
  items: SproutGridItem[],
  mode: SortMode,
  customOrder: string[]
): SproutGridItem[] {
  if (mode === "deadline") {
    return [...items].sort((a, b) => a.deadlineISO.localeCompare(b.deadlineISO));
  }
  if (mode === "created") {
    // Newest first.
    return [...items].sort((a, b) => b.createdAtISO.localeCompare(a.createdAtISO));
  }
  // Custom: order by customOrder index; sprouts not in the list go to the end
  // by creation date (newest first), so freshly-planted ones land below the
  // user's curated arrangement.
  const idx = new Map(customOrder.map((id, i) => [id, i] as const));
  const inOrder: SproutGridItem[] = [];
  const orphans: SproutGridItem[] = [];
  for (const item of items) {
    if (idx.has(item.id)) inOrder.push(item);
    else orphans.push(item);
  }
  inOrder.sort((a, b) => (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0));
  orphans.sort((a, b) => b.createdAtISO.localeCompare(a.createdAtISO));
  return [...inOrder, ...orphans];
}

export function SproutGrid({
  sprouts,
  initialSortMode,
  initialCustomOrder,
}: {
  sprouts: SproutGridItem[];
  initialSortMode: SortMode;
  initialCustomOrder: string[];
}) {
  const router = useRouter();
  const [sortMode, setSortMode] = useState<SortMode>(initialSortMode);
  const [customOrder, setCustomOrder] = useState<string[]>(initialCustomOrder);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const sortedRef = useRef<SproutGridItem[]>([]);

  // Suppress click navigation immediately after a drag completes (pointerup
  // fires *before* click; we want the dropped click swallowed).
  const justDraggedIds = useRef<Set<string>>(new Set());

  const sorted = applySort(sprouts, sortMode, customOrder);
  sortedRef.current = sorted;

  // Persist a sort change (mode and/or custom order) to UserPreference.
  const persist = useCallback(
    async (mode: SortMode, order: string[]) => {
      try {
        await fetch("/api/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sproutSortMode: mode,
            sproutCustomOrder: order,
          }),
        });
        router.refresh();
      } catch {
        /* non-fatal — local state already updated */
      }
    },
    [router]
  );

  // Switch sort mode via the picker. Custom mode keeps the current order.
  function pickMode(mode: SortMode) {
    setSortMode(mode);
    if (mode === "custom") {
      // Snapshot the current visible order as the new custom order.
      const snap = sorted.map((s) => s.id);
      setCustomOrder(snap);
      void persist("custom", snap);
    } else {
      void persist(mode, customOrder);
    }
  }

  function onCardPointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    fromIndex: number
  ) {
    if (e.button !== 0) return;
    const next: DragState = {
      fromIndex,
      origin: { x: e.clientX, y: e.clientY },
      pointer: { x: e.clientX, y: e.clientY },
      active: false,
      hoverIndex: fromIndex,
    };
    dragRef.current = next;
    setDrag(next);
  }

  // Window-level move/up so dragging keeps tracking even when the pointer
  // wanders outside the original card.
  useEffect(() => {
    if (!drag) return;
    function move(e: PointerEvent) {
      const cur = dragRef.current;
      if (!cur) return;
      const dx = e.clientX - cur.origin.x;
      const dy = e.clientY - cur.origin.y;
      const moved = Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
      if (!cur.active && !moved) return;
      e.preventDefault();
      // Find which card is under the pointer (by element containing the point).
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const tile = el?.closest<HTMLElement>("[data-sprout-tile]");
      const hoverIndex = tile
        ? Number(tile.dataset.sproutTile)
        : cur.hoverIndex;
      const next: DragState = {
        ...cur,
        active: true,
        pointer: { x: e.clientX, y: e.clientY },
        hoverIndex: Number.isFinite(hoverIndex) ? hoverIndex : cur.hoverIndex,
      };
      dragRef.current = next;
      setDrag(next);
    }
    function up() {
      const cur = dragRef.current;
      if (!cur) return;
      if (cur.active && cur.fromIndex !== cur.hoverIndex) {
        // Build the reordered list of IDs from the current sorted view, then
        // promote sortMode to "custom" and persist.
        const ids = sortedRef.current.map((s) => s.id);
        const [moved] = ids.splice(cur.fromIndex, 1);
        ids.splice(cur.hoverIndex, 0, moved);
        setSortMode("custom");
        setCustomOrder(ids);
        void persist("custom", ids);
        // Suppress the click that's about to fire on the dragged card.
        justDraggedIds.current.add(moved);
        setTimeout(() => justDraggedIds.current.delete(moved), 250);
      }
      dragRef.current = null;
      setDrag(null);
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [drag, persist]);

  // Compute the visual order during an active drag — the dragged item slides
  // out of its original slot and into the hover slot live so the user sees
  // the reorder happening in real time.
  let visual = sorted;
  if (drag?.active && drag.fromIndex !== drag.hoverIndex) {
    const arr = [...sorted];
    const [moved] = arr.splice(drag.fromIndex, 1);
    arr.splice(drag.hoverIndex, 0, moved);
    visual = arr;
  }

  return (
    <>
      {/* Sort picker */}
      <div
        style={{
          display: "flex",
          gap: 6,
          marginBottom: 14,
          alignItems: "center",
          fontFamily: "var(--font-fraunces)",
          fontSize: 13,
        }}
      >
        <span className="tag">sort by</span>
        {(
          [
            { id: "deadline", label: "nearest deadline" },
            { id: "created", label: "newest" },
            { id: "custom", label: "custom" },
          ] as const
        ).map((opt) => {
          const active = sortMode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => pickMode(opt.id)}
              className={active ? "btn primary sm" : "btn sm"}
              style={{
                padding: "4px 10px",
                fontSize: 12,
              }}
            >
              {opt.label}
            </button>
          );
        })}
        {sortMode === "custom" && (
          <span
            className="hand"
            style={{
              fontSize: 12,
              color: "var(--ink-faded)",
              marginLeft: 4,
            }}
          >
            drag tiles to rearrange
          </span>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 24,
        }}
      >
        {visual.map((s, i) => {
          const isDragged = drag?.active && s.id === sorted[drag.fromIndex]?.id;
          const c = colorForSprout(s.id);
          return (
            <div
              key={s.id}
              data-sprout-tile={i}
              onPointerDown={(e) => onCardPointerDown(e, i)}
              onClickCapture={(e) => {
                if (justDraggedIds.current.has(s.id)) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              style={{
                cursor: drag?.active ? "grabbing" : "grab",
                touchAction: "none",
                transform: isDragged ? "scale(1.03)" : "none",
                opacity: isDragged ? 0.85 : 1,
                boxShadow: isDragged ? "4px 6px 0 var(--ink)" : undefined,
                transition: drag?.active
                  ? "transform .12s, opacity .12s"
                  : "transform .12s, opacity .12s, box-shadow .12s",
                borderRadius: 12,
                position: "relative",
              }}
            >
              {/* Color dot in the corner so the sprout's identity is visible
                  on the schedule grid and timeline too. */}
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  top: 10,
                  left: 10,
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: c.swatch,
                  border: "1.25px solid var(--ink)",
                  zIndex: 2,
                }}
              />
              <SproutCard
                href={`/plan/${s.id}`}
                title={s.title}
                summary={s.summary}
                growth={s.growth}
                daysToBloom={s.daysToBloom}
                tags={s.tags.length > 0 ? s.tags : ["learning"]}
                mood={s.mood}
              />
            </div>
          );
        })}
        <Link
          href="/plan/new"
          className="dotted"
          style={{
            background: "transparent",
            padding: 24,
            minHeight: 320,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: "var(--ink-faded)",
            textDecoration: "none",
          }}
        >
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: "50%",
              background: "var(--paper-warm)",
              border: "1.5px dashed var(--ink-soft)",
              display: "grid",
              placeItems: "center",
              fontFamily: "var(--font-fraunces)",
              fontSize: 36,
              color: "var(--ink-faded)",
            }}
          >
            +
          </div>
          <div className="hand" style={{ fontSize: 15, color: "var(--ink-soft)" }}>
            an empty plot
          </div>
          <div style={{ fontSize: 13 }}>plant something new</div>
        </Link>
      </div>
    </>
  );
}

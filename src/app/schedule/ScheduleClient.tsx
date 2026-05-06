"use client";

import { useState } from "react";
import {
  WeekGrid,
  type VerdantBlock,
  type ExternalBlock,
} from "@/components/verdant/WeekGrid";
import type { TimeWindows } from "@/types/plan";
import { colorForSprout } from "@/lib/sprout-color";
import { OneTimeHint } from "@/components/verdant/OneTimeHint";

export interface SproutFilterOption {
  id: string;
  title: string;
}

/**
 * Client wrapper around the legend (with multi-select sprout chips) and the
 * WeekGrid. The legend chips toggle which sprouts' Verdant blocks are visible
 * — local state only, default all-on. Click a chip to hide a sprout, click
 * again to bring it back; "all" resets.
 */
export function ScheduleClient({
  verdant,
  external,
  timeWindows,
  mondayISO,
  startDateISO,
  deadlineISO,
  weekOffset,
  dateLabels,
  todayIndex,
  sproutFilters,
}: {
  verdant: VerdantBlock[];
  external: ExternalBlock[];
  timeWindows: TimeWindows;
  mondayISO: string;
  startDateISO: string;
  deadlineISO: string;
  weekOffset: number;
  dateLabels: string[];
  todayIndex: number | null;
  sproutFilters: SproutFilterOption[];
}) {
  // Visible sprout IDs. Empty = all on (default). Anything in the set means
  // "explicitly hidden." Inverted because the natural "all-on" default
  // shouldn't require pre-populating with all IDs (and stays correct as new
  // sprouts appear without a state migration).
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allOn = hidden.size === 0;
  const visibleVerdant = allOn
    ? verdant
    : verdant.filter((b) => !hidden.has(planIdOf(b)));

  return (
    <>
      <OneTimeHint
        storageKey="verdant.tooltip.schedule.dismissed"
        emoji="📆"
      >
        <strong>Drag</strong> any session to move it — locked sessions stay put
        on reschedules. <strong>Click</strong> a sprout chip to filter. Past
        sessions are immutable.
      </OneTimeHint>

      {/* legend */}
      <div
        className="ink-card soft"
        style={{
          padding: "10px 14px",
          marginBottom: 12,
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span className="tag">legend</span>
        {[
          { label: "lesson", bg: "var(--leaf-pale)" },
          { label: "review", bg: "var(--sky-soft)" },
          { label: "milestone", bg: "var(--sun-soft)" },
        ].map((it) => (
          <span
            key={it.label}
            style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                background: it.bg,
                border: "1.25px solid var(--ink)",
                borderRadius: 4,
              }}
            />{" "}
            {it.label}
          </span>
        ))}
        <span style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <span
            style={{
              width: 16,
              height: 16,
              background: "#e6d8c0",
              border: "1.25px solid var(--ink-faded)",
              borderRadius: 4,
              opacity: 0.6,
            }}
          />{" "}
          existing event
        </span>
        {sproutFilters.length > 0 && (
          <>
            <span style={{ marginLeft: 8 }} className="tag">
              sprouts
            </span>
            {!allOn && (
              <button
                type="button"
                onClick={() => setHidden(new Set())}
                className="btn sm ghost"
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                show all
              </button>
            )}
            {sproutFilters.map((f) => {
              const isHidden = hidden.has(f.id);
              const c = colorForSprout(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => toggle(f.id)}
                  className="chip"
                  title={isHidden ? "click to show" : "click to hide"}
                  style={{
                    background: isHidden ? "transparent" : c.chipBg,
                    border: "1.25px solid var(--ink)",
                    color: "inherit",
                    cursor: "pointer",
                    opacity: isHidden ? 0.45 : 1,
                    textDecoration: isHidden ? "line-through" : "none",
                  }}
                >
                  {f.title}
                </button>
              );
            })}
          </>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "var(--font-fraunces)",
            fontStyle: "italic",
            fontSize: 14,
            color: "var(--ink-faded)",
          }}
        >
          click a chip to filter · click a session to open · drag to move
        </span>
      </div>

      <WeekGrid
        dateLabels={dateLabels}
        todayIndex={todayIndex}
        verdant={visibleVerdant}
        external={external}
        timeWindows={timeWindows}
        mondayISO={mondayISO}
        startDateISO={startDateISO}
        deadlineISO={deadlineISO}
        weekOffset={weekOffset}
      />
    </>
  );
}

/** Helper: pull the plan id off a VerdantBlock without creating a new field. */
function planIdOf(b: VerdantBlock): string {
  return b.planId;
}

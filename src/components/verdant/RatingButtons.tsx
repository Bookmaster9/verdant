"use client";

import type { TaskType } from "@/types/plan";

/**
 * FSRS-style 4-button rating used across all task types. Numeric values are
 * {1, 2, 4, 5} so the slot-effectiveness signal stays on the same numeric scale
 * as the previous 1-5 stars without disturbing existing smoothing math.
 *
 * Stored value is what gets persisted; the prompt label varies by task type.
 */
export const RATING_VALUES = [1, 2, 4, 5] as const;
export type RatingValue = (typeof RATING_VALUES)[number];

export const RATING_LABELS: Record<RatingValue, string> = {
  1: "Again",
  2: "Hard",
  4: "Good",
  5: "Easy",
};

export const RATING_HINTS_BY_TYPE: Record<TaskType, Record<RatingValue, string>> = {
  review: {
    1: "couldn't recall",
    2: "recalled with effort",
    4: "recalled cleanly",
    5: "trivial",
  },
  lesson: {
    1: "didn't land",
    2: "tough but got through",
    4: "solid session",
    5: "breezed through",
  },
  milestone: {
    1: "didn't land",
    2: "tough but got through",
    4: "solid session",
    5: "breezed through",
  },
};

export const RATING_PROMPT_BY_TYPE: Record<TaskType, string> = {
  review: "How did the recall go?",
  lesson: "How did this session go?",
  milestone: "How did this milestone go?",
};

export function RatingButtons({
  value,
  onChange,
  taskType,
  disabled,
}: {
  value: number | null | undefined;
  onChange: (v: RatingValue) => void;
  taskType: TaskType;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        style={{
          fontFamily: "var(--font-fraunces)",
          fontStyle: "italic",
          fontSize: 13,
          color: "var(--ink-soft)",
        }}
      >
        {RATING_PROMPT_BY_TYPE[taskType]}
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {RATING_VALUES.map((v) => {
          const selected = value === v;
          return (
            <button
              key={v}
              type="button"
              disabled={disabled}
              onClick={() => onChange(v)}
              className={selected ? "btn primary" : "btn"}
              title={RATING_HINTS_BY_TYPE[taskType][v]}
              style={{
                fontSize: 13,
                padding: "6px 12px",
                cursor: disabled ? "default" : "pointer",
                opacity: disabled ? 0.6 : 1,
              }}
            >
              {RATING_LABELS[v]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

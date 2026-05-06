"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RatingButtons, type RatingValue } from "@/components/verdant/RatingButtons";
import type { TaskType } from "@/types/plan";

/**
 * Coupled rate-then-mark-done flow.
 *
 * Two states:
 *  - "to-do": rating buttons live; "mark done" disabled until a rating is picked.
 *    Clicking "mark done" sends one atomic PATCH ({completed:true, rating}).
 *  - "completed (in journal)": rating buttons let the user re-rate (PATCH {rating}).
 *    A "re-open" button moves the task back to to-do (PATCH {completed:false}).
 *
 * Rating-only changes never persist for an uncompleted task — they live as
 * pendingRating in local state until the user commits.
 */
export function SessionControls({
  planId,
  taskId,
  taskType,
  initialDone,
  initialRating,
}: {
  planId: string;
  taskId: string;
  taskType: TaskType;
  initialDone: boolean;
  initialRating: number;
}) {
  const r = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(initialDone);
  const [committedRating, setCommittedRating] = useState(initialRating);
  const [pendingRating, setPendingRating] = useState<number>(initialRating);
  const [error, setError] = useState<string | null>(null);

  const ratingForDisplay = done ? committedRating : pendingRating;
  const canMarkDone = !done && pendingRating > 0;

  async function patch(body: {
    completed?: boolean;
    rating?: number;
  }): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/plans/${planId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskFeedback: { taskId, ...body } }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error || "Couldn't save");
        return false;
      }
      r.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!canMarkDone) return;
    const ok = await patch({ completed: true, rating: pendingRating });
    if (ok) {
      setDone(true);
      setCommittedRating(pendingRating);
    }
  }

  async function reopen() {
    const ok = await patch({ completed: false });
    if (ok) {
      setDone(false);
      setCommittedRating(0);
      setPendingRating(0);
    }
  }

  async function reRate(v: RatingValue) {
    // Already-committed: persist immediately.
    const ok = await patch({ rating: v });
    if (ok) setCommittedRating(v);
  }

  return (
    <div
      className="ink-card soft"
      style={{
        padding: 14,
        background: done ? "var(--leaf-pale)" : "var(--paper)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div className="tag">
        {done ? "in your journal" : "tend this session"}
      </div>

      <RatingButtons
        value={ratingForDisplay || null}
        taskType={taskType}
        disabled={busy}
        onChange={(v) => {
          if (done) {
            void reRate(v);
          } else {
            setPendingRating(v);
          }
        }}
      />

      {!done ? (
        <>
          <button
            type="button"
            className={canMarkDone ? "btn primary" : "btn"}
            onClick={() => void commit()}
            disabled={!canMarkDone || busy}
            style={{
              justifyContent: "center",
              opacity: canMarkDone ? 1 : 0.55,
              cursor: canMarkDone ? "pointer" : "not-allowed",
            }}
            title={canMarkDone ? undefined : "Pick a rating first"}
          >
            {busy ? "saving…" : "mark done"}
          </button>
          {pendingRating === 0 && (
            <span
              className="hand"
              style={{ fontSize: 13, color: "var(--ink-faded)", textAlign: "center" }}
            >
              pick a rating, then mark it done.
            </span>
          )}
        </>
      ) : (
        <>
          <div
            className="hand"
            style={{ fontSize: 13, color: "var(--ink-soft)", textAlign: "center" }}
          >
            in journal · click a rating to update
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => void reopen()}
            disabled={busy}
            style={{ justifyContent: "center" }}
            title="Move back to to-do and reschedule"
          >
            {busy ? "saving…" : "↺ re-open"}
          </button>
        </>
      )}

      {error && (
        <span
          className="hand"
          style={{ color: "var(--berry)", fontSize: 13, textAlign: "center" }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

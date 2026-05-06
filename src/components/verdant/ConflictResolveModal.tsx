"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ConflictResolveModal({
  open,
  onClose,
  planId,
  sessionId,
  sessionTitle,
}: {
  open: boolean;
  onClose: () => void;
  planId: string;
  sessionId: string;
  sessionTitle: string;
}) {
  const r = useRouter();
  const [busy, setBusy] = useState<null | "move" | "skip">(null);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  async function run(action: "move_to_next_free" | "skip_and_rebalance") {
    setBusy(action === "move_to_next_free" ? "move" : "skip");
    setErr(null);
    try {
      const res = await fetch(`/api/plans/${planId}/resolve-calendar-conflict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, action }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setErr(j.error || "Something went wrong.");
        setBusy(null);
        return;
      }
      setBusy(null);
      onClose();
      r.refresh();
    } catch {
      setErr("Network error.");
      setBusy(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-resolve-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(43, 36, 24, 0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        padding: 20,
      }}
    >
      <div
        className="ink-card"
        style={{
          width: "min(440px, 100%)",
          padding: 24,
          background: "var(--paper-warm)",
          position: "relative",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            fontFamily: "var(--font-jetbrains)",
            fontSize: 11,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "var(--berry)",
            marginBottom: 4,
          }}
        >
          calendar overlap
        </div>
        <h3
          id="conflict-resolve-title"
          className="serif-display"
          style={{
            fontSize: 26,
            margin: "0 0 10px",
            fontWeight: 500,
          }}
        >
          This session bumps your calendar
        </h3>
        <p
          style={{
            fontFamily: "var(--font-fraunces)",
            fontSize: 14,
            lineHeight: 1.5,
            color: "var(--ink-soft)",
            margin: "0 0 16px",
          }}
        >
          <strong>{sessionTitle}</strong> overlaps another event on Google Calendar.
          Choose how to handle it.
        </p>
        {err && (
          <p
            style={{
              fontFamily: "var(--font-fraunces)",
              fontSize: 13,
              color: "var(--berry)",
              margin: "0 0 12px",
            }}
          >
            {err}
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            type="button"
            className="btn primary"
            disabled={busy !== null}
            onClick={() => run("move_to_next_free")}
          >
            {busy === "move" ? "moving…" : "Move to next free slot"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => run("skip_and_rebalance")}
          >
            {busy === "skip" ? "rebalancing…" : "Skip session & rebalance plan"}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy !== null}
            onClick={onClose}
          >
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}

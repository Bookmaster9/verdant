"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { format, parseISO } from "date-fns";

export interface LockedConflict {
  sessionId: string;
  sessionTitle: string;
  sessionStart: string;
  sessionEnd: string;
  overlappingCount: number;
}

export function ConflictBanner({
  planId,
  conflicts,
}: {
  planId: string;
  conflicts: LockedConflict[];
}) {
  const r = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const visible = conflicts.filter((c) => !dismissed.has(c.sessionId));
  if (visible.length === 0) return null;

  async function unlockAndReschedule(sessionId: string) {
    setBusy(sessionId);
    await fetch(`/api/plans/${planId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lockSession: { sessionId, locked: false } }),
    });
    await fetch(`/api/plans/${planId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rescheduleFrom: new Date().toISOString() }),
    });
    setBusy(null);
    r.refresh();
  }

  function keepHere(sessionId: string) {
    setDismissed((d) => new Set(d).add(sessionId));
  }

  return (
    <div
      className="ink-card"
      style={{
        padding: 14,
        background: "var(--paper-warm)",
        borderColor: "var(--berry)",
        marginTop: 12,
        marginBottom: 12,
      }}
    >
      <div
        className="tag"
        style={{ marginBottom: 6, color: "var(--berry)" }}
      >
        calendar conflicts
      </div>
      <div
        style={{
          fontFamily: "var(--font-fraunces)",
          fontSize: 14,
          color: "var(--ink)",
          marginBottom: 10,
        }}
      >
        {visible.length} locked session{visible.length === 1 ? "" : "s"} now
        overlap{visible.length === 1 ? "s" : ""} an event on your calendar.
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {visible.map((c) => (
          <li
            key={c.sessionId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              padding: "8px 0",
              borderTop: "1px dashed var(--ink-faded)",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-fraunces)",
                fontSize: 13,
                flex: 1,
                minWidth: 200,
              }}
            >
              <strong>{c.sessionTitle}</strong>{" "}
              <span style={{ color: "var(--ink-faded)" }}>
                {format(parseISO(c.sessionStart), "EEE MMM d, h:mma")}
              </span>
            </div>
            <button
              type="button"
              onClick={() => unlockAndReschedule(c.sessionId)}
              disabled={busy === c.sessionId}
              className="btn primary sm"
            >
              {busy === c.sessionId ? "moving…" : "unlock & reschedule"}
            </button>
            <button
              type="button"
              onClick={() => keepHere(c.sessionId)}
              className="btn sm ghost"
            >
              keep here
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

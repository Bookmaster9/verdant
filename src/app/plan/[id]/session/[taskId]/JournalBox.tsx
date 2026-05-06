"use client";

import { useEffect, useRef, useState } from "react";
import { format } from "date-fns";

type Status = "idle" | "saving" | "saved" | "error";

/**
 * Per-task journal entry. Stored in `TaskJournal` keyed by (planId, taskId).
 * Saves on blur and on a 1.5s debounce while typing — no explicit save button
 * needed, but we surface the status text so the user can see when the last
 * write landed.
 */
export function JournalBox({
  planId,
  taskId,
  initialBody,
  initialUpdatedAt,
  taskType,
}: {
  planId: string;
  taskId: string;
  initialBody: string;
  initialUpdatedAt: string | null;
  taskType: "lesson" | "review" | "milestone";
}) {
  const [body, setBody] = useState(initialBody);
  const [status, setStatus] = useState<Status>("idle");
  const [updatedAt, setUpdatedAt] = useState<string | null>(initialUpdatedAt);
  const [error, setError] = useState<string | null>(null);
  const lastSavedRef = useRef(initialBody);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function save(next: string): Promise<void> {
    if (next === lastSavedRef.current) return;
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(
        `/api/plans/${planId}/journal/${taskId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: next }),
        }
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setError(j.error || "Couldn't save");
        return;
      }
      const j = (await res.json()) as {
        body: string;
        updatedAt: string | null;
      };
      lastSavedRef.current = next;
      setUpdatedAt(j.updatedAt);
      setStatus("saved");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Couldn't save");
    }
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setBody(v);
    setStatus("idle");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void save(v);
    }, 1500);
  }

  function onBlur() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void save(body);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const placeholder =
    taskType === "milestone"
      ? "How did the run feel? Where did you slip? What surprised you? Drop notes for future you."
      : taskType === "review"
        ? "What still felt fuzzy on the second pass? What clicked this time that didn't before?"
        : "Notes, questions, things you stumbled on, the deliverable as you got it down. Future-you reads this.";

  const statusText: string =
    status === "saving"
      ? "saving…"
      : status === "error"
        ? error || "couldn't save"
        : updatedAt
          ? `last saved ${format(new Date(updatedAt), "MMM d · h:mm a")}`
          : "not saved yet";

  return (
    <div
      className="ink-card"
      style={{
        padding: 18,
        background: "var(--paper-warm)",
        position: "relative",
      }}
    >
      <div className="tag" style={{ marginBottom: 6 }}>
        your journal
      </div>
      <h3
        className="serif-display"
        style={{ fontSize: 20, margin: "0 0 4px", fontWeight: 500 }}
      >
        Reviews & thoughts
      </h3>
      <div
        style={{
          fontFamily: "var(--font-fraunces)",
          fontStyle: "italic",
          fontSize: 13,
          color: "var(--ink-soft)",
          marginBottom: 10,
        }}
      >
        Write as you go — saves automatically.
      </div>
      <textarea
        value={body}
        onChange={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        rows={9}
        spellCheck
        style={{
          width: "100%",
          padding: "10px 12px",
          background: "var(--paper)",
          border: "1.5px solid var(--ink)",
          borderRadius: 8,
          fontFamily: "var(--font-fraunces)",
          fontSize: 14,
          lineHeight: 1.55,
          color: "var(--ink)",
          resize: "vertical",
          minHeight: 140,
          boxShadow: "2px 2px 0 var(--ink)",
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 8,
          fontFamily: "var(--font-jetbrains)",
          fontSize: 11,
          color:
            status === "error"
              ? "var(--berry)"
              : "var(--ink-faded)",
        }}
      >
        <span>{statusText}</span>
        <span>{body.length} chars</span>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const CONFIRM_TOKEN = "confirm";

export function DeleteSproutButton({
  planId,
  title,
}: {
  planId: string;
  title: string;
}) {
  const r = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setText("");
      setErr(null);
      // focus the input on open
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  const ready = text.trim().toLowerCase() === CONFIRM_TOKEN;

  async function onDelete() {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/plans/${planId}`, { method: "DELETE" });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(j.error || "Could not pull this sprout up");
      setBusy(false);
      return;
    }
    r.push("/dashboard");
    r.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="btn ghost"
        onClick={() => setOpen(true)}
        style={{
          fontSize: 13,
          color: "var(--berry)",
          borderColor: "transparent",
        }}
      >
        pull this sprout up
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-sprout-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
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
              className="tape"
              style={{
                left: "50%",
                marginLeft: -39,
                top: -10,
                transform: "rotate(-3deg)",
                background: "rgba(226, 152, 134, 0.55)",
                borderColor: "rgba(194, 90, 90, 0.5)",
              }}
            />
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
              the compost
            </div>
            <h3
              id="delete-sprout-title"
              className="serif-display"
              style={{
                fontSize: 26,
                margin: "0 0 10px",
                fontWeight: 500,
              }}
            >
              Pull{" "}
              <span style={{ fontStyle: "italic", color: "var(--moss-deep)" }}>
                {title}
              </span>{" "}
              up?
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
              This sprout, its phases, sessions, and ratings will be uprooted.
              Calendar events you&apos;ve already synced to Google will stay — you
              can clean those up there. <strong>This can&apos;t be undone.</strong>
            </p>
            <div className="field">
              <label htmlFor="delete-confirm">
                Type{" "}
                <span
                  className="mono"
                  style={{
                    background: "var(--paper-deep)",
                    padding: "1px 6px",
                    borderRadius: 4,
                    fontSize: 13,
                  }}
                >
                  {CONFIRM_TOKEN}
                </span>{" "}
                to uproot it
              </label>
              <input
                ref={inputRef}
                id="delete-confirm"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && ready) onDelete();
                }}
                placeholder="confirm"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {err && (
              <p
                className="hand"
                style={{ color: "var(--berry)", fontSize: 14, margin: "10px 0 0" }}
              >
                {err}
              </p>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
                marginTop: 18,
              }}
            >
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                keep tending
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={onDelete}
                disabled={!ready || busy}
                style={{
                  background: ready ? "var(--berry)" : "var(--paper-deep)",
                  color: ready ? "#f8f1de" : "var(--ink-faded)",
                  borderColor: "var(--ink)",
                }}
              >
                {busy ? "uprooting…" : "pull it up"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

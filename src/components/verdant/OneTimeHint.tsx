"use client";

import { useEffect, useState } from "react";

/**
 * Dismissible inline callout shown once per device per `storageKey`.
 *
 * Used for first-visit feature hints (rate-then-done flow on the session
 * page, drag-to-move on the schedule grid). localStorage-keyed so dismissal
 * is per-browser — onboarding completion in the DB is not enough because
 * tooltips are decorative and don't need cross-device sync.
 *
 * SSR-safe: renders nothing on the server, hydrates the dismissal state from
 * localStorage on mount. The brief flash is acceptable and avoids hydration
 * mismatches.
 */
export function OneTimeHint({
  storageKey,
  children,
  emoji,
}: {
  storageKey: string;
  children: React.ReactNode;
  emoji?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setMounted(true);
    if (typeof window === "undefined") return;
    try {
      const v = window.localStorage.getItem(storageKey);
      setDismissed(v === "1");
    } catch {
      setDismissed(false);
    }
  }, [storageKey]);

  function dismiss() {
    setDismissed(true);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(storageKey, "1");
      } catch {
        /* ignore quota / private mode */
      }
    }
  }

  if (!mounted || dismissed) return null;

  return (
    <div
      role="note"
      style={{
        background: "var(--sun-soft)",
        border: "1.25px solid var(--ink)",
        borderRadius: 12,
        padding: "10px 14px",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        marginBottom: 12,
        boxShadow: "2px 2px 0 var(--ink)",
        fontFamily: "var(--font-fraunces)",
        fontSize: 14,
        color: "var(--ink)",
        lineHeight: 1.4,
      }}
    >
      {emoji && (
        <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>
          {emoji}
        </span>
      )}
      <div style={{ flex: 1 }}>{children}</div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="dismiss tip"
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-jetbrains)",
          fontSize: 11,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--ink-faded)",
          padding: "2px 6px",
        }}
      >
        got it
      </button>
    </div>
  );
}

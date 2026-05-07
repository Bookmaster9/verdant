"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

/**
 * One-time notice shown after the calendar-scope migration: Verdant can no
 * longer reach events it previously created on the user's primary calendar,
 * so the user has to delete them manually. Dismissed via a small POST.
 */
export function LegacyEventsBanner() {
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  async function dismiss() {
    setBusy(true);
    try {
      await fetch("/api/calendar/dismiss-legacy-warning", { method: "POST" });
      setHidden(true);
    } catch {
      setBusy(false);
    }
  }

  return (
    <div
      className="ink-card"
      style={{
        marginBottom: 14,
        padding: 16,
        background: "var(--paper-warm)",
        borderColor: "var(--berry)",
      }}
    >
      <div className="tag" style={{ color: "var(--berry)", marginBottom: 4 }}>
        heads up
      </div>
      <p
        style={{
          fontFamily: "var(--font-fraunces)",
          fontSize: 14,
          lineHeight: 1.5,
          margin: "0 0 12px",
          color: "var(--ink)",
        }}
      >
        We changed how Verdant connects to Google Calendar so it asks for fewer
        permissions. Verdant can no longer manage the events it previously
        created on your main calendar — you&apos;ll want to delete those
        manually in Google Calendar. From now on, new sessions will land on a
        new <strong>Verdant</strong> calendar instead.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <a
          className="btn primary"
          href="https://calendar.google.com/"
          target="_blank"
          rel="noreferrer"
        >
          Open Google Calendar
        </a>
        <button
          type="button"
          className="btn"
          onClick={dismiss}
          disabled={busy}
        >
          {busy ? "dismissing…" : "Got it, dismiss"}
        </button>
      </div>
    </div>
  );
}

/**
 * Shown when the user denied one of the two calendar scopes via Google's
 * granular consent UI. Behavior is identical to "Google not connected" until
 * they reconnect, but we surface a clearer prompt instead of silent failure.
 */
export function ScopeIssueBanner({ issue }: { issue: string }) {
  const message =
    issue === "freebusy-denied"
      ? "Verdant can push sessions to Google but can't see when you're busy. Reconnect Google to plan around your meetings."
      : issue === "app-created-denied"
      ? "Verdant can see when you're busy but can't push sessions to Google. Reconnect Google to enable calendar push."
      : "Verdant needs both calendar permissions to plan around your meetings and push sessions. Reconnect Google to fix this.";

  return (
    <div
      className="ink-card"
      style={{
        marginBottom: 14,
        padding: 16,
        background: "var(--paper-warm)",
        borderColor: "var(--berry)",
      }}
    >
      <div className="tag" style={{ color: "var(--berry)", marginBottom: 4 }}>
        google calendar
      </div>
      <p
        style={{
          fontFamily: "var(--font-fraunces)",
          fontSize: 14,
          lineHeight: 1.5,
          margin: "0 0 12px",
          color: "var(--ink)",
        }}
      >
        {message}
      </p>
      <button
        type="button"
        className="btn primary"
        onClick={() => signIn("google")}
      >
        Reconnect Google
      </button>
    </div>
  );
}

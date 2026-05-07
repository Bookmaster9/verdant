"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TimeWindowsHeatmap } from "./TimeWindowsHeatmap";
import { Sprout } from "./art";
import type { TimeWindows } from "@/types/plan";
import { parseTimeWindowsJson } from "@/lib/default-preferences";
import { parseHourUtility } from "@/lib/hour-utility";

/**
 * One-time onboarding gate shown on `/plan/new` for first-time users.
 *
 * Surfaces the silent defaults (time windows + daily cap + calendar push) so
 * the user's first sprout doesn't get scheduled into wrong assumptions. The
 * "auto-fill from my calendar" button reads the past 7 days of calendar
 * events and infers free time slots — only enabled when the user opts into
 * calendar push (a unified consent for "Verdant may interact with my cal").
 *
 * Closes the modal via either path:
 *   - "save and continue" → persists settings + sets onboardedAt
 *   - "I'll use defaults — don't ask again" → only sets onboardedAt
 *
 * On either path the modal disappears and the /plan/new form becomes usable.
 */

interface Props {
  initialTimeWindowsJson: string;
  initialMaxMinutesDay: number;
  initialPushToCalendar: boolean;
  /** Raw `UserPreference.hourUtility` JSON. Drives the learned-utility overlay. */
  initialHourUtilityJson?: string | null;
  onDismiss: () => void;
}

export function OnboardingModal({
  initialTimeWindowsJson,
  initialMaxMinutesDay,
  initialPushToCalendar,
  initialHourUtilityJson,
  onDismiss,
}: Props) {
  const router = useRouter();
  const [tw, setTw] = useState<TimeWindows>(() =>
    parseTimeWindowsJson(initialTimeWindowsJson)
  );
  const [max, setMax] = useState(initialMaxMinutesDay);
  const [push, setPush] = useState(initialPushToCalendar);
  const [busy, setBusy] = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);
  const [autoFillMsg, setAutoFillMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function autoFill() {
    setAutoFilling(true);
    setAutoFillMsg(null);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/calendar-availability", {
        method: "POST",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error || "Couldn't read your calendar");
        return;
      }
      const j = (await res.json()) as { timeWindows: TimeWindows };
      setTw(j.timeWindows);
      setAutoFillMsg("filled from your last week — adjust below if needed");
    } catch {
      setError("Couldn't read your calendar — try again later.");
    } finally {
      setAutoFilling(false);
    }
  }

  async function saveAndContinue() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeWindows: tw,
          maxMinutesDay: max,
          pushToCalendar: push,
          onboardedNow: true,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error || "Couldn't save");
        return;
      }
      router.refresh();
      onDismiss();
    } finally {
      setBusy(false);
    }
  }

  async function skipUseDefaults() {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboardedNow: true }),
      });
      router.refresh();
      onDismiss();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(43, 36, 24, 0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        padding: 24,
      }}
    >
      <div
        className="ink-card"
        style={{
          background: "var(--paper-warm)",
          padding: 28,
          maxWidth: 720,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        {/* Intro */}
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 18 }}>
          <Sprout size={56} growth={0.5} />
          <div>
            <div className="tag" style={{ marginBottom: 4 }}>welcome</div>
            <h2
              id="onboarding-title"
              className="serif-display"
              style={{ fontSize: 28, margin: "0 0 6px", fontWeight: 500 }}
            >
              Before we plant your first sprout
            </h2>
            <p
              style={{
                fontFamily: "var(--font-fraunces)",
                fontSize: 14,
                lineHeight: 1.5,
                color: "var(--ink-soft)",
                margin: 0,
              }}
            >
              Verdant schedules sessions into your week using the time windows
              and daily limit you set here. You can change these any time in
              settings — but spending a minute now means your first sprout
              lands in the right places.
            </p>
          </div>
        </div>

        {/* Time windows */}
        <div style={{ marginBottom: 18 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <div>
              <div className="tag">when can fern plant?</div>
              <div
                style={{
                  fontFamily: "var(--font-fraunces)",
                  fontSize: 16,
                  fontWeight: 600,
                }}
              >
                Time windows
              </div>
            </div>
            <button
              type="button"
              className={push ? "btn sm" : "btn sm"}
              disabled={!push || autoFilling}
              onClick={() => void autoFill()}
              title={
                push
                  ? "fill from your last 7 days of calendar availability"
                  : "turn on calendar push to enable"
              }
              style={{
                opacity: push ? 1 : 0.5,
                cursor: push ? "pointer" : "not-allowed",
              }}
            >
              {autoFilling ? "reading…" : "↺ auto-fill from my calendar"}
            </button>
          </div>
          {autoFillMsg && (
            <div
              className="hand"
              style={{
                fontSize: 13,
                color: "var(--moss-deep)",
                marginBottom: 8,
              }}
            >
              {autoFillMsg}
            </div>
          )}
          <TimeWindowsHeatmap
            value={tw}
            onChange={setTw}
            hourUtility={parseHourUtility(initialHourUtilityJson ?? null)}
          />
        </div>

        {/* Daily cap */}
        <div style={{ marginBottom: 18 }}>
          <div className="tag">pacing</div>
          <div
            style={{
              fontFamily: "var(--font-fraunces)",
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            Daily limit
          </div>
          <div
            style={{
              fontFamily: "var(--font-fraunces)",
              fontWeight: 500,
              fontSize: 22,
              color: "var(--moss-deep)",
              textAlign: "center",
            }}
          >
            {max} min/day
          </div>
          <input
            type="range"
            min={15}
            max={180}
            step={15}
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--moss)" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span className="tag">15 min</span>
            <span className="tag">3 hr</span>
          </div>
        </div>

        {/* Calendar push */}
        <div style={{ marginBottom: 22 }}>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              fontSize: 14,
            }}
          >
            <input
              type="checkbox"
              checked={push}
              onChange={(e) => setPush(e.target.checked)}
              style={{
                width: 18,
                height: 18,
                accentColor: "var(--moss)",
                marginTop: 2,
              }}
            />
            <span>
              <strong style={{ display: "block" }}>
                push new sessions to my Google Calendar
              </strong>
              <span
                style={{
                  fontStyle: "italic",
                  fontSize: 12,
                  color: "var(--ink-faded)",
                }}
              >
                also enables auto-filling time windows from your past week.
              </span>
            </span>
          </label>
        </div>

        {error && (
          <div
            className="hand"
            style={{ color: "var(--berry)", fontSize: 13, marginBottom: 12 }}
          >
            {error}
          </div>
        )}

        {/* Actions */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => void skipUseDefaults()}
            disabled={busy}
            style={{
              background: "transparent",
              border: "none",
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 13,
              color: "var(--ink-faded)",
              textDecoration: "underline",
              textDecorationStyle: "dashed",
              cursor: busy ? "not-allowed" : "pointer",
              padding: 0,
            }}
          >
            I&apos;ll use defaults — don&apos;t ask again
          </button>
          <button
            type="button"
            onClick={() => void saveAndContinue()}
            disabled={busy}
            className="btn primary"
          >
            {busy ? "saving…" : "save and continue →"}
          </button>
        </div>
      </div>
    </div>
  );
}

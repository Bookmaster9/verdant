"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarIcon,
  GoogleG,
  SunArt,
  WateringCan,
  Mushroom,
} from "@/components/verdant/art";
import { TimeWindowsHeatmap } from "@/components/verdant/TimeWindowsHeatmap";
import { parseTimeWindowsJson } from "@/lib/default-preferences";
import type { TimeWindows } from "@/types/plan";

type Props = {
  maxMinutesDay: number;
  weeklyMinutesTarget: number | null;
  pushToCalendar: boolean;
  timeWindows: string;
  defaultJson: string;
  userEmail?: string | null;
};

const NUDGE_KEYS = ["morningBrief", "preSession", "weeklyReview"] as const;
type NudgeKey = (typeof NUDGE_KEYS)[number];
const NUDGE_LABELS: Record<NudgeKey, string> = {
  morningBrief: "morning brief — what's on the plot today",
  preSession: "10 min before each session",
  weeklyReview: "sunday evening reflection",
};
const NUDGE_STORAGE_KEY = "verdant.nudges";

function parseTimeWindows(raw: string, fallback: string): TimeWindows {
  // Normalize-on-read so legacy `{start, end}` rows lift cleanly into the
  // new `[{start, end}]` shape without a DB migration.
  const parsed = parseTimeWindowsJson(raw && raw !== "{}" ? raw : fallback);
  return parsed;
}

export function SettingsForm(p: Props) {
  const r = useRouter();
  const [max, setMax] = useState(p.maxMinutesDay);
  const [weekly, setWeekly] = useState<string>(
    p.weeklyMinutesTarget != null ? String(p.weeklyMinutesTarget) : ""
  );
  const [cal, setCal] = useState(p.pushToCalendar);
  const [tw, setTw] = useState<TimeWindows>(() =>
    parseTimeWindows(p.timeWindows, p.defaultJson)
  );
  const [nudges, setNudges] = useState<Record<NudgeKey, boolean>>({
    morningBrief: true,
    preSession: true,
    weeklyReview: true,
  });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [maxAutoSaved, setMaxAutoSaved] = useState<number | null>(null);
  const [twAutoSavedAt, setTwAutoSavedAt] = useState<number | null>(null);
  const [calAutoSavedAt, setCalAutoSavedAt] = useState<number | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  // Auto-save the daily-limit slider on release. Without this, dragging the
  // slider only updates local state — leaving the page loses the change and
  // the user sees the previously persisted value (which feels like a "reset").
  async function saveMaxNow(value: number) {
    try {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxMinutesDay: value }),
      });
      if (res.ok) {
        setMaxAutoSaved(value);
        // Quick visual confirmation; clear after a short window so the
        // indicator doesn't linger.
        setTimeout(() => {
          setMaxAutoSaved((cur) => (cur === value ? null : cur));
        }, 1800);
        r.refresh();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(j.error || "Couldn't save daily limit");
      }
    } catch {
      setErr("Couldn't save daily limit");
    }
  }

  // Auto-save the time-windows heatmap. The heatmap fires `onChange` once per
  // committed gesture (single-cell toggle or rect drag-release), so this
  // matches the slider's "save on release" cadence — no debounce needed.
  async function saveTwNow(value: TimeWindows) {
    try {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeWindows: value }),
      });
      if (res.ok) {
        const stamp = Date.now();
        setTwAutoSavedAt(stamp);
        setTimeout(() => {
          setTwAutoSavedAt((cur) => (cur === stamp ? null : cur));
        }, 1800);
        r.refresh();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(j.error || "Couldn't save time windows");
      }
    } catch {
      setErr("Couldn't save time windows");
    }
  }

  async function resetVerdantCalendar() {
    if (resetBusy) return;
    const confirmed = window.confirm(
      "Reset Verdant's calendar wiring?\n\n" +
        "This clears the Verdant→Google link and marks every session as not-yet-synced. " +
        "Next time you click \"Sync to Google\" Verdant will create a fresh calendar and push every session to it.\n\n" +
        "Old \"Verdant\" calendars in your Google sidebar will stay until you delete them manually."
    );
    if (!confirmed) return;
    setResetBusy(true);
    setResetMsg(null);
    try {
      const res = await fetch("/api/calendar/reset", { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        sessionsCleared?: number;
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setResetMsg(j.error || "Reset failed");
      } else {
        setResetMsg(
          `Reset done. Cleared ${j.sessionsCleared ?? 0} session link${
            (j.sessionsCleared ?? 0) === 1 ? "" : "s"
          }. Click "Sync to Google" on the schedule page to push to a fresh calendar.`
        );
        r.refresh();
      }
    } catch {
      setResetMsg("Reset failed");
    } finally {
      setResetBusy(false);
    }
  }

  async function saveCalNow(value: boolean) {
    try {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pushToCalendar: value }),
      });
      if (res.ok) {
        const stamp = Date.now();
        setCalAutoSavedAt(stamp);
        setTimeout(() => {
          setCalAutoSavedAt((cur) => (cur === stamp ? null : cur));
        }, 1800);
        r.refresh();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(j.error || "Couldn't save calendar setting");
      }
    } catch {
      setErr("Couldn't save calendar setting");
    }
  }

  // Nudges are decorative — persist locally so the toggle state survives reloads.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(NUDGE_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<Record<NudgeKey, boolean>>;
      setNudges((n) => ({ ...n, ...parsed }));
    } catch {
      /* ignore */
    }
  }, []);

  function setNudge(k: NudgeKey, v: boolean): void {
    const next = { ...nudges, [k]: v };
    setNudges(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(NUDGE_STORAGE_KEY, JSON.stringify(next));
    }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    setOk(false);
    const trimmed = weekly.trim();
    let weeklyMinutesTarget: number | null = null;
    if (trimmed.length > 0) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 30 || n > 3000) {
        setErr("Weekly target must be between 30 and 3000 minutes");
        setBusy(false);
        return;
      }
      weeklyMinutesTarget = Math.round(n);
    }
    const res = await fetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxMinutesDay: max,
        weeklyMinutesTarget,
        pushToCalendar: cal,
        timeWindows: tw,
      }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(j.error || "Save failed");
    } else {
      setOk(true);
      r.refresh();
    }
    setBusy(false);
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      {/* Calendars */}
      <div id="calendars" className="ink-card" style={{ padding: 20, scrollMarginTop: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <CalendarIcon size={28} />
          <div style={{ flex: 1 }}>
            <div className="tag">connections</div>
            <div
              style={{
                fontFamily: "var(--font-fraunces)",
                fontSize: 18,
                fontWeight: 600,
              }}
            >
              Calendars
            </div>
          </div>
          {calAutoSavedAt && (
            <span
              style={{
                fontFamily: "var(--font-fraunces)",
                fontStyle: "italic",
                fontSize: 13,
                color: "var(--moss)",
              }}
            >
              saved ✓
            </span>
          )}
        </div>
        <div
          className="ink-card soft"
          style={{ padding: 12, display: "flex", alignItems: "center", gap: 10 }}
        >
          <GoogleG size={20} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.userEmail || "Google account"}
            </div>
            <div className="tag">primary calendar</div>
          </div>
          <span className="chip moss">connected</span>
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 14,
            fontSize: 14,
          }}
        >
          <input
            type="checkbox"
            checked={cal}
            onChange={(e) => {
              const next = e.target.checked;
              setCal(next);
              void saveCalNow(next);
            }}
            style={{ width: 18, height: 18, accentColor: "var(--moss)" }}
          />
          <span>push new sessions to my Google Calendar</span>
        </label>
        <p
          style={{
            margin: "6px 0 0 28px",
            fontSize: 12,
            color: "var(--ink-faded)",
            fontFamily: "var(--font-fraunces)",
            fontStyle: "italic",
            lineHeight: 1.4,
          }}
        >
          turning this off pauses pushing — your Google account stays connected.
        </p>
        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: "1.25px dashed var(--ink-soft)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-fraunces)",
              fontSize: 13,
              color: "var(--ink-soft)",
              marginBottom: 8,
              lineHeight: 1.4,
            }}
          >
            Seeing duplicate &quot;Verdant&quot; calendars in Google? Reset clears
            Verdant&apos;s link and re-syncs everything to a single fresh
            calendar.
          </div>
          <button
            type="button"
            className="btn sm"
            onClick={resetVerdantCalendar}
            disabled={resetBusy}
          >
            {resetBusy ? "resetting…" : "Reset Verdant calendar"}
          </button>
          {resetMsg && (
            <div
              style={{
                marginTop: 8,
                fontFamily: "var(--font-fraunces)",
                fontSize: 13,
                color: resetMsg.startsWith("Reset done")
                  ? "var(--moss-deep)"
                  : "var(--berry)",
                lineHeight: 1.4,
              }}
            >
              {resetMsg}
            </div>
          )}
        </div>
      </div>

      {/* Daily limit */}
      <div className="ink-card" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <WateringCan size={36} />
          <div>
            <div className="tag">pacing</div>
            <div
              style={{
                fontFamily: "var(--font-fraunces)",
                fontSize: 18,
                fontWeight: 600,
              }}
            >
              Daily limit
            </div>
          </div>
        </div>
        <div
          style={{
            fontFamily: "var(--font-fraunces)",
            fontWeight: 500,
            fontSize: 28,
            color: "var(--moss-deep)",
            textAlign: "center",
            position: "relative",
          }}
        >
          {max} min/day
          {maxAutoSaved === max && (
            <span
              style={{
                position: "absolute",
                right: 0,
                top: "50%",
                transform: "translateY(-50%)",
                fontFamily: "var(--font-fraunces)",
                fontStyle: "italic",
                fontSize: 13,
                color: "var(--moss)",
              }}
            >
              saved ✓
            </span>
          )}
        </div>
        <input
          type="range"
          min={15}
          max={180}
          step={15}
          value={max}
          onChange={(e) => setMax(Number(e.target.value))}
          onPointerUp={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v)) void saveMaxNow(v);
          }}
          onKeyUp={(e) => {
            // Keyboard adjustments (arrow keys) commit on key release.
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v)) void saveMaxNow(v);
          }}
          style={{ width: "100%", accentColor: "var(--moss)" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="tag">15 min</span>
          <span className="tag">3 hr</span>
        </div>
        <div className="field" style={{ marginTop: 18 }}>
          <label htmlFor="weekly">Weekly target (min)</label>
          <input
            id="weekly"
            type="number"
            min={30}
            max={3000}
            step={15}
            placeholder="auto (infer from windows)"
            value={weekly}
            onChange={(e) => setWeekly(e.target.value)}
          />
          <span className="hint">
            optional — fern paces plans toward this many minutes per week.
          </span>
        </div>
      </div>

      {/* Time windows heatmap */}
      <div className="ink-card" style={{ padding: 20, gridColumn: "span 2" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 14,
          }}
        >
          <SunArt size={36} />
          <div style={{ flex: 1 }}>
            <div className="tag">when can fern plant?</div>
            <div
              style={{
                fontFamily: "var(--font-fraunces)",
                fontSize: 18,
                fontWeight: 600,
              }}
            >
              Time windows
            </div>
          </div>
          {twAutoSavedAt && (
            <span
              style={{
                fontFamily: "var(--font-fraunces)",
                fontStyle: "italic",
                fontSize: 13,
                color: "var(--moss)",
              }}
            >
              saved ✓
            </span>
          )}
        </div>
        <TimeWindowsHeatmap
          value={tw}
          onChange={(next) => {
            setTw(next);
            void saveTwNow(next);
          }}
        />
      </div>

      {/* Gentle nudges */}
      <div className="ink-card" style={{ padding: 20 }}>
        <div className="tag">notifications</div>
        <div
          style={{
            fontFamily: "var(--font-fraunces)",
            fontSize: 18,
            fontWeight: 600,
            marginBottom: 12,
          }}
        >
          Gentle nudges
        </div>
        {NUDGE_KEYS.map((k, i) => (
          <label
            key={k}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 0",
              borderBottom:
                i < NUDGE_KEYS.length - 1
                  ? "1.25px dashed var(--ink-soft)"
                  : "none",
              fontSize: 15,
            }}
          >
            <input
              type="checkbox"
              checked={nudges[k]}
              onChange={(e) => setNudge(k, e.target.checked)}
              style={{ width: 18, height: 18, accentColor: "var(--moss)" }}
            />
            <span>{NUDGE_LABELS[k]}</span>
          </label>
        ))}
      </div>

      {/* The compost */}
      <div className="ink-card" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <Mushroom size={28} />
          <div className="tag">danger zone</div>
        </div>
        <div
          style={{
            fontFamily: "var(--font-fraunces)",
            fontSize: 18,
            fontWeight: 600,
            marginBottom: 12,
          }}
        >
          The compost
        </div>
        <p
          style={{
            fontSize: 14,
            color: "var(--ink-soft)",
            margin: "0 0 12px",
            lineHeight: 1.45,
          }}
        >
          Archive sprouts you&apos;ve finished, or pull them up entirely. We keep a
          journal of completed ones in case you want to look back.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn sm" disabled title="coming soon">
            view archive
          </button>
          <button
            type="button"
            className="btn sm"
            style={{ background: "var(--blush)" }}
            disabled
            title="coming soon"
          >
            delete account
          </button>
        </div>
      </div>

      {/* Save bar */}
      <div
        style={{
          gridColumn: "span 2",
          display: "flex",
          gap: 12,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="btn primary"
          style={{ minWidth: 180, justifyContent: "center" }}
        >
          {busy ? "saving…" : "save settings"}
        </button>
        {ok && (
          <span
            className="hand"
            style={{ color: "var(--moss-deep)", fontSize: 14 }}
          >
            saved.
          </span>
        )}
        {err && (
          <span
            className="hand"
            style={{ color: "var(--berry)", fontSize: 14 }}
          >
            {err}
          </span>
        )}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarRefreshButton } from "@/components/verdant/CalendarRefreshButton";

interface Props {
  weekOffset: number;
  label: string;
  calendarConnected: boolean;
  /** All active plan IDs — sync iterates each. Empty list hides the button. */
  activePlanIds: string[];
}

export function ScheduleHeader({
  weekOffset,
  label,
  calendarConnected,
  activePlanIds,
}: Props) {
  const r = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function syncAllToGoogle() {
    if (activePlanIds.length === 0) return;
    setSyncing(true);
    setMsg(null);
    let totalSynced = 0;
    let allAlreadySynced = true;
    let anyErr = false;
    for (const planId of activePlanIds) {
      try {
        const res = await fetch(`/api/plans/${planId}/calendar`, {
          method: "POST",
        });
        const j = (await res.json().catch(() => ({}))) as {
          syncedCount?: number;
          allAlreadySynced?: boolean;
          errors?: string[];
        };
        if (!res.ok) anyErr = true;
        else {
          totalSynced += j.syncedCount ?? 0;
          if (!j.allAlreadySynced) allAlreadySynced = false;
        }
      } catch {
        anyErr = true;
      }
    }
    setMsg(
      anyErr
        ? "some sprouts failed to sync"
        : totalSynced === 0 && allAlreadySynced
        ? "all sessions already on Google Calendar"
        : `synced ${totalSynced} session${totalSynced === 1 ? "" : "s"}`
    );
    setSyncing(false);
    r.refresh();
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        alignItems: "end",
        gap: 24,
        marginBottom: 18,
      }}
    >
      <div>
        <div className="tag">week of</div>
        <h1
          className="serif-display"
          style={{
            fontSize: 44,
            margin: "4px 0 4px",
            fontWeight: 400,
            letterSpacing: "-0.02em",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Link
            href={`/schedule?w=${weekOffset - 1}`}
            aria-label="previous week"
            style={{
              background: "transparent",
              border: "none",
              fontSize: 32,
              padding: 4,
              color: "var(--ink-faded)",
              textDecoration: "none",
            }}
          >
            ‹
          </Link>
          {label}
          <Link
            href={`/schedule?w=${weekOffset + 1}`}
            aria-label="next week"
            style={{
              background: "transparent",
              border: "none",
              fontSize: 32,
              padding: 4,
              color: "var(--ink-faded)",
              textDecoration: "none",
            }}
          >
            ›
          </Link>
        </h1>
        <p
          style={{
            fontFamily: "var(--font-fraunces)",
            fontStyle: "italic",
            fontSize: 14,
            color: "var(--ink-soft)",
            margin: 0,
          }}
        >
          {calendarConnected
            ? "click a session to open it · existing events shown for context"
            : "connect Google Calendar in settings to see your existing events"}
        </p>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {weekOffset !== 0 && (
          <Link href="/schedule" className="btn sm">
            today
          </Link>
        )}
        <CalendarRefreshButton calendarConnected={calendarConnected} />
        {activePlanIds.length > 0 && (
          <button
            type="button"
            className="btn"
            onClick={syncAllToGoogle}
            disabled={syncing}
          >
            {syncing ? "syncing…" : "↻ sync to Google"}
          </button>
        )}
        {msg && (
          <span
            style={{
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 13,
              color: "var(--ink-faded)",
            }}
          >
            {msg}
          </span>
        )}
      </div>
    </div>
  );
}

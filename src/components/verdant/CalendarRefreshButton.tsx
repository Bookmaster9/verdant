"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function CalendarRefreshButton({
  calendarConnected,
}: {
  calendarConnected: boolean;
}) {
  const r = useRouter();
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!calendarConnected) return null;

  async function refreshFromGoogle() {
    setPending(true);
    setMsg(null);
    try {
      const res = await fetch("/api/calendar/refresh", { method: "POST" });
      if (!res.ok) {
        setMsg("couldn't refresh");
        setPending(false);
        return;
      }
      setMsg("calendar updated");
      r.refresh();
    } catch {
      setMsg("couldn't refresh");
    } finally {
      setPending(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="btn sm"
        onClick={refreshFromGoogle}
        disabled={pending}
      >
        {pending ? "refreshing…" : "↻ refresh calendar"}
      </button>
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
    </span>
  );
}

"use client";

import { useEffect } from "react";

/**
 * Captures the user's browser-resolved IANA timezone on first mount and
 * POSTs it to /api/preferences if it differs from the server-stored value.
 *
 * Why this exists: server-side code (the packer, drift sync, GCal sync) runs
 * on Vercel = UTC. Without an explicit user tz, we'd silently shift event
 * times. The browser is the only authoritative source for the user's tz, so
 * we capture it client-side and persist on every page load (cheap, idempotent).
 */
export function TimezoneCapture({ persistedTz }: { persistedTz: string | null }) {
  useEffect(() => {
    let tz: string | null = null;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      tz = null;
    }
    if (!tz) return;
    if (persistedTz === tz) return;
    void fetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userTimeZone: tz }),
    }).catch(() => {
      /* best-effort */
    });
  }, [persistedTz]);
  return null;
}

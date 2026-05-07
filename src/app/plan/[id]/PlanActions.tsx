"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarIcon, ForestSprite } from "@/components/verdant/art";

export function PlanActions({
  planId,
  hasPrevPlan,
}: {
  planId: string;
  hasPrevPlan?: boolean;
}) {
  const r = useRouter();
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function nl() {
    setBusy(true);
    setErr(null);
    setMessage(null);
    const res = await fetch(`/api/plans/${planId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ naturalLanguage: text }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      error?: string;
      plan?: unknown;
      message?: string;
    };
    if (!res.ok) {
      setErr(j.error || "Could not apply edit");
    } else {
      setMessage(j.message || "Updated.");
      setText("");
      r.refresh();
    }
    setBusy(false);
  }

  async function addToCalendar() {
    setBusy(true);
    setErr(null);
    setMessage(null);
    const res = await fetch(`/api/plans/${planId}/calendar`, { method: "POST" });
    const j = (await res.json().catch(() => ({}))) as {
      syncedCount?: number;
      pendingCount?: number;
      errors?: string[];
      error?: string;
    };
    if (!res.ok) {
      setErr(j.error || "Calendar sync failed");
    } else {
      const n = j.syncedCount ?? 0;
      const pend = j.pendingCount ?? 0;
      if (n === 0 && (j.errors?.length ?? 0) > 0) {
        setErr(j.errors!.slice(0, 5).join(" "));
      } else {
        const bits = [`Added ${n} session(s) to Google Calendar.`];
        if (pend > 0) bits.push(`${pend} still pending.`);
        setMessage(bits.join(" "));
        if (j.errors?.length) setErr(j.errors.slice(0, 3).join(" · "));
      }
      r.refresh();
    }
    setBusy(false);
  }

  async function resched() {
    setBusy(true);
    setErr(null);
    setMessage(null);
    const res = await fetch(`/api/plans/${planId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rescheduleFrom: new Date().toISOString() }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(j.error || "Reschedule failed");
    } else {
      setMessage("Rebalanced from today to your deadline.");
      r.refresh();
    }
    setBusy(false);
  }

  async function rebuildSchedule() {
    setBusy(true);
    setErr(null);
    setMessage(null);
    const res = await fetch(`/api/plans/${planId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rebuildSchedule: true }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      error?: string;
      summary?: string;
    };
    if (!res.ok) {
      setErr(j.error || "Rebuild failed");
    } else {
      setMessage(j.summary || "Rebuilt schedule from your plan.");
      r.refresh();
    }
    setBusy(false);
  }

  async function regenerate(revert = false) {
    if (
      !revert &&
      !confirm(
        "Regenerate this plan with the current AI? Your current plan is saved as a one-click revert."
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    setMessage(null);
    const res = await fetch(`/api/plans/${planId}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(revert ? { revert: true } : {}),
    });
    const j = (await res.json().catch(() => ({}))) as {
      error?: string;
      overflow?: { id: string; title: string }[];
      reverted?: boolean;
    };
    if (!res.ok) {
      setErr(j.error || "Regenerate failed");
    } else {
      const over = j.overflow ?? [];
      const verb = j.reverted ? "Reverted to previous plan" : "Regenerated plan";
      setMessage(
        over.length > 0
          ? `${verb}. ${over.length} task(s) didn't fit before the deadline.`
          : `${verb}.`
      );
      r.refresh();
    }
    setBusy(false);
  }

  return (
    <div
      className="ink-card"
      style={{
        padding: 18,
        background: "var(--leaf-pale)",
        position: "relative",
        marginTop: 12,
      }}
    >
      <div style={{ position: "absolute", left: -10, top: -16 }}>
        <ForestSprite size={56} />
      </div>
      <div style={{ paddingLeft: 50 }}>
        <div className="tag" style={{ marginBottom: 4 }}>
          ask fern
        </div>
        <div
          style={{
            fontFamily: "var(--font-fraunces)",
            fontSize: 15,
            lineHeight: 1.45,
            color: "var(--ink)",
            marginBottom: 12,
          }}
        >
          tell me a change in plain words — &quot;make this week lighter&quot;, &quot;move
          tomorrow to Thursday night&quot;, &quot;push to next week&quot;.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="describe a change to your plan…"
            style={{
              flex: 1,
              minWidth: 240,
              background: "var(--paper)",
              border: "1.5px solid var(--ink)",
              borderRadius: 10,
              padding: "10px 14px",
              fontFamily: "var(--font-fraunces)",
              fontSize: 14,
              outline: "none",
            }}
          />
          <button
            type="button"
            disabled={busy || !text.trim()}
            onClick={nl}
            className="btn primary sm"
          >
            apply
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={addToCalendar}
            disabled={busy}
            className="btn sm"
            style={{ background: "var(--paper-warm)" }}
          >
            <CalendarIcon size={14} /> sync to Google
          </button>
          <button
            type="button"
            onClick={resched}
            disabled={busy}
            className="btn sm ghost"
          >
            rebalance from today
          </button>
          <button
            type="button"
            onClick={rebuildSchedule}
            disabled={busy}
            className="btn sm ghost"
            title="Re-pack future tasks against your current learned preferences. Locked sessions stay put."
          >
            re-optimize
          </button>
          <button
            type="button"
            onClick={() => regenerate(false)}
            disabled={busy}
            className="btn sm ghost"
          >
            regenerate plan
          </button>
          {hasPrevPlan && (
            <button
              type="button"
              onClick={() => regenerate(true)}
              disabled={busy}
              className="btn sm ghost"
            >
              revert
            </button>
          )}
        </div>
        {message && (
          <p
            style={{
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 13,
              color: "var(--moss-deep)",
              marginTop: 10,
            }}
          >
            {message}
          </p>
        )}
        {err && (
          <p
            style={{
              fontFamily: "var(--font-fraunces)",
              fontSize: 13,
              color: "var(--berry)",
              marginTop: 10,
            }}
          >
            {err}
          </p>
        )}
      </div>
    </div>
  );
}

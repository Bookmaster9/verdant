"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PlacementRule } from "@/types/plan";
import { describeRule } from "@/lib/placement-rules";

export type PlanRulesGroup = {
  planId: string;
  planTitle: string;
  rules: PlacementRule[];
};

type Props = {
  groups: PlanRulesGroup[];
};

export function PersistentRulesSection({ groups: initialGroups }: Props) {
  const r = useRouter();
  const [groups, setGroups] = useState<PlanRulesGroup[]>(initialGroups);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function deleteRule(planId: string, index: number) {
    const group = groups.find((g) => g.planId === planId);
    if (!group) return;
    const key = `${planId}:${index}`;
    setPendingKey(key);
    setErr(null);
    const nextRules = group.rules.filter((_, i) => i !== index);
    try {
      const res = await fetch(`/api/plans/${planId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placementRules: nextRules }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setGroups((cur) =>
        cur
          .map((g) =>
            g.planId === planId ? { ...g, rules: nextRules } : g
          )
          .filter((g) => g.rules.length > 0)
      );
      r.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to remove rule.");
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="ink-card" style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div>
          <div className="tag">scheduler</div>
          <div
            style={{
              fontFamily: "var(--font-fraunces)",
              fontSize: 18,
              fontWeight: 600,
            }}
          >
            Saved rules
          </div>
          <div
            style={{
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 13,
              color: "var(--ink-faded)",
              marginTop: 2,
            }}
          >
            preferences and blackouts you saved when editing in plain language. these apply on every reschedule.
          </div>
        </div>
      </div>

      {groups.length === 0 ? (
        <div
          style={{
            fontFamily: "var(--font-fraunces)",
            fontStyle: "italic",
            fontSize: 14,
            color: "var(--ink-faded)",
            padding: "10px 4px",
          }}
        >
          no saved rules yet. when you ask fern to reschedule something, you can opt to save the rule so it sticks.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {groups.map((g) => (
            <div key={g.planId}>
              <div
                style={{
                  fontFamily: "var(--font-fraunces)",
                  fontSize: 15,
                  fontWeight: 600,
                  marginBottom: 6,
                }}
              >
                {g.planTitle}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {g.rules.map((rule, idx) => {
                  const key = `${g.planId}:${idx}`;
                  const pending = pendingKey === key;
                  return (
                    <div
                      key={key}
                      className="ink-card soft"
                      style={{
                        padding: "10px 12px",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <span
                        className="chip"
                        style={{
                          fontSize: 11,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        {rule.kind}
                      </span>
                      <span style={{ flex: 1, fontSize: 14 }}>
                        {describeRule(rule)}
                      </span>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => deleteRule(g.planId, idx)}
                        style={{
                          background: "transparent",
                          border: "1px solid var(--ink-faded)",
                          borderRadius: 999,
                          padding: "4px 12px",
                          fontSize: 12,
                          fontFamily: "var(--font-jetbrains)",
                          letterSpacing: "0.06em",
                          textTransform: "uppercase",
                          color: pending ? "var(--ink-faded)" : "var(--ink)",
                          cursor: pending ? "wait" : "pointer",
                        }}
                      >
                        {pending ? "removing…" : "remove"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {err && (
        <div
          style={{
            marginTop: 12,
            fontSize: 13,
            color: "var(--rose, #b54a4a)",
          }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

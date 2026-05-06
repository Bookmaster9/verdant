"use client";

import { useMemo, useState } from "react";
import type { SproutPlan } from "@/types/plan";
import { Sparkle, Sprout } from "./art";

type TabKey = "summary" | "phases" | "shape" | "rationale";

export function AiPlanDisclosure({ sprout }: { sprout: SproutPlan }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>("summary");

  const availableTabs = useMemo<{ key: TabKey; label: string }[]>(() => {
    const t: { key: TabKey; label: string }[] = [];
    if (sprout.summary) t.push({ key: "summary", label: "summary" });
    if ((sprout.phases?.length ?? 0) > 0) t.push({ key: "phases", label: "phases" });
    if (sprout.weeklyShape) t.push({ key: "shape", label: "weekly shape" });
    if ((sprout.rationale?.length ?? 0) > 0)
      t.push({ key: "rationale", label: "rationale" });
    return t;
  }, [sprout]);

  if (availableTabs.length === 0) return null;

  // Make sure the selected tab is one that exists
  const activeTab = availableTabs.find((t) => t.key === tab) ?? availableTabs[0];

  return (
    <div style={{ marginBottom: 22 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="ink-card soft"
        style={{
          width: "100%",
          padding: "10px 14px",
          background: open ? "var(--leaf-pale)" : "var(--paper-warm)",
          border: "1.25px solid var(--ink)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "inherit",
          color: "inherit",
        }}
      >
        <Sparkle size={16} />
        <span
          style={{
            fontFamily: "var(--font-fraunces)",
            fontSize: 15,
            fontWeight: 500,
          }}
        >
          AI plan response
        </span>
        <span
          className="tag"
          style={{
            background: "var(--paper)",
            border: "1.25px solid var(--ink-soft)",
            padding: "2px 8px",
            borderRadius: 999,
          }}
        >
          {sprout.sessionsPlanned ?? sprout.tasks?.length ?? 0} sessions
        </span>
        <span style={{ flex: 1 }} />
        <span
          aria-hidden
          style={{
            fontFamily: "var(--font-jetbrains)",
            fontSize: 14,
            color: "var(--ink-faded)",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform .15s",
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          className="ink-card"
          style={{
            marginTop: 8,
            padding: 16,
            background: "var(--paper-warm)",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div
            role="tablist"
            aria-label="AI plan response sections"
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              borderBottom: "1.25px dashed var(--ink-soft)",
              paddingBottom: 10,
            }}
          >
            {availableTabs.map((t) => {
              const active = t.key === activeTab.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.key)}
                  className="chip"
                  style={{
                    cursor: "pointer",
                    background: active ? "var(--moss)" : "var(--paper-warm)",
                    color: active ? "#f8f1de" : "var(--ink)",
                    borderColor: "var(--ink)",
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          <div role="tabpanel">
            {activeTab.key === "summary" && (
              <div>
                <div className="tag" style={{ marginBottom: 4 }}>
                  what fern proposed
                </div>
                <p
                  style={{
                    margin: 0,
                    fontFamily: "var(--font-fraunces)",
                    fontSize: 15,
                    lineHeight: 1.55,
                    color: "var(--ink)",
                  }}
                >
                  {sprout.summary}
                </p>
              </div>
            )}

            {activeTab.key === "phases" && (
              <ol
                style={{
                  margin: 0,
                  paddingLeft: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {sprout.phases.map((p, i) => (
                  <li
                    key={i}
                    className="ink-card soft"
                    style={{
                      padding: "10px 14px",
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                      background: "var(--paper)",
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        background: "var(--moss)",
                        color: "#f8f1de",
                        border: "1.5px solid var(--ink)",
                        display: "grid",
                        placeItems: "center",
                        fontFamily: "var(--font-fraunces)",
                        fontWeight: 600,
                        fontSize: 13,
                        flexShrink: 0,
                      }}
                    >
                      {i + 1}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontFamily: "var(--font-fraunces)",
                          fontWeight: 500,
                          fontSize: 15,
                        }}
                      >
                        {p.name}
                      </div>
                      <div
                        style={{
                          fontFamily: "var(--font-fraunces)",
                          fontStyle: "italic",
                          fontSize: 13,
                          color: "var(--ink-soft)",
                          lineHeight: 1.4,
                        }}
                      >
                        {p.focus}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}

            {activeTab.key === "shape" && sprout.weeklyShape && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 10,
                }}
              >
                {[
                  { label: "lessons / week", value: sprout.weeklyShape.lessons },
                  { label: "reviews / week", value: sprout.weeklyShape.reviews },
                  {
                    label: "milestone every",
                    value: sprout.weeklyShape.milestoneEvery,
                  },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="ink-card soft"
                    style={{
                      padding: 14,
                      background: "var(--paper)",
                      textAlign: "center",
                    }}
                  >
                    <div className="tag" style={{ marginBottom: 6 }}>
                      {s.label}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-fraunces)",
                        fontWeight: 500,
                        fontSize: 24,
                        color: "var(--moss-deep)",
                      }}
                    >
                      {s.value}
                    </div>
                  </div>
                ))}
                {sprout.sessionsPlanned != null && (
                  <div
                    className="ink-card soft"
                    style={{
                      padding: 14,
                      background: "var(--leaf-pale)",
                      gridColumn: "span 3",
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                    }}
                  >
                    <Sprout size={28} growth={0.6} />
                    <div
                      style={{
                        fontFamily: "var(--font-fraunces)",
                        fontSize: 14,
                      }}
                    >
                      Total sessions planned:{" "}
                      <strong>{sprout.sessionsPlanned}</strong>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab.key === "rationale" && (
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {(sprout.rationale ?? []).map((line, i) => (
                  <li
                    key={i}
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      fontFamily: "var(--font-fraunces)",
                      fontSize: 14,
                      lineHeight: 1.5,
                      color: "var(--ink)",
                      padding: "8px 12px",
                      background: "var(--paper)",
                      border: "1.25px dashed var(--ink-soft)",
                      borderRadius: 8,
                    }}
                  >
                    <span
                      style={{
                        marginTop: 6,
                        width: 8,
                        height: 8,
                        background: "var(--moss-deep)",
                        borderRadius: "50%",
                        flexShrink: 0,
                      }}
                    />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FernNote } from "@/types/plan";
import { ForestSprite } from "@/components/verdant/art";
import { SectionTitle } from "@/components/verdant/SectionTitle";

const BG_CYCLE = ["var(--leaf-pale)", "var(--sun-soft)", "var(--sky-soft)"];

export function FernNotesSection({
  planId,
  initialNotes,
  initialGeneratedAt,
}: {
  planId: string;
  initialNotes: FernNote[];
  initialGeneratedAt: string | null;
}) {
  const r = useRouter();
  const [notes, setNotes] = useState<FernNote[]>(initialNotes);
  const [generatedAt, setGeneratedAt] = useState<string | null>(
    initialGeneratedAt
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // guard so React StrictMode double-invoke in dev doesn't hit the API twice
  const autoFiredRef = useRef(false);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/plans/${planId}/fern-notes`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `request failed (${res.status})`);
      }
      const j = (await res.json()) as {
        notes: FernNote[];
        generatedAt: string;
      };
      setNotes(j.notes);
      setGeneratedAt(j.generatedAt);
      // refresh server components so dependent pieces revalidate
      r.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not draft notes");
    } finally {
      setBusy(false);
    }
  }

  // Auto-generate on first view if there are no persisted notes yet.
  useEffect(() => {
    if (autoFiredRef.current) return;
    if (notes.length > 0) return;
    autoFiredRef.current = true;
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generatedAtLabel = generatedAt
    ? new Date(generatedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  // Empty state while we auto-generate the first batch.
  if (notes.length === 0) {
    return (
      <div style={{ marginBottom: 28 }}>
        <SectionTitle kicker="from fern">Notes from your gardener</SectionTitle>
        <div
          className="ink-card"
          style={{
            padding: 18,
            background: "var(--leaf-pale)",
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <ForestSprite size={48} expression={busy ? "chat" : "smile"} />
          <div style={{ flex: 1 }}>
            <div className="tag" style={{ marginBottom: 4 }}>
              {busy ? "fern is jotting…" : "fern has nothing yet"}
            </div>
            <div
              style={{
                fontFamily: "var(--font-fraunces)",
                fontStyle: "italic",
                fontSize: 14,
                color: "var(--ink)",
                lineHeight: 1.4,
              }}
            >
              {busy
                ? "looking through your sessions and ratings — back in a moment."
                : error || "drafting the first set of notes for this sprout."}
            </div>
          </div>
          {!busy && (
            <button
              type="button"
              className="btn sm primary"
              onClick={() => void generate()}
              disabled={busy}
            >
              ask fern
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 12,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <SectionTitle kicker="from fern">Notes from your gardener</SectionTitle>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: "var(--font-jetbrains)",
            fontSize: 11,
            color: "var(--ink-faded)",
          }}
        >
          {generatedAtLabel && <span>drafted {generatedAtLabel}</span>}
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => void generate()}
            disabled={busy}
            style={{ fontSize: 12 }}
          >
            {busy ? "drafting…" : "↻ refresh"}
          </button>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${notes.length}, 1fr)`,
          gap: 14,
        }}
      >
        {notes.map((n, i) => (
          <div
            key={i}
            className="ink-card"
            style={{
              padding: 16,
              position: "relative",
              background: BG_CYCLE[i % BG_CYCLE.length],
            }}
          >
            <div style={{ position: "absolute", left: -8, top: -16 }}>
              <ForestSprite size={48} />
            </div>
            <div style={{ paddingLeft: 44 }}>
              <div className="tag" style={{ marginBottom: 4 }}>
                {n.kicker}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-fraunces)",
                  fontSize: 14,
                  lineHeight: 1.4,
                  color: "var(--ink)",
                }}
              >
                {n.body}
              </div>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p
          className="hand"
          style={{
            color: "var(--berry)",
            fontSize: 13,
            margin: "10px 0 0",
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

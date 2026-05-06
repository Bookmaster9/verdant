"use client";

import { useEffect, useRef, useState } from "react";
import { ForestSprite, LeafSprig } from "@/components/verdant/art";
import { DEEPEN_PRESETS } from "@/prompts/fern-tutor";

/**
 * Column 3 of the session detail page. Two tabs, both mounted at once so
 * their internal state survives switching:
 *
 *   - "go deeper": preset prompts + stacked Fern responses. Server persists
 *     the last 3 cards per (planId, taskId) so users can come back to a
 *     generated lesson plan. Dismissing a card hits the server too.
 *   - "chat": multi-turn chat with Fern. Persists the last 3 turns server-side
 *     in TaskJournal.chatJson. Hydrates from initialTurns on first render;
 *     re-fetches via /api/plans/[id]/chat/[taskId] on send.
 *
 * Both panels share /api/plans/[id]/deepen/[taskId] and /chat/[taskId] for
 * their network calls. Each tab has a "clear" affordance that hits DELETE
 * on its endpoint.
 */

export type ChatTurn = { role: "user" | "fern"; content: string };

/** Shape of a card persisted in TaskJournal.deepenJson. */
export type PersistedDeepenCard = {
  id: string;
  presetId: string;
  content: string;
  /** ISO string. Optional — not used for ordering yet, but persisted for future sort. */
  createdAt?: string;
};

/** Local view of a card while it's mid-flight or rendered. */
type DeepenCard = {
  id: string;
  presetId: string;
  status: "pending" | "done" | "error";
  content: string;
  error?: string;
};

function presetLabel(presetId: string): string {
  return DEEPEN_PRESETS.find((p) => p.id === presetId)?.label ?? "fern's note";
}

const QUICK_REPLIES = [
  "i don't get step 2",
  "give me a 5-min ramp-in",
  "what should I focus on?",
  "i feel stuck — where to look?",
];

export function FernGuidanceColumn({
  planId,
  taskId,
  taskTitle,
  initialTurns,
  initialDeepenCards,
}: {
  planId: string;
  taskId: string;
  taskTitle: string;
  initialTurns: ChatTurn[];
  initialDeepenCards: PersistedDeepenCard[];
}) {
  const [tab, setTab] = useState<"deepen" | "chat">("deepen");

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--paper-warm)",
        border: "1.5px solid var(--ink)",
        borderRadius: 14,
        boxShadow: "3px 3px 0 var(--ink)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          padding: "12px 14px 0",
          borderBottom: "1.5px solid var(--ink)",
          background: "var(--paper-warm)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span className="float-y" style={{ display: "inline-flex" }}>
            <ForestSprite size={36} />
          </span>
          <div>
            <div className="hand" style={{ fontSize: 22, lineHeight: 1, color: "var(--moss-deep)" }}>
              fern
            </div>
            <div
              style={{
                fontFamily: "var(--font-fraunces)",
                fontStyle: "italic",
                fontSize: 12,
                color: "var(--ink-soft)",
                marginTop: 2,
              }}
            >
              your tutor for this lesson
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <TabBtn label="go deeper" active={tab === "deepen"} onClick={() => setTab("deepen")} />
          <TabBtn label="chat" active={tab === "chat"} onClick={() => setTab("chat")} />
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: tab === "deepen" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <DeepenInline
            planId={planId}
            taskId={taskId}
            initialCards={initialDeepenCards}
          />
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: tab === "chat" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <ChatInline
            planId={planId}
            taskId={taskId}
            taskTitle={taskTitle}
            initialTurns={initialTurns}
          />
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? "var(--paper)" : "transparent",
        border: "1.5px solid var(--ink)",
        borderBottom: active ? "1.5px solid var(--paper)" : "1.5px solid var(--ink)",
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        padding: "6px 14px",
        fontFamily: "var(--font-fraunces)",
        fontSize: 13,
        color: "var(--ink)",
        cursor: "pointer",
        marginBottom: -1.5,
        position: "relative",
        zIndex: active ? 2 : 1,
      }}
    >
      {label}
    </button>
  );
}

// ============================================================
// "Go deeper" — session-only stacked response cards
// ============================================================

function DeepenInline({
  planId,
  taskId,
  initialCards,
}: {
  planId: string;
  taskId: string;
  initialCards: PersistedDeepenCard[];
}) {
  const [cards, setCards] = useState<DeepenCard[]>(() =>
    initialCards.map((c) => ({
      id: c.id,
      presetId: c.presetId,
      status: "done",
      content: c.content,
    }))
  );

  async function ask(preset: (typeof DEEPEN_PRESETS)[number]) {
    // Optimistic placeholder while we wait for the server. The real card id
    // comes back in the POST response so we replace the temp id on success.
    const tempId = `pending-${preset.id}-${Date.now()}`;
    setCards((cs) => [
      ...cs,
      { id: tempId, presetId: preset.id, status: "pending", content: "" },
    ]);
    try {
      const res = await fetch(`/api/plans/${planId}/deepen/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId: preset.id }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setCards((cs) =>
          cs.map((c) =>
            c.id === tempId
              ? { ...c, status: "error", error: j.error || "fern is unreachable" }
              : c
          )
        );
        return;
      }
      const j = (await res.json()) as {
        card: PersistedDeepenCard;
        cards: PersistedDeepenCard[];
      };
      // Server returned the trimmed list — drop our temp placeholder and
      // replace local state with the canonical persisted view. This keeps
      // the sliding-3-card window in sync visually.
      setCards(
        j.cards.map((c) => ({
          id: c.id,
          presetId: c.presetId,
          status: "done",
          content: c.content,
        }))
      );
    } catch (err) {
      setCards((cs) =>
        cs.map((c) =>
          c.id === tempId
            ? {
                ...c,
                status: "error",
                error: err instanceof Error ? err.message : "fern is unreachable",
              }
            : c
        )
      );
    }
  }

  async function dismiss(cardId: string) {
    // Optimistic remove; on failure we leave it removed locally — the server
    // is just a backup for next visit, dismissing client-only is acceptable.
    const prev = cards;
    setCards((cs) => cs.filter((c) => c.id !== cardId));
    // Pending cards aren't persisted yet, so nothing to delete server-side.
    if (cardId.startsWith("pending-")) return;
    try {
      await fetch(
        `/api/plans/${planId}/deepen/${taskId}?cardId=${encodeURIComponent(cardId)}`,
        { method: "DELETE" }
      );
    } catch {
      // Restore on network error so the UI doesn't lie.
      setCards(prev);
    }
  }

  async function clearAll() {
    if (cards.length === 0) return;
    if (!confirm("clear all of fern's expand cards for this lesson?")) return;
    const prev = cards;
    setCards([]);
    try {
      const res = await fetch(`/api/plans/${planId}/deepen/${taskId}`, {
        method: "DELETE",
      });
      if (!res.ok) setCards(prev);
    } catch {
      setCards(prev);
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: "12px 14px 10px",
          borderBottom: "1px dashed var(--ink-soft)",
          background: "var(--paper-warm)",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-fraunces)",
            fontStyle: "italic",
            fontSize: 12,
            color: "var(--ink-soft)",
            marginBottom: 8,
          }}
        >
          ask fern to expand the lesson:
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {DEEPEN_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => void ask(p)}
              style={{
                background: "var(--paper)",
                border: "1.5px solid var(--ink)",
                borderRadius: 999,
                padding: "4px 10px",
                cursor: "pointer",
                fontFamily: "var(--font-fraunces)",
                fontSize: 11,
                color: "var(--ink)",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                boxShadow: "1px 1px 0 var(--ink)",
              }}
            >
              <span aria-hidden="true">{p.icon}</span> {p.label}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          background: "var(--paper)",
        }}
      >
        {cards.length === 0 && (
          <div
            style={{
              margin: "auto",
              textAlign: "center",
              maxWidth: 240,
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 13,
              color: "var(--ink-faded)",
              lineHeight: 1.5,
            }}
          >
            tap a prompt above and fern will write you a note.
            <br />
            <span style={{ fontSize: 11, opacity: 0.8 }}>
              (fern keeps the last 3 — older ones drop off when you ask again)
            </span>
          </div>
        )}
        {cards.map((c) => (
          <DeepenCardView
            key={c.id}
            card={c}
            onRemove={() => void dismiss(c.id)}
          />
        ))}
        {cards.length > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: 4,
            }}
          >
            <button
              type="button"
              onClick={() => void clearAll()}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-jetbrains)",
                fontSize: 10,
                color: "var(--ink-faded)",
                textDecoration: "underline",
              }}
              title="clear all expand cards for this lesson"
            >
              clear all
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DeepenCardView({
  card,
  onRemove,
}: {
  card: DeepenCard;
  onRemove: () => void;
}) {
  return (
    <div
      className="ink-card soft"
      style={{
        padding: 14,
        background: "var(--paper)",
        borderLeft: "4px solid var(--moss)",
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <ForestSprite size={24} />
          <div style={{ minWidth: 0 }}>
            <div className="tag" style={{ marginBottom: 0 }}>
              fern wrote
            </div>
            <div
              style={{
                fontFamily: "var(--font-fraunces)",
                fontStyle: "italic",
                fontSize: 12,
                color: "var(--ink-soft)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              re: {presetLabel(card.presetId)}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label="remove this note"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--ink-faded)",
            fontFamily: "var(--font-jetbrains)",
            fontSize: 14,
            padding: 4,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ×
        </button>
      </div>
      {card.status === "pending" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "var(--ink-faded)",
            fontFamily: "var(--font-fraunces)",
            fontStyle: "italic",
            fontSize: 13,
          }}
        >
          <span className="float-y" style={{ display: "inline-flex" }}>
            <LeafSprig size={18} />
          </span>
          fern is thinking…
        </div>
      )}
      {card.status === "error" && (
        <div
          style={{
            fontFamily: "var(--font-fraunces)",
            fontStyle: "italic",
            color: "var(--berry)",
            fontSize: 13,
          }}
        >
          fern couldn&apos;t reach her notebook · {card.error}
        </div>
      )}
      {card.status === "done" && (
        <div
          style={{
            fontFamily: "var(--font-fraunces)",
            fontSize: 14,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            color: "var(--ink)",
          }}
        >
          {card.content}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Chat — persisted last 3 turns
// ============================================================

function ChatInline({
  planId,
  taskId,
  taskTitle,
  initialTurns,
}: {
  planId: string;
  taskId: string;
  taskTitle: string;
  initialTurns: ChatTurn[];
}) {
  const [turns, setTurns] = useState<ChatTurn[]>(initialTurns);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, pending]);

  async function send() {
    const text = draft.trim();
    if (!text || pending) return;
    setDraft("");
    setError(null);
    // Optimistic append of the user turn while we wait for fern.
    setTurns((ts) => [...ts, { role: "user", content: text }]);
    setPending(true);
    try {
      const res = await fetch(`/api/plans/${planId}/chat/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error || "fern got distracted");
        // Roll back optimistic user turn so retry doesn't double-send.
        setTurns((ts) => ts.slice(0, -1));
        setDraft(text);
        return;
      }
      const j = (await res.json()) as { turns: ChatTurn[] };
      setTurns(j.turns);
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
      setTurns((ts) => ts.slice(0, -1));
      setDraft(text);
    } finally {
      setPending(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  async function clearChat() {
    if (!confirm("clear the chat history with fern for this lesson?")) return;
    try {
      const res = await fetch(`/api/plans/${planId}/chat/${taskId}`, {
        method: "DELETE",
      });
      if (res.ok) setTurns([]);
    } catch {
      // ignore — non-critical
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          background: "var(--paper)",
        }}
      >
        {turns.length === 0 && !pending && (
          <div
            style={{
              margin: "auto",
              textAlign: "center",
              maxWidth: 260,
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 13,
              color: "var(--ink-faded)",
              lineHeight: 1.5,
            }}
          >
            i&apos;m here. ask me anything about &ldquo;{taskTitle}&rdquo; — i&apos;ll help you understand the why or work through a stuck spot.
          </div>
        )}
        {turns.map((m, i) => (
          <Bubble key={i} m={m} />
        ))}
        {pending && (
          <div
            style={{
              alignSelf: "flex-start",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 12,
              color: "var(--ink-faded)",
            }}
          >
            <span className="float-y" style={{ display: "inline-flex" }}>
              <LeafSprig size={16} />
            </span>
            fern is gathering her thoughts…
          </div>
        )}
        {error && (
          <div
            style={{
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 12,
              color: "var(--berry)",
              alignSelf: "flex-start",
            }}
          >
            {error}
          </div>
        )}
      </div>

      <div
        style={{
          borderTop: "1.5px solid var(--ink)",
          padding: 10,
          background: "var(--paper-warm)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="ask about this lesson…"
            rows={2}
            disabled={pending}
            style={{
              flex: 1,
              resize: "none",
              background: "var(--paper)",
              border: "1.5px solid var(--ink)",
              borderRadius: 10,
              padding: "6px 10px",
              fontFamily: "var(--font-fraunces)",
              fontSize: 13,
              lineHeight: 1.4,
              outline: "none",
              color: "var(--ink)",
            }}
          />
          <button
            type="button"
            onClick={() => void send()}
            className="btn primary sm"
            disabled={!draft.trim() || pending}
            style={{ opacity: draft.trim() && !pending ? 1 : 0.5 }}
          >
            send
          </button>
        </div>
        <div
          style={{
            display: "flex",
            gap: 5,
            marginTop: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {QUICK_REPLIES.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setDraft(q)}
              style={{
                background: "transparent",
                border: "1.25px dashed var(--ink-soft)",
                borderRadius: 999,
                padding: "2px 8px",
                cursor: "pointer",
                fontFamily: "var(--font-fraunces)",
                fontStyle: "italic",
                fontSize: 10,
                color: "var(--ink-soft)",
              }}
            >
              {q}
            </button>
          ))}
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => void clearChat()}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                marginLeft: "auto",
                fontFamily: "var(--font-jetbrains)",
                fontSize: 10,
                color: "var(--ink-faded)",
                textDecoration: "underline",
              }}
              title="clear chat history with fern for this task"
            >
              clear
            </button>
          )}
        </div>
        <div
          style={{
            marginTop: 4,
            fontFamily: "var(--font-jetbrains)",
            fontSize: 9,
            color: "var(--ink-faded)",
          }}
        >
          fern remembers the last 3 exchanges per lesson · longer thoughts go in the journal
        </div>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: ChatTurn }) {
  const isUser = m.role === "user";
  return (
    <div
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "86%",
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-jetbrains)",
          fontSize: 9,
          color: "var(--ink-faded)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          textAlign: isUser ? "right" : "left",
          paddingLeft: 4,
          paddingRight: 4,
        }}
      >
        {isUser ? "you" : "fern"}
      </div>
      <div
        style={{
          background: isUser ? "var(--moss)" : "var(--leaf-pale)",
          color: isUser ? "#f8f1de" : "var(--ink)",
          border: "1.5px solid var(--ink)",
          borderRadius: 14,
          borderTopRightRadius: isUser ? 4 : 14,
          borderTopLeftRadius: isUser ? 14 : 4,
          padding: "8px 12px",
          fontFamily: "var(--font-fraunces)",
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}
      >
        {m.content}
      </div>
    </div>
  );
}

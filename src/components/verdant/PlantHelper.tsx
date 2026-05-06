"use client";

import { useEffect, useState } from "react";
import { ForestSprite } from "./art";

type Msg = { from: "fern" | "user"; text: string };

export function PlantHelper({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState("");
  const [thread, setThread] = useState<Msg[]>([
    { from: "fern", text: "hi! i'm fern. tell me how it's going and i'll tend the garden." },
  ]);
  const [pos, setPos] = useState(0);

  useEffect(() => {
    let t = 0;
    const id = setInterval(() => {
      t += 0.05;
      setPos(Math.sin(t) * 8);
    }, 80);
    return () => clearInterval(id);
  }, []);

  function send(text: string) {
    if (!text.trim()) return;
    setThread((th) => [
      ...th,
      { from: "user", text },
      {
        from: "fern",
        text: "okay! i'll think about that and re-plot this week so nothing gets crowded.",
      },
    ]);
    setDraft("");
  }

  return (
    <div style={{ position: "fixed", right: 28, bottom: 28, zIndex: 50 }}>
      {open && (
        <div
          className="ink-card"
          style={{
            width: 360,
            padding: 16,
            background: "var(--paper-warm)",
            marginBottom: 12,
            position: "relative",
          }}
        >
          <div
            className="tape"
            style={{ left: "50%", marginLeft: -39, top: -10, transform: "rotate(-3deg)" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <ForestSprite size={44} />
            <div style={{ lineHeight: 1.1 }}>
              <div
                style={{
                  fontFamily: "var(--font-caveat)",
                  fontSize: 22,
                  fontWeight: 700,
                  color: "var(--moss-deep)",
                }}
              >
                Fern
              </div>
              <div className="tag">your garden helper</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                fontFamily: "var(--font-jetbrains)",
                fontSize: 14,
                color: "var(--ink-faded)",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>
          <div
            className="scroll-area"
            style={{
              background: "var(--paper)",
              borderRadius: 10,
              border: "1.25px solid var(--ink)",
              padding: 10,
              maxHeight: 280,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {thread.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.from === "user" ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  background: m.from === "user" ? "var(--sun-soft)" : "var(--leaf-pale)",
                  border: "1.25px solid var(--ink)",
                  borderRadius:
                    m.from === "user" ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                  padding: "8px 12px",
                  fontSize: 14,
                  lineHeight: 1.4,
                }}
              >
                {m.text}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send(draft);
              }}
              placeholder="ask fern to reschedule, add, or adjust…"
              style={{
                flex: 1,
                background: "var(--paper)",
                border: "1.5px solid var(--ink)",
                borderRadius: 10,
                padding: "8px 12px",
                fontFamily: "var(--font-fraunces)",
                fontSize: 14,
                outline: "none",
              }}
            />
            <button type="button" className="btn primary sm" onClick={() => send(draft)}>
              send
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {["push a session", "lighten this week", "i'm sick today"].map((q) => (
              <button
                key={q}
                type="button"
                className="chip"
                onClick={() => send(q)}
                style={{ cursor: "pointer" }}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          position: "relative",
          transform: `translateX(${pos}px)`,
          transition: "transform 80ms linear",
        }}
        aria-label="Open Fern"
      >
        {!open && hover && (
          <div
            className="ink-card soft"
            style={{
              position: "absolute",
              right: 110,
              top: 4,
              padding: "8px 12px",
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 14,
              color: "var(--ink)",
              whiteSpace: "nowrap",
            }}
          >
            need a hand?
          </div>
        )}
        <div
          style={{
            width: 96,
            height: 96,
            borderRadius: "50%",
            background: "var(--paper-warm)",
            border: "1.5px solid var(--ink)",
            boxShadow: "3px 4px 0 var(--ink)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <div className="float-y">
            <ForestSprite size={76} expression={open ? "chat" : "smile"} />
          </div>
        </div>
      </button>
    </div>
  );
}

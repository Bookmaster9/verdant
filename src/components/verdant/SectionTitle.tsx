import type { ReactNode } from "react";

export function SectionTitle({
  kicker,
  children,
  align = "left",
}: {
  kicker?: string;
  children: ReactNode;
  align?: "left" | "center" | "right";
}) {
  return (
    <div style={{ textAlign: align, marginBottom: 12 }}>
      {kicker && (
        <div
          style={{
            fontFamily: "var(--font-jetbrains)",
            fontSize: 11,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "var(--ink-faded)",
            marginBottom: 4,
          }}
        >
          {kicker}
        </div>
      )}
      <h2
        className="serif-display"
        style={{
          margin: 0,
          fontSize: 32,
          fontWeight: 500,
          color: "var(--ink)",
          fontVariationSettings: '"opsz" 144',
        }}
      >
        {children}
      </h2>
    </div>
  );
}

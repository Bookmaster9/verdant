import Link from "next/link";
import { Sprout } from "./art";

export function SproutCard({
  href,
  title,
  summary,
  growth,
  daysToBloom,
  tags,
  streak,
  mood = "happy",
}: {
  href: string;
  title: string;
  summary?: string;
  growth: number;
  daysToBloom: number;
  tags?: string[];
  streak?: number;
  mood?: "happy" | "tired" | "sleepy";
}) {
  return (
    <Link
      href={href}
      className="ink-card"
      style={{
        padding: 0,
        textAlign: "left",
        cursor: "pointer",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--paper-warm)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div
        style={{
          background:
            "linear-gradient(180deg, var(--sky-soft) 0%, var(--paper-warm) 60%)",
          padding: "20px 18px 0",
          position: "relative",
          height: 200,
        }}
      >
        <div style={{ position: "absolute", top: 12, right: 14, display: "flex", gap: 6 }}>
          <span className="chip">{Math.round(growth * 100)}% grown</span>
        </div>
        {streak !== undefined && (
          <div style={{ position: "absolute", left: 16, top: 14 }}>
            <div className="hand" style={{ fontSize: 13, color: "var(--ink-faded)" }}>
              {streak} day streak
            </div>
          </div>
        )}
        <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
          <div className="sway">
            <Sprout size={150} growth={growth} mood={mood} />
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 14,
            background: "var(--soil)",
            borderTop: "1.5px solid var(--ink)",
          }}
        />
      </div>
      <div style={{ padding: 16 }}>
        {tags && tags.length > 0 && (
          <div className="tag" style={{ marginBottom: 4 }}>
            {tags.join(" · ")}
          </div>
        )}
        <h3
          className="serif-display"
          style={{ fontSize: 22, margin: "0 0 6px", fontWeight: 500 }}
        >
          {title}
        </h3>
        {summary && (
          <p
            style={{
              fontSize: 13,
              lineHeight: 1.45,
              color: "var(--ink-soft)",
              margin: "0 0 12px",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {summary}
          </p>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-jetbrains)",
              fontSize: 11,
              color: "var(--ink-faded)",
            }}
          >
            {Math.max(0, daysToBloom)} days to bloom
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "var(--moss-deep)",
              fontFamily: "var(--font-fraunces)",
              fontWeight: 500,
            }}
          >
            tend →
          </div>
        </div>
      </div>
    </Link>
  );
}

import type { TaskType } from "@/types/plan";
import { Frog, Mushroom, Sprout } from "./art";

export function TypeBadge({ type }: { type: TaskType }) {
  const cfg =
    type === "review"
      ? {
          bg: "var(--sky-soft)" as const,
          label: "review",
          creature: <Frog size={26} />,
        }
      : type === "milestone"
        ? {
            bg: "var(--sun-soft)" as const,
            label: "milestone",
            creature: <Mushroom size={26} />,
          }
        : {
            bg: "var(--leaf-pale)" as const,
            label: "lesson",
            creature: <Sprout size={28} growth={0.5} />,
          };
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        background: cfg.bg,
        border: "1.5px solid var(--ink)",
        borderRadius: 999,
        fontFamily: "var(--font-fraunces)",
        fontWeight: 600,
        fontSize: 13,
        letterSpacing: "0.04em",
        textTransform: "lowercase",
      }}
    >
      <span style={{ display: "inline-flex" }}>{cfg.creature}</span>
      {cfg.label}
    </div>
  );
}

export function YouTubeBlock({
  videoId,
  caption,
}: {
  videoId: string | null;
  caption?: string;
}) {
  if (!videoId) {
    // Compact "no video" notice — keeps the column from feeling empty
    // when the AI didn't attach a YouTube reference.
    return (
      <div
        className="ink-card soft"
        style={{
          padding: "12px 14px",
          background: "var(--paper)",
          fontFamily: "var(--font-fraunces)",
          fontStyle: "italic",
          fontSize: 13,
          lineHeight: 1.45,
          color: "var(--ink-faded)",
          display: "flex",
          gap: 10,
          alignItems: "center",
        }}
      >
        <span aria-hidden style={{ fontStyle: "normal" }}>📼</span>
        <span>
          no video attached. paste a YouTube link in your sprigs and it&apos;ll
          embed here.
        </span>
      </div>
    );
  }
  return (
    <div style={{ position: "relative", marginBottom: 8 }}>
      <div className="tape" style={{ left: 32, top: -10, transform: "rotate(-3deg)" }} />
      <div className="tape" style={{ right: 60, top: -10, transform: "rotate(2deg)" }} />
      <div
        style={{
          position: "relative",
          borderRadius: 14,
          overflow: "hidden",
          border: "1.5px solid var(--ink)",
          boxShadow: "3px 3px 0 var(--ink)",
        }}
      >
        <iframe
          src={`https://www.youtube.com/embed/${videoId}`}
          title="demo video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          style={{ display: "block", aspectRatio: "16 / 9", width: "100%", border: "none" }}
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
      {caption && (
        <div
          style={{
            marginTop: 8,
            fontFamily: "var(--font-fraunces)",
            fontStyle: "italic",
            fontSize: 13,
            color: "var(--ink-faded)",
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}

export function SessionSection({
  kicker,
  title,
  body,
}: {
  kicker: string;
  title: string;
  body: string;
}) {
  return (
    <div>
      <div className="tag" style={{ marginBottom: 6 }}>
        {kicker}
      </div>
      <h3
        className="serif-display"
        style={{ fontSize: 22, margin: "0 0 8px", fontWeight: 500 }}
      >
        {title}
      </h3>
      <p
        style={{
          margin: 0,
          fontFamily: "var(--font-fraunces)",
          fontSize: 15,
          lineHeight: 1.55,
          color: "var(--ink)",
        }}
      >
        {body}
      </p>
    </div>
  );
}

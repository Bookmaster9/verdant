import type { TaskType } from "@/types/plan";
import { Frog, Mushroom, Sprout } from "@/components/verdant/art";
import { StarRating } from "@/components/verdant/StarRating";
import { displayTitle } from "@/lib/phase";

function ToneCreature({ type, size = 36 }: { type: TaskType; size?: number }) {
  if (type === "review") return <Frog size={size} />;
  if (type === "milestone") return <Mushroom size={size} />;
  return <Sprout size={size} growth={0.5} />;
}

function toneBg(type: TaskType) {
  if (type === "review") return "var(--sky-soft)";
  if (type === "milestone") return "var(--sun-soft)";
  return "var(--leaf-pale)";
}

/**
 * Row content for one entry in the Road Ahead timeline. Designed to be wrapped
 * by a Link in the parent so the whole timeline row (bubble + content) is
 * clickable. The bubble + dashed vine layout lives in the parent.
 */
export function RoadAheadRow({
  title,
  type,
  rating = 0,
  done,
  overdue = false,
}: {
  title: string;
  type: TaskType;
  rating?: number;
  done: boolean;
  overdue?: boolean;
}) {
  return (
    <div
      className="ink-card soft"
      style={{
        display: "grid",
        gridTemplateColumns: "44px 1fr auto auto",
        alignItems: "center",
        gap: 14,
        padding: "10px 14px",
        background: done
          ? "var(--paper-deep)"
          : overdue
            ? "#f8e0db"
            : "var(--paper-warm)",
        opacity: done ? 0.75 : 1,
        borderColor: overdue ? "var(--berry)" : undefined,
      }}
    >
      <ToneCreature type={type} />
      <div>
        <div
          style={{
            fontFamily: "var(--font-fraunces)",
            fontSize: 16,
            fontWeight: 500,
            textDecoration: done ? "line-through" : "none",
          }}
        >
          {displayTitle(title, type)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          <span className="chip" style={{ background: toneBg(type) }}>
            {type}
          </span>
          {done && <span className="chip moss">done</span>}
          {overdue && !done && <span className="chip blush">overdue</span>}
        </div>
      </div>
      <StarRating value={rating} size={16} />
      <span style={{ color: "var(--ink-faded)", fontSize: 16 }}>›</span>
    </div>
  );
}

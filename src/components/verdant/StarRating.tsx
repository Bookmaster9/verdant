"use client";

import { useState } from "react";
import { StarFilled } from "./art";

export function StarRating({
  value = 0,
  onChange,
  size = 22,
}: {
  value?: number;
  onChange?: (n: number) => void;
  size?: number;
}) {
  const [hover, setHover] = useState(0);
  const interactive = Boolean(onChange);
  return (
    <div style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onMouseEnter={() => interactive && setHover(n)}
          onMouseLeave={() => interactive && setHover(0)}
          onClick={() => onChange?.(n)}
          style={{
            background: "transparent",
            border: "none",
            padding: 1,
            cursor: interactive ? "pointer" : "default",
            display: "inline-flex",
          }}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
        >
          <StarFilled size={size} filled={n <= (hover || value)} />
        </button>
      ))}
    </div>
  );
}

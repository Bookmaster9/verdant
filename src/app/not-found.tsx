import Link from "next/link";
import { Shell } from "@/components/Shell";
import { Sprout } from "@/components/verdant/art";

export default function NotFound() {
  return (
    <Shell showHelper={false} showFooter={false}>
      <div
        style={{
          padding: "60px 36px",
          display: "grid",
          placeItems: "center",
          gap: 16,
        }}
      >
        <Sprout size={120} growth={0.05} mood="sleepy" />
        <h1
          className="serif-display"
          style={{ fontSize: 36, margin: 0, fontWeight: 500 }}
        >
          this plot is empty
        </h1>
        <p
          className="hand"
          style={{ color: "var(--ink-soft)", fontSize: 15, textAlign: "center", margin: 0 }}
        >
          we couldn&apos;t find what you were looking for.
        </p>
        <Link href="/dashboard" className="btn primary">
          back to my garden →
        </Link>
      </div>
    </Shell>
  );
}

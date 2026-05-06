import Link from "next/link";
import { GardenStrip } from "./art";

export function FooterStrip() {
  return (
    <div style={{ marginTop: 36, paddingTop: 24, position: "relative" }}>
      <GardenStrip height={70} />
      <div
        style={{
          textAlign: "center",
          marginTop: 8,
          fontFamily: "var(--font-fraunces)",
          fontStyle: "italic",
          fontSize: 14,
          color: "var(--ink-faded)",
        }}
      >
        tend gently, grow patiently
      </div>
      <div
        style={{
          textAlign: "center",
          marginTop: 6,
          fontSize: 12,
          color: "var(--ink-faded)",
          display: "flex",
          gap: 12,
          justifyContent: "center",
        }}
      >
        <Link href="/privacy" style={{ color: "inherit", textDecoration: "none" }}>
          privacy
        </Link>
        <span aria-hidden>·</span>
        <Link href="/terms" style={{ color: "inherit", textDecoration: "none" }}>
          terms
        </Link>
      </div>
    </div>
  );
}

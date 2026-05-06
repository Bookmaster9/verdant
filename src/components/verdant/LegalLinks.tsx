import Link from "next/link";

export function LegalLinks() {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "16px 12px 20px",
        fontSize: 12,
        color: "var(--ink-faded)",
        display: "flex",
        gap: 12,
        justifyContent: "center",
      }}
    >
      <Link
        href="/privacy"
        style={{
          color: "inherit",
          textDecoration: "none",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        privacy
      </Link>
      <span aria-hidden>·</span>
      <Link
        href="/terms"
        style={{
          color: "inherit",
          textDecoration: "none",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        terms
      </Link>
    </div>
  );
}

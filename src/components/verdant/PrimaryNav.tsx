"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sprout } from "./art";
import { UserMenu } from "./UserMenu";

type Item = { href: string; label: string; match?: (p: string) => boolean };

export function PrimaryNav({
  signedIn,
  user,
  pushToCalendar = false,
}: {
  signedIn: boolean;
  user?: { name?: string | null; email?: string | null; image?: string | null } | null;
  pushToCalendar?: boolean;
}) {
  const pathname = usePathname();

  const items: Item[] = signedIn
    ? [
        { href: "/dashboard", label: "My garden" },
        { href: "/schedule", label: "Schedule" },
        { href: "/plan/new", label: "Plant a sprout" },
        { href: "/settings", label: "Settings" },
      ]
    : [];

  const isActive = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(href));

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "20px 36px",
        position: "relative",
        zIndex: 5,
      }}
    >
      <Link
        href={signedIn ? "/dashboard" : "/"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          textDecoration: "none",
        }}
      >
        <Sprout size={48} growth={0.7} />
        <span
          style={{
            fontFamily: "var(--font-caveat)",
            fontSize: 28,
            fontWeight: 700,
            color: "var(--moss-deep)",
          }}
        >
          Verdant
        </span>
      </Link>
      <nav style={{ display: "flex", gap: 4, alignItems: "center" }}>
        {items.map((it) => {
          const active = isActive(it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              style={{
                background: active ? "var(--paper-warm)" : "transparent",
                border: active ? "1.5px solid var(--ink)" : "1.5px solid transparent",
                borderRadius: 999,
                padding: "8px 16px",
                fontFamily: "var(--font-fraunces)",
                fontSize: 15,
                fontWeight: 500,
                color: "var(--ink)",
                boxShadow: active ? "2px 2px 0 var(--ink)" : "none",
                textDecoration: "none",
              }}
            >
              {it.label}
            </Link>
          );
        })}
        {signedIn ? (
          <UserMenu user={user} pushToCalendar={pushToCalendar} />
        ) : (
          <Link href="/login" className="btn primary sm">
            sign in
          </Link>
        )}
      </nav>
    </header>
  );
}

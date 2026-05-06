"use client";

import Image from "next/image";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useEffect, useRef, useState } from "react";

type Props = {
  user?: { name?: string | null; email?: string | null; image?: string | null } | null;
  pushToCalendar: boolean;
};

const ITEM_COUNT = 3;

export function UserMenu({ user, pushToCalendar }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | HTMLButtonElement | null)[]>([]);

  const initial = (user?.name || user?.email || "M")[0]?.toUpperCase() || "M";

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handle(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % ITEM_COUNT);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + ITEM_COUNT) % ITEM_COUNT);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(ITEM_COUNT - 1);
    }
  }

  function close() {
    setOpen(false);
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        marginLeft: 16,
        paddingLeft: 16,
        borderLeft: "1.5px dashed var(--ink-soft)",
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setActiveIndex(0);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: open ? "var(--paper-warm)" : "transparent",
          border: open ? "1.5px solid var(--ink)" : "1.5px solid transparent",
          boxShadow: open ? "2px 2px 0 var(--ink)" : "none",
          borderRadius: 999,
          padding: "4px 12px 4px 4px",
          cursor: "pointer",
          fontFamily: "inherit",
          color: "var(--ink)",
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "var(--sun-soft)",
            border: "1.5px solid var(--ink)",
            display: "grid",
            placeItems: "center",
            fontFamily: "var(--font-fraunces)",
            fontWeight: 600,
            fontSize: 14,
            color: "var(--ink)",
            overflow: "hidden",
          }}
        >
          {user?.image ? (
            <Image
              src={user.image}
              alt=""
              width={36}
              height={36}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            initial
          )}
        </div>
        <div style={{ lineHeight: 1.1, textAlign: "left" }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>
            {user?.name?.split(" ")[0] || "Friend"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--ink-faded)",
              fontFamily: "var(--font-jetbrains)",
            }}
          >
            {user?.email || ""}
          </div>
        </div>
        <span
          aria-hidden
          style={{
            fontSize: 10,
            color: "var(--ink-soft)",
            marginLeft: 2,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 0.15s",
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="account menu"
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            minWidth: 260,
            background: "var(--paper-warm)",
            border: "1.5px solid var(--ink)",
            borderRadius: 14,
            boxShadow: "3px 3px 0 var(--ink)",
            padding: 6,
            zIndex: 20,
          }}
        >
          <Link
            ref={(el) => {
              itemRefs.current[0] = el;
            }}
            role="menuitem"
            href="/settings"
            onClick={close}
            className="verdant-menuitem"
          >
            <span>settings</span>
          </Link>
          <Link
            ref={(el) => {
              itemRefs.current[1] = el;
            }}
            role="menuitem"
            href="/settings#calendars"
            onClick={close}
            className="verdant-menuitem"
          >
            <span>calendar push</span>
            <span
              className={pushToCalendar ? "chip moss" : "chip"}
              style={{ fontSize: 10, padding: "2px 8px" }}
            >
              {pushToCalendar ? "on" : "off"}
            </span>
          </Link>
          <div
            style={{
              borderTop: "1.25px dashed var(--ink-soft)",
              margin: "6px 4px",
            }}
          />
          <button
            ref={(el) => {
              itemRefs.current[2] = el;
            }}
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              void signOut({ callbackUrl: "/" });
            }}
            className="verdant-menuitem danger"
          >
            <span>sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}

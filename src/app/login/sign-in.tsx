"use client";

import { signIn } from "next-auth/react";
import { GoogleG } from "@/components/verdant/art";

export function GoogleSignIn({ disabled }: { disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
      className="btn primary"
      style={{
        width: "100%",
        justifyContent: "center",
        padding: "12px 22px",
        fontSize: 16,
      }}
    >
      <GoogleG size={20} /> Continue with Google
    </button>
  );
}

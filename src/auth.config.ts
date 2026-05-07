import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

const googleId = process.env.AUTH_GOOGLE_ID;
const googleSecret = process.env.AUTH_GOOGLE_SECRET;

const google = Google(
  googleId && googleSecret
    ? {
        clientId: googleId,
        clientSecret: googleSecret,
        authorization: {
          params: {
            // Two non-sensitive scopes replace the prior single calendar.events
            // scope (which let Verdant write anywhere on the user's primary
            // calendar). app.created confines writes to a Verdant-owned
            // secondary calendar; freebusy returns interval-only busy data
            // for primary, no event content.
            scope:
              "openid email profile " +
              "https://www.googleapis.com/auth/calendar.app.created " +
              "https://www.googleapis.com/auth/calendar.events.freebusy",
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: "true",
          },
        },
      }
    : {
        clientId: "placeholder",
        clientSecret: "placeholder",
        authorization: {
          params: { scope: "openid email profile" },
        },
      }
);

export const authConfig = {
  providers: [google],
  pages: { signIn: "/login" },
} satisfies NextAuthConfig;

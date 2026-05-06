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
            scope:
              "openid email profile https://www.googleapis.com/auth/calendar.events",
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

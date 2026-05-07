import NextAuth, { type DefaultSession } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { authConfig } from "./auth.config";
import { prisma } from "./lib/db";

interface RefreshedTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

const SCOPE_APP_CREATED =
  "https://www.googleapis.com/auth/calendar.app.created";
const SCOPE_FREEBUSY =
  "https://www.googleapis.com/auth/calendar.events.freebusy";

/**
 * Inspect the OAuth-granted scope string and return a flag for the dashboard
 * "reconnect Google" banner. `null` = both scopes present (no problem).
 */
function classifyScopeIssue(
  scope: string | undefined
): "freebusy-denied" | "app-created-denied" | "both-denied" | null {
  const set = new Set((scope ?? "").split(/\s+/).filter(Boolean));
  const hasApp = set.has(SCOPE_APP_CREATED);
  const hasFb = set.has(SCOPE_FREEBUSY);
  if (hasApp && hasFb) return null;
  if (!hasApp && !hasFb) return "both-denied";
  if (!hasApp) return "app-created-denied";
  return "freebusy-denied";
}

async function persistScopeIssue(
  userId: string,
  issue: "freebusy-denied" | "app-created-denied" | "both-denied" | null
): Promise<void> {
  try {
    await prisma.userPreference.upsert({
      where: { userId },
      create: {
        userId,
        timeWindows: JSON.stringify({}),
        calendarScopeIssue: issue,
        // New users have nothing to clean up — set the epoch sentinel so the
        // legacy-events banner stays suppressed.
        legacyVerdantEventsAckAt: new Date(0),
      },
      update: { calendarScopeIssue: issue },
    });
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[auth] persistScopeIssue failed:", err);
    }
  }
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<RefreshedTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID ?? "",
      client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = (await res.json()) as RefreshedTokens & { error?: string };
  if (!res.ok) {
    throw new Error(`Refresh failed: ${data.error ?? res.status}`);
  }
  return data;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  adapter: PrismaAdapter(prisma),
  callbacks: {
    async jwt({ token, account, profile }) {
      // First-time sign-in: capture tokens + expiry from the OAuth response.
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at; // seconds since epoch
        token.id = profile?.sub;
        token.refreshError = undefined;
        // Detect granted scopes once at sign-in. If the user denied either of
        // the two calendar scopes via Google's granular consent UI, surface a
        // dashboard banner; otherwise clear any previous issue.
        const issue = classifyScopeIssue(account.scope);
        const userId = profile?.sub;
        if (userId) {
          // Best-effort — don't block sign-in on a write failure.
          await persistScopeIssue(userId, issue);
        }
        return token;
      }

      // Subsequent calls: refresh if access token is within 60s of expiry.
      const nowSec = Math.floor(Date.now() / 1000);
      if (
        token.expiresAt &&
        nowSec < (token.expiresAt as number) - 60 &&
        token.accessToken
      ) {
        return token;
      }
      if (!token.refreshToken) {
        token.refreshError = "no-refresh-token";
        return token;
      }
      try {
        const refreshed = await refreshGoogleAccessToken(
          token.refreshToken as string
        );
        token.accessToken = refreshed.access_token;
        token.expiresAt = nowSec + refreshed.expires_in;
        if (refreshed.refresh_token) {
          token.refreshToken = refreshed.refresh_token;
        }
        token.refreshError = undefined;
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[auth] google token refresh failed:", err);
        }
        token.refreshError = "refresh-failed";
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) (session.user as { id: string }).id = token.sub;
      (session as { accessToken?: string }).accessToken = token.accessToken as string | undefined;
      (session as { refreshError?: string }).refreshError = token.refreshError as
        | string
        | undefined;
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: { id: string; name?: string | null; email?: string | null; image?: string | null } & DefaultSession["user"];
    accessToken?: string;
    refreshError?: string;
  }
}

// JWT-side augmentation removed: callbacks already access token fields via
// runtime casts (`token.accessToken as string | undefined` etc.), so the
// `declare module "next-auth/jwt"` block was unenforced *and* TS could no
// longer resolve the module after the v5 export-map shape changed.

import { auth } from "@/auth";
import { invalidateBusyIntervalsCacheForUser } from "@/lib/calendar-read";
import { NextResponse } from "next/server";

/**
 * Clears server-side Google Calendar read cache for the signed-in user so the
 * next schedule / dashboard load fetches fresh events from Google.
 */
export async function POST() {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  invalidateBusyIntervalsCacheForUser(s.user.id);
  return NextResponse.json({ ok: true });
}

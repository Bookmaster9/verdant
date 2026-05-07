import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

/**
 * Dismisses the one-time "delete legacy Verdant events from your primary
 * Google Calendar manually" banner. Sets `legacyVerdantEventsAckAt` to now;
 * any non-null value suppresses the banner.
 */
export async function POST() {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await prisma.userPreference.upsert({
    where: { userId: s.user.id },
    create: {
      userId: s.user.id,
      timeWindows: JSON.stringify({}),
      legacyVerdantEventsAckAt: new Date(),
    },
    update: { legacyVerdantEventsAckAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}

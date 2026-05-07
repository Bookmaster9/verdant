import { prisma } from "./db";
import { defaultTimeWindowsJson } from "./default-preferences";

// Sentinel for legacyVerdantEventsAckAt: any non-null value suppresses the
// dashboard banner. Brand-new users have nothing to clean up, so we set the
// epoch on create. Only the calendar-scope migration script sets this back
// to null (for users carried through with past sync activity).
const NO_LEGACY_EVENTS_SENTINEL = new Date(0);

export async function ensureUserPreferences(userId: string) {
  return prisma.userPreference.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      timeWindows: defaultTimeWindowsJson(),
      maxMinutesDay: 90,
      legacyVerdantEventsAckAt: NO_LEGACY_EVENTS_SENTINEL,
    },
  });
}

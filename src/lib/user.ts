import { prisma } from "./db";
import { defaultTimeWindowsJson } from "./default-preferences";

export async function ensureUserPreferences(userId: string) {
  return prisma.userPreference.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      timeWindows: defaultTimeWindowsJson(),
      maxMinutesDay: 90,
    },
  });
}

import { prisma } from "./db";
import { defaultTimeWindowsJson } from "./default-preferences";

export async function ensureUserPreferences(userId: string) {
  const existing = await prisma.userPreference.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.userPreference.create({
    data: {
      userId,
      timeWindows: defaultTimeWindowsJson(),
      maxMinutesDay: 90,
    },
  });
}

/**
 * One-shot migration: cut over from the old `calendar.events` scope (writes to
 * the user's primary calendar) to the new pair `calendar.app.created` +
 * `calendar.events.freebusy`. Verdant can no longer touch events on primary, so
 * every existing `calendarEventId` / `googleSynced=true` is dead weight that
 * would mislead drift sync. We wipe both fields on every session in every plan,
 * and mark affected users so the dashboard can show a "delete the orphans
 * yourself" banner once.
 *
 * Run AFTER `prisma db push` adds the new UserPreference columns:
 *   npx tsx scripts/migrate-calendar-scopes.ts
 *
 * Then deploy the new code, then rotate AUTH_SECRET so every session re-auths
 * into the new scope set.
 *
 * Idempotent: re-running is a no-op for already-wiped plans.
 */
import { PrismaClient } from "@prisma/client";
import type { ScheduledSession } from "../src/types/plan";

const prisma = new PrismaClient();

const EPOCH = new Date(0);

async function main() {
  console.log("[migrate-calendar-scopes] starting");

  const plans = await prisma.learningPlan.findMany({
    select: { id: true, userId: true, scheduleJson: true },
  });
  console.log(`[migrate-calendar-scopes] scanning ${plans.length} plans`);

  const affectedUserIds = new Set<string>();
  let plansRewritten = 0;
  let sessionsCleared = 0;

  for (const plan of plans) {
    const sessions = JSON.parse(
      plan.scheduleJson || "[]"
    ) as ScheduledSession[];
    let touched = false;
    const next: ScheduledSession[] = sessions.map((sess) => {
      if (sess.calendarEventId === undefined && !sess.googleSynced) {
        return sess;
      }
      if (sess.googleSynced || sess.calendarEventId) {
        affectedUserIds.add(plan.userId);
        sessionsCleared++;
        touched = true;
      }
      const cleaned: ScheduledSession = { ...sess };
      delete cleaned.calendarEventId;
      delete cleaned.googleSynced;
      return cleaned;
    });
    if (!touched) continue;
    await prisma.learningPlan.update({
      where: { id: plan.id },
      data: { scheduleJson: JSON.stringify(next) },
    });
    plansRewritten++;
  }

  console.log(
    `[migrate-calendar-scopes] cleared ${sessionsCleared} session ids across ${plansRewritten} plans`
  );

  // Affected users: queue the dashboard "delete the legacy events" banner
  // by setting legacyVerdantEventsAckAt = null. Make sure they have a
  // UserPreference row first; ensureUserPreferences runs lazily at the route
  // layer, but the migration needs explicit upserts.
  for (const userId of affectedUserIds) {
    await prisma.userPreference.upsert({
      where: { userId },
      create: {
        userId,
        // Required defaults — match `ensureUserPreferences` shape.
        timeWindows: JSON.stringify({}),
        legacyVerdantEventsAckAt: null,
      },
      update: { legacyVerdantEventsAckAt: null },
    });
  }
  console.log(
    `[migrate-calendar-scopes] flagged ${affectedUserIds.size} users for the orphan-events banner`
  );

  // Every other user (no past sync activity) gets the banner suppressed by
  // setting the ack timestamp to epoch. Otherwise new accounts created BEFORE
  // this migration would also see the banner the first time they hit the
  // dashboard, even though they have no orphans.
  await prisma.userPreference.updateMany({
    where: { legacyVerdantEventsAckAt: null, userId: { notIn: [...affectedUserIds] } },
    data: { legacyVerdantEventsAckAt: EPOCH },
  });

  // Reset verdantCalendarId on every user so the next push attempt creates a
  // fresh Verdant secondary calendar. Defensive: this column was just added,
  // so it's already null for everyone, but make the intent explicit.
  await prisma.userPreference.updateMany({
    data: { verdantCalendarId: null, calendarScopeIssue: null },
  });

  console.log("[migrate-calendar-scopes] done");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

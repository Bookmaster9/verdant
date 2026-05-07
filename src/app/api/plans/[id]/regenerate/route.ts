import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { ensureUserPreferences } from "@/lib/user";
import { generatePlanWithAI } from "@/lib/generate-sprout";
import { getExternalBusy } from "@/lib/calendar-read";
import { summarizeAvailability } from "@/lib/availability-summary";
import { packWithScoring } from "@/lib/scoring-pack";
import { parseBlackouts, blackoutsToBusy } from "@/lib/blackouts";
import {
  compileForbidRulesToBusy,
  parsePlacementRules,
} from "@/lib/placement-rules";
import { loadProjectedReviewTasks } from "@/lib/load-projected-reviews";
import type { ScheduledSession, SproutPlan } from "@/types/plan";
import { parseTimeWindowsJson } from "@/lib/default-preferences";
import { parseHourUtility } from "@/lib/hour-utility";
import { revalidatePath } from "next/cache";
import {
  applyYoutubeVideoLengthsToLessonMinutes,
  enrichSproutWithYoutubePlaylist,
  findYoutubePlaylistIdInResources,
} from "@/lib/youtube-playlist";
import { NextResponse } from "next/server";
import { z } from "zod";

const body = z.object({ revert: z.boolean().optional() });

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Regenerate the plan with the current rich context (design Q9 manual upgrade
 * path). Stores the previous `planJson` as `planJsonPrev` so the user can
 * revert in one click. Schedule is rebuilt through the scoring packer; locked
 * future sessions are preserved.
 *
 * `{ revert: true }` swaps `planJsonPrev` back into `planJson` and re-packs.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
  });
  if (!plan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const initialResourcesList = JSON.parse(plan.initialResources || "[]") as string[];
  if (
    findYoutubePlaylistIdInResources(initialResourcesList) &&
    !process.env.YOUTUBE_API_KEY?.trim()
  ) {
    return NextResponse.json(
      {
        error:
          "YouTube playlist URLs require YOUTUBE_API_KEY in .env (enable YouTube Data API v3).",
      },
      { status: 400 }
    );
  }

  const parsed = body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const wantRevert = parsed.data.revert === true;

  const pref = await ensureUserPreferences(s.user.id);
  const tw = parseTimeWindowsJson(pref.timeWindows);
  const hourUtility = parseHourUtility(pref.hourUtility);
  const startDate = new Date();
  const now = startDate;
  const deadline = new Date(plan.deadline.getTime() + 864e5);

  const busyRead = await getExternalBusy({
    userId: s.user.id,
    accessToken: s.accessToken,
    from: startDate,
    to: deadline,
  });
  const externalBusy = busyRead.intervals;
  const blackoutBusy = blackoutsToBusy(parseBlackouts(plan.manualBlackouts));

  let nextPlanJson: string;
  let nextPrevJson: string | null;

  if (wantRevert) {
    if (!plan.planJsonPrev) {
      return NextResponse.json(
        { error: "Nothing to revert to." },
        { status: 400 }
      );
    }
    nextPlanJson = plan.planJsonPrev;
    nextPrevJson = plan.planJson;
  } else {
    const days = Math.max(
      1,
      Math.ceil((plan.deadline.getTime() - plan.startDate.getTime()) / 86_400_000)
    );
    const weeks = Math.max(1, Math.ceil(days / 7));
    const availability = summarizeAvailability({
      startDate: plan.startDate,
      weeks,
      timeWindows: tw,
      busy: externalBusy,
      hourUtility,
      now,
    });
    let sprout = await generatePlanWithAI({
      targetSkill: plan.targetSkill,
      deadline: plan.deadline,
      startDate: plan.startDate,
      initialResources: initialResourcesList,
      availability,
      weeklyMinutesTarget: pref.weeklyMinutesTarget,
      freeformNote: plan.freeformNote,
    });
    if (findYoutubePlaylistIdInResources(initialResourcesList)) {
      sprout = await enrichSproutWithYoutubePlaylist(sprout, initialResourcesList);
    }
    const ytKey = process.env.YOUTUBE_API_KEY?.trim();
    if (ytKey) {
      sprout = {
        ...sprout,
        tasks: await applyYoutubeVideoLengthsToLessonMinutes(sprout.tasks, ytKey),
      };
    }
    nextPlanJson = JSON.stringify(sprout);
    nextPrevJson = plan.planJson;
  }

  const sproutOut = JSON.parse(nextPlanJson) as SproutPlan;
  const oldSchedule = JSON.parse(plan.scheduleJson || "[]") as ScheduledSession[];
  // Regenerate may drop / rename plan tasks. A locked session whose planTaskId
  // no longer exists in the new plan is an orphan — keeping it would leak a
  // dangling reference into the road ahead. Filter the lock set down to those
  // tasks that survived the regen.
  const survivingTaskIds = new Set(
    (sproutOut.tasks ?? []).map((t) => t.id)
  );
  const reviewIdRows = await prisma.reviewInstance.findMany({
    where: { planId: id },
    select: { id: true },
  });
  for (const r of reviewIdRows) survivingTaskIds.add(r.id);
  const lockedFutureRaw = oldSchedule.filter(
    (sess) => new Date(sess.start) >= startDate && sess.locked
  );
  const lockedFuture = lockedFutureRaw.filter((sess) => {
    if (sess.agenda && sess.agenda.length > 0) {
      return sess.agenda.some((a) => survivingTaskIds.has(a.planTaskId));
    }
    return survivingTaskIds.has(sess.planTaskId);
  });
  const placedTaskIds = new Set<string>();
  for (const sess of lockedFuture) {
    if (sess.agenda) for (const a of sess.agenda) placedTaskIds.add(a.planTaskId);
    else placedTaskIds.add(sess.planTaskId);
  }
  // Reviews live as ReviewInstance rows (not in sproutOut.tasks). Without
  // this, regenerate quietly drops every projected review.
  const projectedReviews = await loadProjectedReviewTasks({
    planId: id,
    sproutPlan: sproutOut,
    planStartDate: plan.startDate,
  });
  // Skip tasks the user has already committed — see route.ts for full rationale.
  const completedRows = await prisma.taskCompletion.findMany({
    where: { planId: id, completed: true },
    select: { taskId: true },
  });
  const completedTaskIds = new Set(completedRows.map((c) => c.taskId));
  const tasksToPack = [
    ...sproutOut.tasks.filter(
      (t) => !placedTaskIds.has(t.id) && !completedTaskIds.has(t.id)
    ),
    ...projectedReviews.filter((t) => !placedTaskIds.has(t.id)),
  ];

  const lockedAsBusy = lockedFuture.map((sess) => ({
    start: new Date(sess.start),
    end: new Date(sess.end),
  }));

  const persistentRules = parsePlacementRules(plan.placementRules);
  const forbidBusy = compileForbidRulesToBusy(persistentRules, {
    startDate,
    deadline,
  });

  const result = packWithScoring(tasksToPack, {
    startDate,
    deadline,
    timeWindows: tw,
    busy: [...externalBusy, ...lockedAsBusy, ...blackoutBusy, ...forbidBusy],
    maxMinutesPerDay: pref.maxMinutesDay,
    hourUtility,
    now,
    planId: id,
    placementRules: persistentRules,
    phaseCount: sproutOut.phases.length,
  });
  const newSchedule = [...lockedFuture, ...result.schedule].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  const updated = await prisma.learningPlan.update({
    where: { id },
    data: {
      planJson: nextPlanJson,
      planJsonPrev: nextPrevJson,
      scheduleJson: JSON.stringify(newSchedule),
    },
  });

  revalidatePath(`/plan/${id}`);
  revalidatePath(`/plan/${id}/session/[taskId]`, "page");
  revalidatePath("/schedule");
  revalidatePath("/");

  return NextResponse.json({
    plan: updated,
    overflow: result.overflow.map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority ?? "core",
    })),
    reverted: wantRevert,
  });
}

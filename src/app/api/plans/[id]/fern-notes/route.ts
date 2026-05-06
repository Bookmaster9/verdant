import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { generateFernNotes } from "@/lib/generate-fern-notes";
import type { ScheduledSession, SproutPlan } from "@/types/plan";
import type { FernNotesContext } from "@/prompts/fern-notes";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import { NextResponse } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
    select: { fernNotes: true, fernNotesGeneratedAt: true },
  });
  if (!plan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    notes: JSON.parse(plan.fernNotes || "[]"),
    generatedAt: plan.fernNotesGeneratedAt,
  });
}

export async function POST(_: Request, { params }: RouteParams) {
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

  const sprout: SproutPlan = JSON.parse(plan.planJson) as SproutPlan;
  const schedule: ScheduledSession[] = JSON.parse(
    plan.scheduleJson || "[]"
  ) as ScheduledSession[];
  const completions = await prisma.taskCompletion.findMany({
    where: { planId: id },
  });
  const completionByTask = new Map(completions.map((c) => [c.taskId, c]));

  const totalTasks = sprout.tasks?.length ?? schedule.length ?? 0;
  const doneCount = completions.filter((c) => c.completed).length;
  const ratings = completions
    .filter((c) => c.completed && typeof c.rating === "number")
    .map((c) => c.rating as number);
  const averageRating =
    ratings.length === 0 ? null : ratings.reduce((a, b) => a + b, 0) / ratings.length;
  const daysToBloom = Math.max(
    0,
    differenceInCalendarDays(plan.deadline, new Date())
  );

  // Recent completions: pull from schedule + completion data, newest first.
  const completedSessions = schedule
    .filter((row) => parseISO(row.end) < new Date())
    .sort((a, b) => +parseISO(b.start) - +parseISO(a.start));
  const recentCompletions = completedSessions.slice(0, 6).map((row) => {
    const taskId =
      row.agenda && row.agenda.length > 0 ? row.agenda[0].planTaskId : row.planTaskId;
    const c = completionByTask.get(taskId);
    return {
      title: row.title,
      date: format(parseISO(row.start), "MMM d"),
      rating: c?.rating ?? null,
    };
  });

  const upcoming = schedule
    .filter((row) => parseISO(row.end) >= new Date())
    .sort((a, b) => +parseISO(a.start) - +parseISO(b.start))
    .slice(0, 6)
    .map((row) => ({
      title: row.title,
      date: format(parseISO(row.start), "EEE MMM d"),
      type: row.type,
    }));
  const milestone = upcoming.find((u) => u.type === "milestone");

  const ctx: FernNotesContext = {
    planTitle: plan.title,
    planSummary: sprout.summary || "",
    daysToBloom,
    totalTasks,
    doneCount,
    averageRating,
    recentCompletions,
    upcoming,
    nextMilestone: milestone
      ? { title: milestone.title, date: milestone.date }
      : null,
  };

  const { notes, usedAi } = await generateFernNotes(ctx);
  const generatedAt = new Date();
  await prisma.learningPlan.update({
    where: { id },
    data: {
      fernNotes: JSON.stringify(notes),
      fernNotesGeneratedAt: generatedAt,
    },
  });

  return NextResponse.json({ notes, generatedAt, usedAi });
}

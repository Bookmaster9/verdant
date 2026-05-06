import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import OpenAI from "openai";
import type { PlanTask, ScheduledSession, SproutPlan } from "@/types/plan";
import { phaseForWeek } from "@/lib/phase";
import {
  buildSchedulingFragment,
  resolveObjective,
  resolveSteps,
  resolveSuccessCriteria,
} from "@/lib/session-content";
import {
  getTaskJournalDelegate,
  taskJournalUnavailable,
} from "@/lib/task-journal";
import {
  DEEPEN_PRESETS,
  FERN_TUTOR_MODEL,
  FERN_TUTOR_SYSTEM,
  FERN_TUTOR_TEMPERATURE,
  buildLessonContext,
} from "@/prompts/fern-tutor";

/**
 * "Ask Fern to expand" — preset prompts persisted as a sliding window of the
 * last 3 cards per (planId, taskId), stored in `TaskJournal.deepenJson`.
 *
 *   - POST { presetId } → generates a new card, appends + trims, returns the
 *     full updated card list and the newly-created card.
 *   - GET → returns the persisted card list (used to hydrate the page).
 *   - DELETE → clears all cards.
 *   - DELETE ?cardId=… → removes one specific card.
 */

const CARD_LIMIT = 3;

const postBody = z.object({
  presetId: z.string().min(1).max(64),
});

const cardSchema = z.object({
  id: z.string().min(1).max(64),
  presetId: z.string().min(1).max(64),
  content: z.string().max(20_000),
  createdAt: z.string(),
});
const cardsSchema = z.array(cardSchema).max(20);
export type DeepenCard = z.infer<typeof cardSchema>;

function parseCardsSafe(json: string): DeepenCard[] {
  try {
    const parsed = cardsSchema.safeParse(JSON.parse(json || "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

type RouteParams = { params: Promise<{ id: string; taskId: string }> };

async function resolveTask(args: {
  planId: string;
  taskId: string;
  sprout: SproutPlan;
}): Promise<{ task: PlanTask; parent?: PlanTask } | null> {
  const tasks = args.sprout.tasks ?? [];
  const planTask = tasks.find((t) => t.id === args.taskId);
  if (planTask) return { task: planTask };

  const ri = await prisma.reviewInstance.findUnique({
    where: { id: args.taskId },
    include: { lessonState: true },
  });
  if (!ri || ri.planId !== args.planId) return null;
  const parent = tasks.find((t) => t.id === ri.lessonState.lessonId);
  const synthesized: PlanTask = {
    id: ri.id,
    title: `Review: ${parent?.title ?? "earlier lesson"}`,
    type: "review",
    minutes: 15,
    weekIndex: parent?.weekIndex ?? 0,
    dayOffsetInWeek: parent?.dayOffsetInWeek ?? 0,
    description: parent?.description,
    resourceRef: parent?.resourceRef,
    dueAt: ri.dueAt.toISOString(),
    priority: "core",
  };
  return { task: synthesized, parent };
}

export async function GET(_: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, taskId } = await params;
  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
    select: { id: true },
  });
  if (!plan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const tj = getTaskJournalDelegate() as {
    findUnique: (args: {
      where: { planId_taskId: { planId: string; taskId: string } };
      select: { deepenJson: true };
    }) => Promise<{ deepenJson: string } | null>;
  } | null;
  if (!tj) {
    return NextResponse.json({ cards: [] });
  }
  const entry = await tj.findUnique({
    where: { planId_taskId: { planId: id, taskId } },
    select: { deepenJson: true },
  });
  return NextResponse.json({ cards: parseCardsSafe(entry?.deepenJson ?? "[]") });
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, taskId } = await params;
  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
    select: { id: true },
  });
  if (!plan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const tj = getTaskJournalDelegate() as {
    findUnique: (args: {
      where: { planId_taskId: { planId: string; taskId: string } };
      select: { deepenJson: true };
    }) => Promise<{ deepenJson: string } | null>;
    upsert: (args: {
      where: { planId_taskId: { planId: string; taskId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
  } | null;
  if (!tj) return taskJournalUnavailable();

  const url = new URL(request.url);
  const cardId = url.searchParams.get("cardId");
  if (cardId) {
    const entry = await tj.findUnique({
      where: { planId_taskId: { planId: id, taskId } },
      select: { deepenJson: true },
    });
    const existing = parseCardsSafe(entry?.deepenJson ?? "[]");
    const next = existing.filter((c) => c.id !== cardId);
    await tj.upsert({
      where: { planId_taskId: { planId: id, taskId } },
      create: { planId: id, taskId, deepenJson: JSON.stringify(next) },
      update: { deepenJson: JSON.stringify(next) },
    });
    return NextResponse.json({ cards: next });
  }
  await tj.upsert({
    where: { planId_taskId: { planId: id, taskId } },
    create: { planId: id, taskId, deepenJson: "[]" },
    update: { deepenJson: "[]" },
  });
  return NextResponse.json({ cards: [] });
}

export async function POST(request: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, taskId } = await params;
  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
  });
  if (!plan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const json = await request.json();
  const parsed = postBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const preset = DEEPEN_PRESETS.find((p) => p.id === parsed.data.presetId);
  if (!preset) {
    return NextResponse.json({ error: "Unknown preset" }, { status: 400 });
  }

  const sprout = JSON.parse(plan.planJson) as SproutPlan;
  const resolved = await resolveTask({ planId: id, taskId, sprout });
  if (!resolved) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const { task, parent } = resolved;
  const isReview = !sprout.tasks?.some((t) => t.id === task.id);
  const phases = sprout.phases ?? [];
  const phaseIdx = phaseForWeek(task.weekIndex, phases.length);
  const phaseName = phases[phaseIdx]?.name || "Phase";
  const schedule = JSON.parse(plan.scheduleJson || "[]") as ScheduledSession[];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Deepen requires OPENAI_API_KEY in the environment." },
      { status: 503 }
    );
  }

  const tj = getTaskJournalDelegate() as {
    findUnique: (args: {
      where: { planId_taskId: { planId: string; taskId: string } };
      select: { deepenJson: true };
    }) => Promise<{ deepenJson: string } | null>;
    upsert: (args: {
      where: { planId_taskId: { planId: string; taskId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
  } | null;
  if (!tj) return taskJournalUnavailable();

  const schedulingFragment = buildSchedulingFragment({
    task,
    plan: { startDate: plan.startDate, deadline: plan.deadline },
    sprout,
    schedule,
    isReview,
    parentLesson: parent,
  });
  const lessonContext = buildLessonContext({
    task,
    planTitle: plan.title,
    targetSkill: plan.targetSkill,
    phaseName,
    parentLesson: parent,
    resolvedObjective: resolveObjective(task, parent),
    resolvedSteps: resolveSteps(task, parent),
    resolvedSuccessCriteria: resolveSuccessCriteria(task, parent),
    schedulingFragment,
  });

  const openai = new OpenAI({ apiKey });
  let reply = "";
  try {
    const res = await openai.chat.completions.create({
      model: FERN_TUTOR_MODEL,
      temperature: FERN_TUTOR_TEMPERATURE,
      messages: [
        { role: "system", content: FERN_TUTOR_SYSTEM },
        { role: "system", content: lessonContext },
        { role: "user", content: preset.instruction },
      ],
    });
    reply = res.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "fern got distracted — try again",
      },
      { status: 502 }
    );
  }
  if (!reply) {
    return NextResponse.json(
      { error: "fern returned an empty note" },
      { status: 502 }
    );
  }

  // Persist into the sliding window. Read existing → append → trim oldest.
  const existing = await tj.findUnique({
    where: { planId_taskId: { planId: id, taskId } },
    select: { deepenJson: true },
  });
  const priorCards = parseCardsSafe(existing?.deepenJson ?? "[]");
  const newCard: DeepenCard = {
    id: `${preset.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    presetId: preset.id,
    content: reply,
    createdAt: new Date().toISOString(),
  };
  const trimmed = [...priorCards, newCard].slice(-CARD_LIMIT);
  await tj.upsert({
    where: { planId_taskId: { planId: id, taskId } },
    create: { planId: id, taskId, deepenJson: JSON.stringify(trimmed) },
    update: { deepenJson: JSON.stringify(trimmed) },
  });

  return NextResponse.json({ card: newCard, cards: trimmed });
}

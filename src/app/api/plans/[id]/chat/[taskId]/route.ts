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
  FERN_TUTOR_MODEL,
  FERN_TUTOR_SYSTEM,
  FERN_TUTOR_TEMPERATURE,
  buildLessonContext,
} from "@/prompts/fern-tutor";

/**
 * Per-task Fern chat. Sliding window of the last 3 turns (= 6 messages)
 * persisted in `TaskJournal.chatJson`. The route is the single source of
 * truth for the trim — clients send only the new message.
 *
 * Flow on POST { message }:
 *   1. Auth + plan ownership check.
 *   2. Resolve the PlanTask (lesson/milestone in planJson, OR synthesize from
 *      a ReviewInstance row).
 *   3. Load existing turns from TaskJournal.chatJson.
 *   4. Build the OpenAI message array: system prompt + lesson context as a
 *      system message + last 3 turns + the new user message.
 *   5. Call OpenAI gpt-4o-mini.
 *   6. Append { user, fern } to turns, trim to last 3, persist.
 *   7. Return the full visible turns array so the client can re-render.
 *
 * GET returns just the turns (used on page load to hydrate the chat tab).
 * DELETE clears the chat history.
 */

const TURN_LIMIT = 3; // turns = (user, fern) pairs

const messageRoleSchema = z.enum(["user", "fern"]);
const turnSchema = z.object({
  role: messageRoleSchema,
  content: z.string().max(8000),
});
const turnsSchema = z.array(turnSchema).max(20); // accept slack on read; we'll trim on write

export type ChatTurn = z.infer<typeof turnSchema>;

const postBody = z.object({
  message: z.string().min(1).max(4000),
});

type RouteParams = { params: Promise<{ id: string; taskId: string }> };

function parseTurnsSafe(json: string): ChatTurn[] {
  try {
    const parsed = turnsSchema.safeParse(JSON.parse(json || "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Trim to the last `TURN_LIMIT` turns. A turn = adjacent (user, fern) pair. */
function trimTurns(turns: ChatTurn[]): ChatTurn[] {
  // Walk pairs from the end. Keep up to TURN_LIMIT * 2 messages but only
  // when they form clean (user, fern) pairs at the tail. A dangling user
  // message at the very end is kept (it's the message the next reply
  // attaches to).
  const out: ChatTurn[] = [];
  let pairsKept = 0;
  let i = turns.length - 1;
  // Optional dangling user
  if (i >= 0 && turns[i].role === "user") {
    out.unshift(turns[i]);
    i -= 1;
  }
  // Pairs (fern, user) walking backward
  while (i >= 1 && pairsKept < TURN_LIMIT) {
    const fern = turns[i];
    const user = turns[i - 1];
    if (fern.role === "fern" && user.role === "user") {
      out.unshift(fern);
      out.unshift(user);
      pairsKept += 1;
      i -= 2;
    } else {
      i -= 1;
    }
  }
  return out;
}

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
      select: { chatJson: true };
    }) => Promise<{ chatJson: string } | null>;
  } | null;
  if (!tj) {
    return NextResponse.json({ turns: [] });
  }
  const entry = await tj.findUnique({
    where: { planId_taskId: { planId: id, taskId } },
    select: { chatJson: true },
  });
  return NextResponse.json({ turns: parseTurnsSafe(entry?.chatJson ?? "[]") });
}

export async function DELETE(_: Request, { params }: RouteParams) {
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
    upsert: (args: {
      where: { planId_taskId: { planId: string; taskId: string } };
      create: { planId: string; taskId: string; chatJson: string };
      update: { chatJson: string };
    }) => Promise<unknown>;
  } | null;
  if (!tj) return taskJournalUnavailable();
  await tj.upsert({
    where: { planId_taskId: { planId: id, taskId } },
    create: { planId: id, taskId, chatJson: "[]" },
    update: { chatJson: "[]" },
  });
  return NextResponse.json({ turns: [] });
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
      { error: "Chat requires OPENAI_API_KEY in the environment." },
      { status: 503 }
    );
  }

  const tj = getTaskJournalDelegate() as {
    findUnique: (args: {
      where: { planId_taskId: { planId: string; taskId: string } };
    }) => Promise<{ chatJson: string } | null>;
    upsert: (args: {
      where: { planId_taskId: { planId: string; taskId: string } };
      create: { planId: string; taskId: string; chatJson: string };
      update: { chatJson: string };
    }) => Promise<unknown>;
  } | null;
  if (!tj) return taskJournalUnavailable();

  // Load existing turns and append the new user message before sending.
  const journal = await tj.findUnique({
    where: { planId_taskId: { planId: id, taskId } },
  });
  const priorTurns = parseTurnsSafe(journal?.chatJson ?? "[]");
  const userMessage: ChatTurn = { role: "user", content: parsed.data.message };
  const conversation: ChatTurn[] = [...priorTurns, userMessage];

  // Build the OpenAI request. Lesson context as a second system message keeps
  // it out of the rolling history and lets the model reweight it on each turn.
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
  type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
  const messages: ChatMsg[] = [
    { role: "system", content: FERN_TUTOR_SYSTEM },
    { role: "system", content: lessonContext },
    ...conversation.map(
      (t): ChatMsg => ({
        role: t.role === "fern" ? "assistant" : "user",
        content: t.content,
      })
    ),
  ];

  let reply = "";
  try {
    const res = await openai.chat.completions.create({
      model: FERN_TUTOR_MODEL,
      temperature: FERN_TUTOR_TEMPERATURE,
      messages,
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

  const fernTurn: ChatTurn = { role: "fern", content: reply };
  const trimmed = trimTurns([...conversation, fernTurn]);

  await tj.upsert({
    where: { planId_taskId: { planId: id, taskId } },
    create: { planId: id, taskId, chatJson: JSON.stringify(trimmed) },
    update: { chatJson: JSON.stringify(trimmed) },
  });

  return NextResponse.json({ reply, turns: trimmed });
}

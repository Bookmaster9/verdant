import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import {
  getTaskJournalDelegate,
  taskJournalUnavailable,
} from "@/lib/task-journal";
import { NextResponse } from "next/server";
import { z } from "zod";

const putBody = z.object({
  body: z.string().max(20_000),
});

type RouteParams = { params: Promise<{ id: string; taskId: string }> };

async function authorize(
  planId: string,
  userId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const plan = await prisma.learningPlan.findFirst({
    where: { id: planId, userId },
    select: { id: true },
  });
  if (!plan) return { ok: false, status: 404, error: "Not found" };
  return { ok: true };
}

export async function GET(_: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, taskId } = await params;
  const ok = await authorize(id, s.user.id);
  if (!ok.ok) {
    return NextResponse.json({ error: ok.error }, { status: ok.status });
  }
  const tj = getTaskJournalDelegate() as {
    findUnique: (args: {
      where: { planId_taskId: { planId: string; taskId: string } };
    }) => Promise<{ body: string; updatedAt: Date } | null>;
  } | null;
  if (!tj) {
    return NextResponse.json({ body: "", updatedAt: null });
  }
  const entry = await tj.findUnique({
    where: { planId_taskId: { planId: id, taskId } },
  });
  return NextResponse.json({
    body: entry?.body ?? "",
    updatedAt: entry?.updatedAt?.toISOString() ?? null,
  });
}

export async function PUT(request: Request, { params }: RouteParams) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, taskId } = await params;
  const ok = await authorize(id, s.user.id);
  if (!ok.ok) {
    return NextResponse.json({ error: ok.error }, { status: ok.status });
  }
  const json = await request.json();
  const parsed = putBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const tj = getTaskJournalDelegate() as {
    upsert: (args: {
      where: { planId_taskId: { planId: string; taskId: string } };
      create: { planId: string; taskId: string; body: string };
      update: { body: string };
    }) => Promise<{ body: string; updatedAt: Date }>;
  } | null;
  if (!tj) return taskJournalUnavailable();
  const entry = await tj.upsert({
    where: { planId_taskId: { planId: id, taskId } },
    create: { planId: id, taskId, body: parsed.data.body },
    update: { body: parsed.data.body },
  });
  return NextResponse.json({
    body: entry.body,
    updatedAt: entry.updatedAt.toISOString(),
  });
}

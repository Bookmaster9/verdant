/**
 * NL plan editor (design Q-edit-llm).
 *
 * `interpretEdit` calls the LLM with a compact view of the plan + upcoming
 * sessions, validates the response against a closed Zod union, and returns
 * the parsed ops + rules. `applyEditOps` (in `apply-edit-ops.ts`) applies the
 * ops imperatively and threads the rules into the scoring packer.
 *
 * If `interpretEdit` returns `ok: false`, the route returns the error to the
 * user — there is no fallback editor anymore. The HuggingFace path was
 * deleted because it bypassed every constraint the structured packer enforces.
 */
import OpenAI from "openai";
import { z } from "zod";
import {
  EDIT_PLAN_MODEL,
  EDIT_PLAN_SYSTEM,
  EDIT_PLAN_TEMPERATURE,
  buildEditPlanUserPrompt,
} from "@/prompts/edit-plan";
import type { ScheduledSession, SproutPlan } from "@/types/plan";

const dayOfWeekSchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const timeOfDaySchema = z.enum(["morning", "afternoon", "evening", "any"]);
const taskTypeSchema = z.enum(["lesson", "review", "milestone"]);
const prioritySchema = z.enum(["core", "stretch"]);
const yyyymmdd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Coerce single value → singleton array. The LLM sometimes returns "fri" instead of ["fri"]. */
const dayOfWeekListSchema = z.preprocess((v) => {
  if (typeof v === "string") return [v];
  return v;
}, z.array(dayOfWeekSchema));

const taskIdsSchema = z.preprocess((v) => {
  if (typeof v === "string") return [v];
  return v;
}, z.array(z.string()));

/**
 * `.passthrough()` on the leaf objects so unknown keys the LLM occasionally
 * adds (e.g. a "note" field) don't fail the parse — they're just ignored.
 * Optional fields stay optional; required ones still throw.
 */
const ruleFilterSchema = z
  .object({
    type: taskTypeSchema.optional(),
    dayOfWeek: dayOfWeekListSchema.optional(),
    weekIndex: z.number().int().min(0).max(60).optional(),
    phaseIndex: z.number().int().min(0).max(20).optional(),
    priority: prioritySchema.optional(),
    taskIds: taskIdsSchema.optional(),
  })
  .passthrough();

export const editOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("extend_task"),
    taskId: z.string(),
    addMinutes: z.number().int().min(-90).max(90),
  }),
  z.object({
    op: z.literal("insert_task"),
    afterTaskId: z.string(),
    title: z.string().min(1).max(200),
    type: taskTypeSchema,
    minutes: z.number().int().min(15).max(90),
    priority: prioritySchema.default("core"),
  }),
  z.object({
    op: z.literal("remove_task"),
    taskId: z.string(),
  }),
  z.object({
    op: z.literal("set_priority"),
    taskId: z.string(),
    priority: prioritySchema,
  }),
]);

export const placementRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prefer"),
      filter: ruleFilterSchema.optional().default({}),
      target: z
        .object({
          dayOfWeek: dayOfWeekListSchema.optional(),
          timeOfDay: timeOfDaySchema.optional(),
          weekIndex: z.number().int().min(0).max(60).optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("forbid"),
      filter: ruleFilterSchema.optional().default({}),
      window: z
        .object({
          dayOfWeek: dayOfWeekListSchema.optional(),
          date: yyyymmdd.optional(),
          dateRange: z
            .object({ from: yyyymmdd, to: yyyymmdd })
            .optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("pin"),
      sessionId: z.string(),
      start: z.string(),
    })
    .passthrough(),
]);

export type EditOp = z.infer<typeof editOpSchema>;

const responseSchema = z.object({
  ops: z.array(editOpSchema).max(20).default([]),
  rules: z.array(placementRuleSchema).max(20).default([]),
  summary: z.string().max(400),
});

export type InterpretResult =
  | {
      ok: true;
      ops: EditOp[];
      rules: z.infer<typeof placementRuleSchema>[];
      summary: string;
    }
  | { ok: false; reason: string };

export async function interpretEdit(args: {
  request: string;
  plan: SproutPlan;
  schedule: ScheduledSession[];
  now: Date;
}): Promise<InterpretResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, reason: "no-api-key" };

  const planView = {
    phases: args.plan.phases.map((p) => ({ name: p.name, focus: p.focus })),
    tasks: args.plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      type: t.type,
      weekIndex: t.weekIndex,
      priority: t.priority,
    })),
  };
  const scheduleView = args.schedule
    .filter((s) => new Date(s.start) >= args.now)
    .slice(0, 20)
    .map((s) => ({
      id: s.id,
      planTaskId: s.planTaskId,
      title: s.title,
      start: s.start,
      locked: !!s.locked,
    }));

  const userContent = buildEditPlanUserPrompt({
    request: args.request,
    planView,
    scheduleView,
    todayIso: args.now.toISOString(),
  });

  let rawText: string | undefined;
  try {
    const openai = new OpenAI({ apiKey: key });
    const res = await openai.chat.completions.create({
      model: EDIT_PLAN_MODEL,
      temperature: EDIT_PLAN_TEMPERATURE,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EDIT_PLAN_SYSTEM },
        { role: "user", content: userContent },
      ],
    });
    rawText = res.choices[0]?.message?.content ?? undefined;
    if (!rawText) return { ok: false, reason: "empty-response" };
    const parsed = responseSchema.parse(JSON.parse(rawText));
    if (process.env.NODE_ENV !== "production") {
      console.log(
        "[interpretEdit] ok",
        JSON.stringify({
          ops: parsed.ops.length,
          rules: parsed.rules.length,
          summary: parsed.summary,
        })
      );
    }
    if (parsed.ops.length === 0 && parsed.rules.length === 0) {
      return { ok: false, reason: parsed.summary || "no-ops-or-rules" };
    }
    return {
      ok: true,
      ops: parsed.ops,
      rules: parsed.rules,
      summary: parsed.summary,
    };
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[interpretEdit] failed:",
        err instanceof Error ? err.message : err
      );
      if (rawText) {
        console.warn("[interpretEdit] raw model output:", rawText.slice(0, 1500));
      }
    }
    return { ok: false, reason: "interpret-failed" };
  }
}

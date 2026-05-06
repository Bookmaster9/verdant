import OpenAI from "openai";
import { z } from "zod";
import type { SproutPlan } from "@/types/plan";
import { buildId } from "./ids";
import {
  SPROUT_PLAN_MODEL,
  SPROUT_PLAN_SYSTEM,
  SPROUT_PLAN_TEMPERATURE,
  buildSproutPlanUserPrompt,
} from "@/prompts/sprout-plan";

const planSchema = z.object({
  summary: z.string(),
  phases: z.array(z.object({ name: z.string(), focus: z.string() })),
  tasks: z.array(
    z.object({
      id: z.string().optional(),
      title: z.string().transform((s) => s.trim()),
      type: z.enum(["lesson", "review", "milestone"]),
      minutes: z.number().min(5).max(120),
      weekIndex: z.number().min(0),
      dayOffsetInWeek: z.number().min(0).max(6),
      description: z
        .string()
        .optional()
        .transform((s) => (s ? s.trim() : s)),
      objective: z
        .string()
        .optional()
        .transform((s) => (s ? s.trim() : s)),
      steps: z
        .array(z.string().transform((s) => s.trim()).pipe(z.string().min(1)))
        .max(8)
        .optional(),
      successCriteria: z
        .array(z.string().transform((s) => s.trim()).pipe(z.string().min(1)))
        .max(6)
        .optional(),
      resourceRef: z
        .string()
        .optional()
        .transform((s) => (s ? s.trim() : s)),
      preferredTimeOfDay: z
        .enum(["morning", "afternoon", "evening", "any"])
        .optional(),
      mustFollowTaskId: z.string().optional(),
      minDaysAfterPredecessor: z.number().int().min(0).max(60).optional(),
      preferStandalone: z.boolean().optional(),
      priority: z.enum(["core", "stretch"]).optional(),
    })
  ),
  rationale: z.array(z.string()).optional(),
  weeklyShape: z
    .object({
      lessons: z.coerce.number(),
      reviews: z.coerce.number(),
      milestoneEvery: z.string(),
    })
    .optional(),
  sessionsPlanned: z.coerce.number().optional(),
});

function fallbackPlan(
  targetSkill: string,
  resources: string[],
  weeks: number
): SproutPlan {
  const w = Math.max(1, weeks);
  const tasks: SproutPlan["tasks"] = [];
  let i = 0;
  for (let week = 0; week < w; week++) {
    const base = `week-${week}`;
    tasks.push({
      id: buildId("t", base, String(i++)),
      title: `${targetSkill} — foundation study`,
      type: "lesson",
      minutes: 45,
      weekIndex: week,
      dayOffsetInWeek: 0,
      description: resources[0] ? `Work through: ${resources[0]}` : "Core concepts",
    });
    tasks.push({
      id: buildId("t", base, String(i++)),
      title: `${targetSkill} — practice`,
      type: "lesson",
      minutes: 30,
      weekIndex: week,
      dayOffsetInWeek: 2,
    });
    tasks.push({
      id: buildId("t", base, String(i++)),
      title: `Milestone: ${targetSkill} checkpoint`,
      type: "milestone",
      minutes: 20,
      weekIndex: week,
      dayOffsetInWeek: 5,
    });
  }
  return {
    summary: `A structured path for ${targetSkill} over ${w} week(s) of lessons and milestones.`,
    phases: [
      { name: "Foundations", focus: "Build routine and core skills" },
      { name: "Build", focus: "Deeper practice" },
    ].slice(0, Math.min(2, w)),
    tasks,
    rationale: [
      "Template fallback (no OPENAI_API_KEY): a fixed weekly cadence of 2 lessons + 1 weekly milestone.",
      "Reviews are added automatically by the spaced-repetition scheduler based on the lessons emitted here.",
      "Milestones cap each week to give a tangible check-in; swap for phase-end gates with a real generator.",
    ],
    weeklyShape: { lessons: 2, reviews: 0, milestoneEvery: "week" },
    sessionsPlanned: tasks.length,
  };
}

export async function generatePlanWithAI(input: {
  targetSkill: string;
  deadline: Date;
  startDate: Date;
  initialResources: string[];
  /** Optional: availability summary (design Q3) — included in the LLM prompt. */
  availability?: import("./availability-summary").AvailabilitySummary;
  /** Optional: user's weekly minutes target (design Q4 α). */
  weeklyMinutesTarget?: number | null;
  /** Optional: freeform note (design Q4 δ), pasted verbatim into the prompt. */
  freeformNote?: string | null;
}): Promise<SproutPlan> {
  const days = Math.max(
    1,
    Math.ceil(
      (input.deadline.getTime() - input.startDate.getTime()) / (86400 * 1000)
    )
  );
  const weeks = Math.max(1, Math.ceil(days / 7));

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return fallbackPlan(input.targetSkill, input.initialResources, weeks);
  }

  const openai = new OpenAI({ apiKey: key });
  const userContent = buildSproutPlanUserPrompt({
    targetSkill: input.targetSkill,
    startDate: input.startDate.toISOString().slice(0, 10),
    deadline: input.deadline.toISOString().slice(0, 10),
    weeks,
    initialResources: input.initialResources,
    availability: input.availability,
    weeklyMinutesTarget: input.weeklyMinutesTarget,
    freeformNote: input.freeformNote,
  });

  try {
    const res = await openai.chat.completions.create({
      model: SPROUT_PLAN_MODEL,
      temperature: SPROUT_PLAN_TEMPERATURE,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SPROUT_PLAN_SYSTEM },
        { role: "user", content: userContent },
      ],
    });
    const text = res.choices[0]?.message?.content;
    if (!text) return fallbackPlan(input.targetSkill, input.initialResources, weeks);
    const parsed = planSchema.parse(JSON.parse(text));
    // Defensive: drop any review tasks the LLM emitted despite the prompt.
    // Reviews are owned by FSRS — having the AI place them creates double-booking.
    const nonReviewTasks = parsed.tasks.filter((t) => t.type !== "review");
    return {
      summary: parsed.summary,
      phases: parsed.phases,
      tasks: nonReviewTasks.map((t, i) => {
        const safeTitle =
          t.title ||
          (t.type === "milestone" ? `Milestone ${i + 1}` : `Lesson ${i + 1}`);
        return {
          ...t,
          title: safeTitle,
          id: t.id ?? buildId("t", String(i), safeTitle.slice(0, 8)),
        };
      }),
      rationale: parsed.rationale,
      weeklyShape: parsed.weeklyShape,
      sessionsPlanned: parsed.sessionsPlanned ?? nonReviewTasks.length,
    };
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[generatePlanWithAI] failing back to template:", err);
    }
    return fallbackPlan(input.targetSkill, input.initialResources, weeks);
  }
}

/** Backwards-compatible alias — old call sites use this name. */
export const generateSproutPlan = generatePlanWithAI;

export function supplementalResources(targetSkill: string): string[] {
  return [
    `Search: "${targetSkill} structured course" (video + exercises)`,
    `Communities: Reddit or Discord for ${targetSkill} learners`,
    `Reference docs or official guides for ${targetSkill}`,
  ];
}

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
  /** IANA timezone string from `UserPreference.userTimeZone`. Falls back to UTC. */
  userTimeZone?: string | null;
  /** Plan envelope (passed to the LLM so it doesn't pin past the deadline). */
  planStartDate: Date;
  planDeadline: Date;
}): Promise<InterpretResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, reason: "no-api-key" };

  const tz = args.userTimeZone || "UTC";

  const planView = {
    phases: args.plan.phases.map((p) => ({ name: p.name, focus: p.focus })),
    tasks: args.plan.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      type: t.type as string,
      minutes: t.minutes,
      weekIndex: t.weekIndex,
      priority: t.priority as string | undefined,
    })),
    startDate: args.planStartDate.toISOString(),
    deadline: args.planDeadline.toISOString(),
  };

  const scheduleView = args.schedule
    .filter((s) => new Date(s.start) >= args.now)
    .slice(0, 20)
    .map((s) => {
      const startD = new Date(s.start);
      const endD = new Date(s.end);
      const minutes = Math.max(
        0,
        Math.round((endD.getTime() - startD.getTime()) / 60_000)
      );
      return {
        id: s.id,
        planTaskId: s.planTaskId,
        title: s.title,
        type: s.type as string,
        day: dowShort(startD, tz),
        date: ymdInTz(startD, tz),
        startLocal: hmInTz(startD, tz),
        endLocal: hmInTz(endD, tz),
        minutes,
        startIso: s.start,
        locked: !!s.locked,
        agenda: s.agenda?.map((a) => ({
          planTaskId: a.planTaskId,
          title: a.title,
          type: a.type as string,
          minutes: a.minutes,
        })),
      };
    });

  const userContent = buildEditPlanUserPrompt({
    request: args.request,
    planView,
    scheduleView,
    todayIso: args.now.toISOString(),
    userTimeZone: tz,
    dateGlossary: buildDateGlossary(args.now, tz),
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

// -----------------------------------------------------------------------------
// Timezone-aware date helpers (used to build the LLM's date glossary).
//
// All formatting goes through `Intl.DateTimeFormat` so DST and tz-offset
// arithmetic stay correct. Date math in the local-tz domain is done by
// converting tz-local YMD strings → UTC midnight Dates → offsetting → back to
// YMD strings; this is DST-safe because we never carry a wall-clock time
// across the offset boundary.
// -----------------------------------------------------------------------------

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_TOKEN = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "YYYY-MM-DD" in the given timezone. */
function ymdInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** "HH:mm" (24h) in the given timezone. */
function hmInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** Short weekday name ("Mon") in the given timezone. */
function dowShort(d: Date, tz: string): string {
  // weekday: "short" returns "Mon", "Tue", ... in en-US.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(d);
}

/** Mon=0..Sun=6 weekday index in the given timezone. */
function dowMonZeroInTz(d: Date, tz: string): number {
  const short = dowShort(d, tz);
  const sunZero = DOW_SHORT.indexOf(short); // 0..6 with Sun=0
  return (sunZero + 6) % 7;
}

/** Add `days` to a YMD string (DST-safe; pure date arithmetic). */
function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Day-of-week (Mon=0..Sun=6) of a YMD string read as UTC midnight. */
function dowMonZeroOfYmd(ymd: string): number {
  const d = new Date(`${ymd}T00:00:00Z`);
  // getUTCDay(): Sun=0..Sat=6. Convert to Mon=0..Sun=6.
  return (d.getUTCDay() + 6) % 7;
}

interface DateGlossary {
  today: { date: string; day: string };
  tomorrow: { date: string; day: string };
  yesterday: { date: string; day: string };
  relative: Record<string, string>;
  thisWeek: { from: string; to: string };
  nextWeek: { from: string; to: string };
}

/**
 * Pre-resolve every common relative-date reference (today, tomorrow, "this
 * <Day>", "next <Day>") in the user's timezone. The LLM can then look up
 * dates instead of computing them from `now` + a tz offset.
 *
 * Convention: "this <Day>" = the next occurrence within the current week
 * (Mon-Sun); "next <Day>" = one full week after that. If <Day> equals today,
 * "this <Day>" is today and "next <Day>" is +7.
 */
function buildDateGlossary(now: Date, tz: string): DateGlossary {
  const todayYmd = ymdInTz(now, tz);
  const todayDow = dowMonZeroInTz(now, tz);
  const todayShort = dowShort(now, tz);

  const tomorrowYmd = addDaysYmd(todayYmd, 1);
  const yesterdayYmd = addDaysYmd(todayYmd, -1);

  // Monday of the current week.
  const thisWeekStart = addDaysYmd(todayYmd, -todayDow);
  const thisWeekEnd = addDaysYmd(thisWeekStart, 6);
  const nextWeekStart = addDaysYmd(thisWeekStart, 7);
  const nextWeekEnd = addDaysYmd(nextWeekStart, 6);

  const relative: Record<string, string> = {};
  for (let i = 0; i < 7; i++) {
    const dayName = DOW_TOKEN[(i + 1) % 7]; // Mon..Sun in lowercase
    // "this <Day>" = the occurrence within [thisWeekStart, thisWeekEnd].
    const thisOffset = i - todayDow;
    relative[`this ${dayName}`] = addDaysYmd(
      todayYmd,
      thisOffset >= 0 ? thisOffset : thisOffset + 7
    );
    // "next <Day>" = always +7 from the "this <Day>" anchor.
    relative[`next ${dayName}`] = addDaysYmd(relative[`this ${dayName}`], 7);
  }

  return {
    today: { date: todayYmd, day: todayShort },
    tomorrow: {
      date: tomorrowYmd,
      day: DOW_SHORT[(dowMonZeroOfYmd(tomorrowYmd) + 1) % 7],
    },
    yesterday: {
      date: yesterdayYmd,
      day: DOW_SHORT[(dowMonZeroOfYmd(yesterdayYmd) + 1) % 7],
    },
    relative,
    thisWeek: { from: thisWeekStart, to: thisWeekEnd },
    nextWeek: { from: nextWeekStart, to: nextWeekEnd },
  };
}

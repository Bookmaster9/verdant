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

/**
 * `.passthrough()` on the leaf objects so unknown keys the LLM occasionally
 * adds (e.g. a "note" field) don't fail the parse — they're just ignored.
 * Optional fields stay optional; required ones still throw.
 */

/**
 * Ref strings the LLM emits in place of real ids. `#S<n>` references the n-th
 * entry in `scheduleView` (1-indexed); `#T<n>` references the n-th entry in
 * `planView.tasks`. The schemas validate the LLM's raw output; a separate
 * resolution pass (`resolveRefs`) replaces them with real ids before the
 * applier runs.
 */
const sessionRef = z.string().regex(/^#S\d+$/);
const taskRef = z.string().regex(/^#T\d+$/);
const taskRefList = z.preprocess((v) => {
  if (typeof v === "string") return [v];
  return v;
}, z.array(taskRef));

const llmRuleFilterSchema = z
  .object({
    type: taskTypeSchema.optional(),
    dayOfWeek: dayOfWeekListSchema.optional(),
    weekIndex: z.number().int().min(0).max(60).optional(),
    phaseIndex: z.number().int().min(0).max(20).optional(),
    priority: prioritySchema.optional(),
    taskIds: taskRefList.optional(),
  })
  .passthrough();

export const editOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("extend_task"),
    taskId: taskRef,
    addMinutes: z.number().int().min(-90).max(90),
  }),
  z.object({
    op: z.literal("insert_task"),
    afterTaskId: taskRef,
    title: z.string().min(1).max(200),
    type: taskTypeSchema,
    minutes: z.number().int().min(15).max(90),
    priority: prioritySchema.default("core"),
  }),
  z.object({
    op: z.literal("remove_task"),
    taskId: taskRef,
  }),
  z.object({
    op: z.literal("set_priority"),
    taskId: taskRef,
    priority: prioritySchema,
  }),
]);

/**
 * LLM output schema (ref-shaped). After interpretEdit resolves refs to real
 * ids, the result conforms to `placementRuleSchema` below for downstream code.
 */
const llmPlacementRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prefer"),
      filter: llmRuleFilterSchema.optional().default({}),
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
      filter: llmRuleFilterSchema.optional().default({}),
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
      sessionId: sessionRef,
      to: z
        .object({
          date: yyyymmdd,
          time: z
            .string()
            .regex(/^\d{2}:\d{2}$/)
            .optional(),
        })
        .passthrough(),
      titleHint: z.string().max(200).optional(),
    })
    .passthrough(),
]);

/**
 * Storage / settings-UI schema. Same shape but accepts real ids (cuids) and
 * a final ISO `start` on pin rules. Persisted rules never carry `pin`, but
 * the schema permits all three kinds for completeness.
 */
const storageRuleFilterSchema = z
  .object({
    type: taskTypeSchema.optional(),
    dayOfWeek: dayOfWeekListSchema.optional(),
    weekIndex: z.number().int().min(0).max(60).optional(),
    phaseIndex: z.number().int().min(0).max(20).optional(),
    priority: prioritySchema.optional(),
    taskIds: z
      .preprocess(
        (v) => (typeof v === "string" ? [v] : v),
        z.array(z.string())
      )
      .optional(),
  })
  .passthrough();

export const placementRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prefer"),
      filter: storageRuleFilterSchema.optional().default({}),
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
      filter: storageRuleFilterSchema.optional().default({}),
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

const llmResponseSchema = z.object({
  ops: z.array(editOpSchema).max(20).default([]),
  rules: z.array(llmPlacementRuleSchema).max(20).default([]),
  summary: z.string().max(400),
});

/**
 * One audit entry per LLM-emitted op or rule that we *couldn't* apply during
 * resolution (bad ref, title mismatch). Surfaced through the API response so
 * the UI can show "couldn't apply: …" instead of pretending success.
 */
export interface ResolutionDrop {
  kind: EditOp["op"] | "prefer" | "forbid" | "pin";
  reason: string;
  ref?: string;
}

export type InterpretResult =
  | {
      ok: true;
      ops: EditOp[];
      rules: z.infer<typeof placementRuleSchema>[];
      summary: string;
      /** Refs the LLM emitted that we couldn't resolve. */
      drops: ResolutionDrop[];
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

  // Plan-task view: every task in `planJson` gets a `#T<n>` ref. The LLM
  // references tasks by ref; the server resolves to real ids before applying.
  const planTasksWithRefs = args.plan.tasks.map((t, i) => ({
    ref: `#T${i + 1}`,
    id: t.id,
    title: t.title,
    type: t.type as string,
    minutes: t.minutes,
    weekIndex: t.weekIndex,
    priority: t.priority as string | undefined,
  }));
  const taskRefToId = new Map<string, string>(
    planTasksWithRefs.map((t) => [t.ref, t.id])
  );
  const taskRefToTitle = new Map<string, string>(
    planTasksWithRefs.map((t) => [t.ref, t.title])
  );

  const planView = {
    phases: args.plan.phases.map((p) => ({ name: p.name, focus: p.focus })),
    tasks: planTasksWithRefs.map((t) => ({
      ref: t.ref,
      title: t.title,
      type: t.type,
      minutes: t.minutes,
      weekIndex: t.weekIndex,
      priority: t.priority,
    })),
    startDate: args.planStartDate.toISOString(),
    deadline: args.planDeadline.toISOString(),
  };

  // Future-only schedule, capped at 20 entries, each with a `#S<n>` ref.
  const futureSchedule = args.schedule.filter(
    (s) => new Date(s.start) >= args.now
  );
  const sessionRefData = futureSchedule.slice(0, 20).map((s, i) => {
    const startD = new Date(s.start);
    const endD = new Date(s.end);
    const minutes = Math.max(
      0,
      Math.round((endD.getTime() - startD.getTime()) / 60_000)
    );
    return {
      ref: `#S${i + 1}`,
      session: s,
      startD,
      endD,
      minutes,
    };
  });
  const sessionRefToId = new Map<string, string>(
    sessionRefData.map((d) => [d.ref, d.session.id])
  );
  const sessionRefToTitle = new Map<string, string>(
    sessionRefData.map((d) => [d.ref, d.session.title])
  );
  const sessionRefToOriginal = new Map<string, ScheduledSession>(
    sessionRefData.map((d) => [d.ref, d.session])
  );

  const scheduleView = sessionRefData.map(
    ({ ref, session: s, startD, endD, minutes }) => ({
      ref,
      planTaskId: s.planTaskId,
      title: s.title,
      type: s.type as string,
      day: dowShort(startD, tz),
      date: ymdInTz(startD, tz),
      startLocal: hmInTz(startD, tz),
      endLocal: hmInTz(endD, tz),
      minutes,
      locked: !!s.locked,
      agenda: s.agenda?.map((a) => ({
        planTaskId: a.planTaskId,
        title: a.title,
        type: a.type as string,
        minutes: a.minutes,
      })),
    })
  );

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
    const parsed = llmResponseSchema.parse(JSON.parse(rawText));
    if (process.env.NODE_ENV !== "production") {
      console.log(
        "[interpretEdit] raw LLM output:",
        JSON.stringify({
          ops: parsed.ops,
          rules: parsed.rules,
          summary: parsed.summary,
        })
      );
    }
    if (parsed.ops.length === 0 && parsed.rules.length === 0) {
      return { ok: false, reason: parsed.summary || "no-ops-or-rules" };
    }
    const resolved = resolveRefs({
      ops: parsed.ops,
      rules: parsed.rules,
      taskRefToId,
      taskRefToTitle,
      sessionRefToId,
      sessionRefToTitle,
      sessionRefToOriginal,
      tz,
    });
    if (process.env.NODE_ENV !== "production" && resolved.drops.length > 0) {
      console.warn(
        "[interpretEdit] resolution drops:",
        JSON.stringify(resolved.drops)
      );
    }
    return {
      ok: true,
      ops: resolved.ops,
      rules: resolved.rules,
      summary: parsed.summary,
      drops: resolved.drops,
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
// Ref resolution: replace LLM-emitted #T<n> / #S<n> with real ids, validate
// titleHints, and translate `to: { date, time? }` into a tz-correct ISO start.
// Bad refs and title mismatches are dropped (per-op atomicity) and reported.
// -----------------------------------------------------------------------------

type LlmRule = z.infer<typeof llmPlacementRuleSchema>;
type StoreRule = z.infer<typeof placementRuleSchema>;

function fuzzyTitleMatch(actual: string, hint: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = norm(actual);
  const h = norm(hint);
  if (!h) return true;
  if (a.includes(h) || h.includes(a)) return true;
  // Token overlap: any 2 of the hint's tokens appear in the actual title.
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const hTokens = h.split(" ").filter(Boolean);
  const matches = hTokens.filter((t) => aTokens.has(t)).length;
  return matches >= 2 || (hTokens.length <= 2 && matches >= 1);
}

/**
 * Convert a tz-local "HH:mm" + "YYYY-MM-DD" into a UTC ISO string. We compute
 * the timezone offset for that instant via `Intl.DateTimeFormat` so DST
 * transitions land on the correct side. The trick: format the candidate UTC
 * Date in the target tz and read back its wall-clock fields, then adjust.
 */
function localWallClockToIso(
  date: string,
  time: string,
  tz: string
): string | null {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  if (![y, mo, d, h, mi].every(Number.isFinite)) return null;
  // Construct a Date assuming UTC, then probe what wall-clock the tz reports
  // for that instant; the difference is the offset to subtract.
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const partsFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = partsFmt.formatToParts(new Date(utcGuess));
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  const tzWallMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    0
  );
  const offsetMs = tzWallMs - utcGuess;
  const finalUtc = utcGuess - offsetMs;
  return new Date(finalUtc).toISOString();
}

interface ResolveArgs {
  ops: EditOp[];
  rules: LlmRule[];
  taskRefToId: Map<string, string>;
  taskRefToTitle: Map<string, string>;
  sessionRefToId: Map<string, string>;
  sessionRefToTitle: Map<string, string>;
  sessionRefToOriginal: Map<string, ScheduledSession>;
  tz: string;
}

interface ResolveResult {
  ops: EditOp[];
  rules: StoreRule[];
  drops: ResolutionDrop[];
}

function resolveRefs(args: ResolveArgs): ResolveResult {
  const drops: ResolutionDrop[] = [];
  const resolvedOps: EditOp[] = [];
  const resolvedRules: StoreRule[] = [];

  // Helper: resolve one task ref. Returns the real id or null (with drop).
  function lookupTask(
    ref: string,
    kind: ResolutionDrop["kind"]
  ): string | null {
    const id = args.taskRefToId.get(ref);
    if (!id) {
      drops.push({
        kind,
        ref,
        reason: `task ref ${ref} not in plan view`,
      });
      return null;
    }
    return id;
  }

  for (const op of args.ops) {
    switch (op.op) {
      case "extend_task": {
        const id = lookupTask(op.taskId, "extend_task");
        if (id) resolvedOps.push({ ...op, taskId: id });
        break;
      }
      case "insert_task": {
        const id = lookupTask(op.afterTaskId, "insert_task");
        if (id) resolvedOps.push({ ...op, afterTaskId: id });
        break;
      }
      case "remove_task": {
        const id = lookupTask(op.taskId, "remove_task");
        if (id) resolvedOps.push({ ...op, taskId: id });
        break;
      }
      case "set_priority": {
        const id = lookupTask(op.taskId, "set_priority");
        if (id) resolvedOps.push({ ...op, taskId: id });
        break;
      }
    }
  }

  for (const rule of args.rules) {
    if (rule.kind === "pin") {
      const sessionId = args.sessionRefToId.get(rule.sessionId);
      if (!sessionId) {
        drops.push({
          kind: "pin",
          ref: rule.sessionId,
          reason: `session ref ${rule.sessionId} not in schedule view`,
        });
        continue;
      }
      const actualTitle = args.sessionRefToTitle.get(rule.sessionId) ?? "";
      if (rule.titleHint && !fuzzyTitleMatch(actualTitle, rule.titleHint)) {
        drops.push({
          kind: "pin",
          ref: rule.sessionId,
          reason: `titleHint "${rule.titleHint}" does not match session title "${actualTitle}"`,
        });
        continue;
      }
      const original = args.sessionRefToOriginal.get(rule.sessionId);
      if (!original) {
        drops.push({
          kind: "pin",
          ref: rule.sessionId,
          reason: "internal: session not found in resolution map",
        });
        continue;
      }
      const time =
        rule.to.time ??
        hmInTz(new Date(original.start), args.tz);
      const iso = localWallClockToIso(rule.to.date, time, args.tz);
      if (!iso) {
        drops.push({
          kind: "pin",
          ref: rule.sessionId,
          reason: `couldn't construct ISO from date=${rule.to.date} time=${time}`,
        });
        continue;
      }
      resolvedRules.push({
        kind: "pin",
        sessionId,
        start: iso,
      });
      continue;
    }
    // prefer / forbid: resolve any taskIds in the filter to real ids.
    const filter = rule.filter;
    if (filter.taskIds && filter.taskIds.length > 0) {
      const resolved: string[] = [];
      let allOk = true;
      for (const ref of filter.taskIds) {
        const id = args.taskRefToId.get(ref);
        if (!id) {
          drops.push({
            kind: rule.kind,
            ref,
            reason: `task ref ${ref} (in ${rule.kind}.filter.taskIds) not in plan view`,
          });
          allOk = false;
          break;
        }
        resolved.push(id);
      }
      if (!allOk) continue;
      const newFilter = { ...filter, taskIds: resolved };
      if (rule.kind === "prefer") {
        resolvedRules.push({
          kind: "prefer",
          filter: newFilter,
          target: rule.target,
        });
      } else {
        resolvedRules.push({
          kind: "forbid",
          filter: newFilter,
          window: rule.window,
        });
      }
      continue;
    }
    // No taskIds to resolve — pass through directly.
    if (rule.kind === "prefer") {
      resolvedRules.push({
        kind: "prefer",
        filter: filter,
        target: rule.target,
      });
    } else {
      resolvedRules.push({
        kind: "forbid",
        filter: filter,
        window: rule.window,
      });
    }
  }

  return { ops: resolvedOps, rules: resolvedRules, drops };
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

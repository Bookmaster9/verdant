/**
 * Prompt for the NL plan editor (design Q-edit-llm).
 *
 * The model translates a learner's request into TWO arrays:
 *   - `ops`: imperative mutations to plan tasks (extend / insert / remove /
 *     set-priority). The applier mutates `planJson` and the packer reflows.
 *   - `rules`: declarative placement intent (prefer / forbid / pin) that the
 *     packer consumes directly. The model NEVER picks specific times — only
 *     `pin` references an exact time, and only when the learner asked for one
 *     specific session by id.
 *
 * The model sees a compact `planView` (phase + task metadata) and a trimmed
 * `scheduleView` (the next ~20 sessions). The schedule view exists almost
 * entirely so the model can fill in `pin.sessionId` when needed.
 */

export const EDIT_PLAN_MODEL = "gpt-4o-mini";
export const EDIT_PLAN_TEMPERATURE = 0.2;

export const EDIT_PLAN_SYSTEM = `You translate a learner's natural-language request about their study plan into a structured edit.

Output ONE JSON object with this exact shape:
{ "ops": Op[], "rules": Rule[], "summary": string }

You emit two kinds of intent. **Decide based on the GRAMMAR of the user's request:**

(1) ops + pin — IMPERATIVE intent. The user is telling you to do a specific, concrete thing once.
    Markers: "move", "swap", "extend", "drop", "add", "shift this to X". A specific session is named.
    - Use ops (extend_task / insert_task / remove_task / set_priority) when changing TASK PROPERTIES.
    - Use a "pin" rule when the user wants ONE specific session moved to ONE specific time AND
      the session id is visible in the schedule view. Pin is one-shot — it does not change future
      scheduling.

(2) prefer + forbid — DECLARATIVE intent. The user is stating a preference that should persist.
    Markers: "I prefer", "I like", "always", "instead of", "in general", "from now on".
    - Use "prefer" (soft pull) for "I like reviews in the morning".
    - Use "forbid" (hard exclusion) for "no studying on Sundays" or "never schedule before 7am".
    - The classic "I prefer X **instead of** Y" pattern produces BOTH a prefer (toward X) and a
      forbid (against Y), so the user's escape route is closed even when learned-utility data
      pulls back toward Y.

Why the distinction matters: imperative ops/pins move existing sessions immediately. Declarative
rules persist on the plan and bias every future packer run; existing sessions are NOT auto-moved
by them. Pick the one that matches what the user said. When in doubt and the user used a
declarative phrase ("I prefer", "I like"), prefer rules over ops.

Rule kinds in detail:
  - "prefer" (soft): pull matching tasks toward a target placement.
  - "forbid" (hard): block matching slots; window must include at least dayOfWeek, date, or dateRange.
  - "pin" (hard): lock a specific session to a specific time. Only emit pin when the user names a session and an exact time, AND the session id appears in the schedule view.

You NEVER pick start times. The "start" field in a pin rule is the only place an exact time may appear.

Time-of-day enum: "morning" (before noon), "afternoon" (noon–5pm), "evening" (after 5pm), "any".
Day-of-week tokens (lowercase): "mon" "tue" "wed" "thu" "fri" "sat" "sun".
dayOfWeek is always an ARRAY of tokens, even when there's only one.

**Identifier scheme — REFS, NOT IDS.** You NEVER emit raw cuid-style ids. You emit:
  - "#S<n>" to reference the n-th entry in the schedule view (e.g. "#S3").
  - "#T<n>" to reference the n-th entry in planView.tasks (e.g. "#T7").
The server resolves the ref to the real id before applying. If you reference a number that
isn't in the view, the corresponding op/rule is dropped with a clear error to the user — so
double-check that the ref matches what you intend.

**Resolving relative dates.** The user often says "tomorrow", "this Friday", "next Thursday".
The user prompt always contains a "Date glossary" block with PRE-RESOLVED dates in the user's
timezone. Use those values verbatim — do NOT re-derive dates yourself. If you need a date that
isn't in the glossary, fall back to the schedule view's "date" field on the matching session.

**Identifying the target session.** Each entry in the schedule view has wall-clock fields
("day", "date", "startLocal", "endLocal", "minutes", "type") in the user's timezone. Use those
to match natural-language references like "this Friday's review" or "tomorrow morning's lesson".
For sessions that bundle several tasks, the "agenda" field lists every constituent task with
its planTaskId.

**Emitting a pin.** Pin shape: { kind: "pin", sessionId: "#S<n>", to: { date: "YYYY-MM-DD", time?: "HH:mm" }, titleHint?: string }.
  - "sessionId" is the ref of the session being moved (e.g. "#S3").
  - "to.date" is the target date (use the glossary).
  - "to.time" is OPTIONAL. Omit it to keep the original session's local time —
    correct for "move my Monday lesson to Thursday" (no time was specified).
    Include it as "HH:mm" (24h, user-local) only when the user names a specific time.
  - "titleHint" SHOULD be a short snippet of the session title you're targeting,
    e.g. "Intro to FSRS". The server fuzzy-matches it against the resolved session;
    if your ref points at a different title than your hint, the pin is dropped with
    a "ref/title mismatch" error. Always set titleHint when you can — it's the
    cheapest insurance against picking the wrong number.

Examples (these are illustrative — copy the SHAPE, not the specific ids):

Example A. User says: "extend the intro lesson by 30 minutes" (assume planView shows "Intro" at #T1)
Output: { "ops": [ { "op": "extend_task", "taskId": "#T1", "addMinutes": 30 } ], "rules": [], "summary": "extended that lesson by 30 minutes" }

Example B. User says: "reschedule my Thursday reviews to Friday mornings"
Output: { "ops": [], "rules": [
  { "kind": "forbid", "filter": { "type": "review" }, "window": { "dayOfWeek": ["thu"] } },
  { "kind": "prefer", "filter": { "type": "review" }, "target": { "dayOfWeek": ["fri"], "timeOfDay": "morning" } }
], "summary": "moved reviews off Thursdays toward Friday mornings" }

Example C. User says: "no studying on Sundays"
Output: { "ops": [], "rules": [ { "kind": "forbid", "filter": {}, "window": { "dayOfWeek": ["sun"] } } ], "summary": "Sundays are off-limits now" }

Example D. User says: "blackout from December 23 to January 2"
Output: { "ops": [], "rules": [ { "kind": "forbid", "filter": {}, "window": { "dateRange": { "from": "2026-12-23", "to": "2027-01-02" } } } ], "summary": "blocked off Dec 23 through Jan 2" }

Example E. User says: "drop the second milestone" (assume planView shows the milestone at #T8)
Output: { "ops": [ { "op": "remove_task", "taskId": "#T8" } ], "rules": [], "summary": "removed that milestone" }

Example F. User says: "move my Monday lesson to Thursday" (assume scheduleView's #S2 is the Monday lesson titled "Intro to FSRS", glossary.relative["this thu"] = "2026-05-15")
Output: { "ops": [], "rules": [
  { "kind": "pin", "sessionId": "#S2", "to": { "date": "2026-05-15" }, "titleHint": "Intro to FSRS" }
], "summary": "moved the Monday lesson to Thursday at the same time" }

Example G. User says: "move this Friday's review to Monday at 8am" (assume #S5 is Friday's review titled "Review: trees", glossary.relative["this mon"] = "2026-05-12")
Output: { "ops": [], "rules": [
  { "kind": "pin", "sessionId": "#S5", "to": { "date": "2026-05-12", "time": "08:00" }, "titleHint": "Review: trees" }
], "summary": "moved that review to Monday 8am" }

Example H. User says: "I prefer reviews on Friday morning instead of Saturday night" (DECLARATIVE)
Output: { "ops": [], "rules": [
  { "kind": "prefer", "filter": { "type": "review" }, "target": { "dayOfWeek": ["fri"], "timeOfDay": "morning" } },
  { "kind": "forbid", "filter": { "type": "review" }, "window": { "dayOfWeek": ["sat"] } }
], "summary": "reviews lean toward Friday mornings, off Saturday nights" }

Constraints:
- Both "ops" and "rules" must be arrays. Either may be empty, but you should usually emit at least one when the request is concrete.
- Only reference ids that appear in the plan view or schedule view.
- "summary" is a short, plain-prose confirmation, lowercased preferred.
- If the request truly cannot be expressed (e.g. "make it more fun"), return { "ops": [], "rules": [], "summary": "I can't do that — try rephrasing." }.
- Reviews must still come after the lessons they reinforce — don't break that.

Output ONLY the JSON object. No markdown, no code fences, no commentary.`;

export interface EditPlanPromptInput {
  request: string;
  /** Compact view of the plan: phases + tasks. Each task has a `#T<n>` ref. */
  planView: {
    phases: { name: string; focus: string }[];
    tasks: {
      ref: string;
      title: string;
      type: string;
      minutes: number;
      weekIndex: number;
      priority?: string;
    }[];
    /** Plan envelope (ISO) so the LLM doesn't propose pins past the deadline. */
    startDate: string;
    deadline: string;
  };
  /**
   * Compact view of upcoming sessions. Each entry has a `#S<n>` ref + wall-clock
   * fields in the user's timezone. Bundled sessions expose every constituent
   * task via `agenda` so multi-task blocks don't hide behind their first entry.
   * The LLM emits the `ref` value (not an id) when targeting a session.
   */
  scheduleView: {
    ref: string;
    planTaskId: string;
    title: string;
    type: string;
    day: string;
    date: string;
    startLocal: string;
    endLocal: string;
    minutes: number;
    locked: boolean;
    agenda?: {
      planTaskId: string;
      title: string;
      type: string;
      minutes: number;
    }[];
  }[];
  /** Today (ISO) in the user's timezone — also encoded inside `dateGlossary`. */
  todayIso: string;
  /** IANA timezone name, e.g. "America/New_York". */
  userTimeZone: string;
  /**
   * Pre-resolved relative-date glossary. Computed in the user's timezone so
   * the LLM never has to do tz-aware date arithmetic itself. `relative` keys
   * are the most-common reschedule references — extend this list rather than
   * asking the model to compute new ones.
   */
  dateGlossary: {
    today: { date: string; day: string };
    tomorrow: { date: string; day: string };
    yesterday: { date: string; day: string };
    /** Keys: "this <Day>" / "next <Day>" → "YYYY-MM-DD". */
    relative: Record<string, string>;
    /** Inclusive 7-day window starting Monday of the current week. */
    thisWeek: { from: string; to: string };
    nextWeek: { from: string; to: string };
  };
}

const OPS_GRAMMAR = [
  {
    op: "extend_task",
    taskId: '"#T<n>" — task ref from planView',
    addMinutes:
      "integer (positive to lengthen, negative to shorten; final minutes clamped to [15, 90])",
  },
  {
    op: "insert_task",
    afterTaskId: '"#T<n>" — task ref the new task should follow',
    title: "string",
    type: '"lesson" | "review" | "milestone"',
    minutes: "integer in [15, 90]",
    priority: '"core" | "stretch"',
  },
  {
    op: "remove_task",
    taskId: '"#T<n>" — task ref from planView',
  },
  {
    op: "set_priority",
    taskId: '"#T<n>" — task ref from planView',
    priority: '"core" | "stretch"',
  },
];

const RULES_GRAMMAR = [
  {
    kind: "prefer",
    filter:
      '{ type?: "lesson"|"review"|"milestone"; dayOfWeek?: Dow[]; weekIndex?: int; phaseIndex?: int; priority?: "core"|"stretch"; taskIds?: ["#T<n>", ...] }',
    target:
      '{ dayOfWeek?: Dow[]; timeOfDay?: "morning"|"afternoon"|"evening"|"any"; weekIndex?: int }',
    note: "Soft pull. Use for 'I prefer X on Fridays', 'mornings work better for reviews'.",
  },
  {
    kind: "forbid",
    filter:
      '{ type?, dayOfWeek?, weekIndex?, phaseIndex?, priority?, taskIds?: ["#T<n>", ...] } (same shape as prefer)',
    window:
      '{ dayOfWeek?: Dow[]; date?: "YYYY-MM-DD"; dateRange?: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" } }',
    note: "Hard exclusion. Use for 'no scheduling on Sundays', 'blackout Dec 23-Jan 2'. At least one window dimension must be set.",
  },
  {
    kind: "pin",
    sessionId: '"#S<n>" — session ref from scheduleView',
    to: '{ date: "YYYY-MM-DD"; time?: "HH:mm" } — destination; omit time to preserve the session\'s original local start time',
    titleHint:
      "string (RECOMMENDED) — short snippet of the session title you intend to move; server validates against the resolved session",
    note: "Move one specific session to a new day (and optionally a new time). Use when the learner names a session.",
  },
];

export function buildEditPlanUserPrompt(input: EditPlanPromptInput): string {
  return [
    `Today: ${input.todayIso}  (timezone: ${input.userTimeZone})`,
    ``,
    `Date glossary — use these EXACT values when the user mentions relative dates:`,
    JSON.stringify(input.dateGlossary, null, 2),
    ``,
    `User request:`,
    `"""`,
    input.request,
    `"""`,
    ``,
    `Plan view (envelope + every task; "minutes" is the task duration):`,
    JSON.stringify(input.planView, null, 2),
    ``,
    `Upcoming sessions (next ~20). Wall-clock fields are in the user's timezone;`,
    `"startIso" is the only field you should copy into a pin's "start".`,
    JSON.stringify(input.scheduleView.slice(0, 20), null, 2),
    ``,
    `Allowed ops (imperative mutations to planJson):`,
    JSON.stringify(OPS_GRAMMAR, null, 2),
    ``,
    `Allowed rules (declarative placement intent for the scheduler):`,
    JSON.stringify(RULES_GRAMMAR, null, 2),
    ``,
    `Dow = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun".`,
    ``,
    `Return JSON of this exact shape: { "ops": [...], "rules": [...], "summary": "..." }`,
  ].join("\n");
}

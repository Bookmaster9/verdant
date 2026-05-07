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

**Resolving relative dates.** The user often says "tomorrow", "this Friday", "next Thursday".
The user prompt always contains a "Date glossary" block with PRE-RESOLVED dates in the user's
timezone. Use those values verbatim — do NOT re-derive dates yourself. If you need a date that
isn't in the glossary, fall back to the schedule view's "date" field on the matching session.

**Identifying the target session.** Each entry in the schedule view has wall-clock fields
("day", "date", "startLocal", "endLocal", "minutes", "type") in the user's timezone. Use those
to match natural-language references like "this Friday's review" or "tomorrow morning's lesson".
For sessions that bundle several tasks, the "agenda" field lists every constituent task with
its planTaskId — use those ids when the user names a specific task inside a bundle.

**Emitting a pin.** The pin "start" must be an ISO 8601 string. The cheapest correct value is
the session's "startIso" field with the date portion swapped to a date from the glossary. The
existing "startIso" carries the correct timezone offset; preserve everything except the YYYY-MM-DD
prefix when shifting to a new day. Example: existing startIso "2026-05-09T19:00:00-04:00",
moving to tomorrow whose glossary date is "2026-05-08" → "2026-05-08T19:00:00-04:00".

Examples (these are illustrative — copy the SHAPE, not the specific ids):

Example A. User says: "extend the intro lesson by 30 minutes"
Output: { "ops": [ { "op": "extend_task", "taskId": "<id from plan view>", "addMinutes": 30 } ], "rules": [], "summary": "extended that lesson by 30 minutes" }

Example B. User says: "reschedule my Thursday reviews to Friday mornings"
Output: { "ops": [], "rules": [
  { "kind": "forbid", "filter": { "type": "review" }, "window": { "dayOfWeek": ["thu"] } },
  { "kind": "prefer", "filter": { "type": "review" }, "target": { "dayOfWeek": ["fri"], "timeOfDay": "morning" } }
], "summary": "moved reviews off Thursdays toward Friday mornings" }

Example C. User says: "no studying on Sundays"
Output: { "ops": [], "rules": [ { "kind": "forbid", "filter": {}, "window": { "dayOfWeek": ["sun"] } } ], "summary": "Sundays are off-limits now" }

Example D. User says: "blackout from December 23 to January 2"
Output: { "ops": [], "rules": [ { "kind": "forbid", "filter": {}, "window": { "dateRange": { "from": "2026-12-23", "to": "2027-01-02" } } } ], "summary": "blocked off Dec 23 through Jan 2" }

Example E. User says: "drop the second milestone"
Output: { "ops": [ { "op": "remove_task", "taskId": "<id from plan view>" } ], "rules": [], "summary": "removed that milestone" }

Example F. User says: "move this Friday's review to Monday at 8am" (IMPERATIVE — names a session and time)
Output: { "ops": [], "rules": [
  { "kind": "pin", "sessionId": "<id from schedule view>", "start": "2026-05-12T08:00:00.000Z" }
], "summary": "moved that review to Monday 8am" }

Example G. User says: "I prefer reviews on Friday morning instead of Saturday night" (DECLARATIVE)
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
  /** Compact view of the plan: phases + tasks. */
  planView: {
    phases: { name: string; focus: string }[];
    tasks: {
      id: string;
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
   * Compact view of upcoming sessions. Each entry has both wall-clock fields
   * (day, date, startLocal, endLocal, minutes) and ISO start for `pin`. The
   * wall-clock fields make "this Friday's review" trivially findable. Bundled
   * sessions expose every constituent task via `agenda` so multi-task blocks
   * don't hide behind their first entry.
   */
  scheduleView: {
    id: string;
    planTaskId: string;
    title: string;
    type: string;
    /** "Mon" | "Tue" | ... in the user's timezone. */
    day: string;
    /** "YYYY-MM-DD" in the user's timezone. */
    date: string;
    /** "HH:mm" in the user's timezone. */
    startLocal: string;
    /** "HH:mm" in the user's timezone. */
    endLocal: string;
    minutes: number;
    /** ISO start with offset — emit pins anchored on this. */
    startIso: string;
    locked: boolean;
    /**
     * For sessions bundling multiple tasks, the per-task list. Single-task
     * sessions omit this field. The outer `planTaskId` is still the first
     * task's id for backwards compatibility.
     */
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
    taskId: "string",
    addMinutes:
      "integer (positive to lengthen, negative to shorten; final minutes clamped to [15, 90])",
  },
  {
    op: "insert_task",
    afterTaskId: "string — id the new task should follow",
    title: "string",
    type: '"lesson" | "review" | "milestone"',
    minutes: "integer in [15, 90]",
    priority: '"core" | "stretch"',
  },
  {
    op: "remove_task",
    taskId: "string",
  },
  {
    op: "set_priority",
    taskId: "string",
    priority: '"core" | "stretch"',
  },
];

const RULES_GRAMMAR = [
  {
    kind: "prefer",
    filter:
      '{ type?: "lesson"|"review"|"milestone"; dayOfWeek?: Dow[]; weekIndex?: int; phaseIndex?: int; priority?: "core"|"stretch"; taskIds?: string[] }',
    target:
      '{ dayOfWeek?: Dow[]; timeOfDay?: "morning"|"afternoon"|"evening"|"any"; weekIndex?: int }',
    note: "Soft pull. Use for 'I prefer X on Fridays', 'mornings work better for reviews'.",
  },
  {
    kind: "forbid",
    filter:
      '{ type?, dayOfWeek?, weekIndex?, phaseIndex?, priority?, taskIds? } (same shape as prefer)',
    window:
      '{ dayOfWeek?: Dow[]; date?: "YYYY-MM-DD"; dateRange?: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" } }',
    note: "Hard exclusion. Use for 'no scheduling on Sundays', 'blackout Dec 23-Jan 2'. At least one window dimension must be set.",
  },
  {
    kind: "pin",
    sessionId: "string — must come from the schedule view",
    start: "ISO 8601 string (the only place you may emit an exact time)",
    note: "Lock one specific session to one specific time. Use when the learner names a session and a time.",
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

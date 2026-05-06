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

You emit two kinds of intent:

(1) ops — imperative mutations to plan tasks. The app applies them and reflows the schedule.
    Use these when the user changes a TASK'S PROPERTIES or adds/removes a task.
    Allowed: extend_task, insert_task, remove_task, set_priority.

(2) rules — declarative placement intent. The scheduler reads them and picks the times.
    Use these when the user wants things placed DIFFERENTLY in time (different day, time of day, blackout, etc.).
    Allowed kinds:
      - "prefer" (soft): pull matching tasks toward a target placement.
      - "forbid" (hard): block matching slots; window must include at least dayOfWeek, date, or dateRange.
      - "pin" (hard): lock a specific session to a specific time. Only emit pin when the user names a session and an exact time, AND the session id appears in the schedule view.

You NEVER pick start times. The "start" field in a pin rule is the only place an exact time may appear.

Time-of-day enum: "morning" (before noon), "afternoon" (noon–5pm), "evening" (after 5pm), "any".
Day-of-week tokens (lowercase): "mon" "tue" "wed" "thu" "fri" "sat" "sun".
dayOfWeek is always an ARRAY of tokens, even when there's only one.

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

Constraints:
- Both "ops" and "rules" must be arrays. Either may be empty, but you should usually emit at least one when the request is concrete.
- Only reference ids that appear in the plan view or schedule view.
- "summary" is a short, plain-prose confirmation, lowercased preferred.
- If the request truly cannot be expressed (e.g. "make it more fun"), return { "ops": [], "rules": [], "summary": "I can't do that — try rephrasing." }.
- Reviews must still come after the lessons they reinforce — don't break that.

Output ONLY the JSON object. No markdown, no code fences, no commentary.`;

export interface EditPlanPromptInput {
  request: string;
  /** Compact view of the plan: phases + tasks (id, title, type, weekIndex, priority). */
  planView: {
    phases: { name: string; focus: string }[];
    tasks: {
      id: string;
      title: string;
      type: string;
      weekIndex: number;
      priority?: string;
    }[];
  };
  /** Compact view of upcoming sessions: id, taskId, start ISO, locked flag. Used mainly for `pin`. */
  scheduleView: {
    id: string;
    planTaskId: string;
    title: string;
    start: string;
    locked: boolean;
  }[];
  todayIso: string;
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
    `Today: ${input.todayIso}`,
    ``,
    `User request:`,
    `"""`,
    input.request,
    `"""`,
    ``,
    `Plan view:`,
    JSON.stringify(input.planView, null, 2),
    ``,
    `Upcoming sessions (next ~20, used mainly for "pin"):`,
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

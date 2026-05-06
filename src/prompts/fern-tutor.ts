/**
 * Prompts for Fern as a per-lesson tutor — used by:
 *   - the chat panel in column 3 of the session detail page (multi-turn chat,
 *     with a sliding 3-turn window persisted in TaskJournal.chatJson)
 *   - the "Ask Fern to expand" preset cards in the same column (session-only,
 *     not persisted)
 *
 * Both paths share `buildLessonContext()` so Fern always knows the same things
 * about the lesson the user is on. Only the *instruction* changes.
 *
 * Edit the strings below to retune Fern's voice.
 */

import type { PlanTask } from "@/types/plan";

export const FERN_TUTOR_MODEL = "gpt-4o-mini";
export const FERN_TUTOR_TEMPERATURE = 0.7;

export const FERN_TUTOR_SYSTEM = `You are Fern — a small forest spirit who tutors learners through Verdant, a calendar-based self-learning app.

Voice rules:
- Lowercase. Warm. Brief. Sentences are short.
- Sometimes notice things in nature ("like a sapling reaching past a stone") — sparingly, never twee.
- No bullet headers like "Pros:" or "Cons:". Write like you're writing in a journal beside the learner.
- No emoji. No exclamation marks unless the learner is celebrating.
- Default cap: ~180 words. Only go longer if the learner explicitly asks for a long form (e.g. "build me a full lesson plan").
- Match the subject. If they're learning programming, talk like a coding mentor. If physical, talk like a coach. If language, like a tutor. Don't drag breakdancing or wrist-warmups into a chemistry lesson.
- When you're not sure, say so plainly. Don't bluff specifics.

Time budget — non-negotiable:
- The session has a HARD TIME BUDGET shown in the SCHEDULING + POSITION block. Treat it as fixed.
- If you write a lesson plan or block-by-block schedule, the minutes you list MUST sum to the budget or less. NEVER more. A 20-min session gets a 20-min plan, not a 60-min plan.
- If the learner needs more, say "this is more than today's budget — pace it across the next session too" rather than overrunning.

Plan awareness:
- You see what came just before and what's coming next. Use it. Reference the prior session by name when you build on it. Mention the next session when continuity matters.
- You see the position in the sprout (session N of M) and days to deadline. Calibrate intensity accordingly — don't push hard right before a deadline if the prior session went rough; don't go gentle if the user is way behind.`;

/**
 * The per-lesson context block. Prepended to every request so Fern always knows
 * which session the learner is on. Reads directly off PlanTask — falls back to
 * sensible blanks for fields the AI generator didn't fill.
 */
export function buildLessonContext(args: {
  task: PlanTask;
  planTitle: string;
  targetSkill: string;
  phaseName: string;
  parentLesson?: PlanTask;
  resolvedSteps: string[];
  resolvedSuccessCriteria: string[];
  resolvedObjective: string;
  /**
   * Optional scheduling + position fragment from `buildSchedulingFragment()`.
   * When present, it's appended below the lesson facts. Without it, Fern has
   * no awareness of time budget, day-of-week, or surrounding sessions —
   * which historically led to 60-min plans for 20-min sessions.
   */
  schedulingFragment?: string;
}): string {
  const { task, planTitle, targetSkill, phaseName, parentLesson } = args;
  const objectiveLabel =
    task.type === "milestone"
      ? "Target (must demonstrate)"
      : task.type === "review"
        ? "Goal (reinforcing)"
        : "Deliverable";
  const lessonLines: string[] = [
    `THE LEARNER IS ON THIS LESSON:`,
    `- Sprout: "${planTitle}" (skill: ${targetSkill})`,
    `- Session: "${task.title}" — type: ${task.type}, phase: ${phaseName}, ${task.minutes} min`,
    task.description ? `- What it is: ${task.description}` : "",
    `- ${objectiveLabel}: ${args.resolvedObjective}`,
    args.resolvedSteps.length > 0
      ? `- How (steps): ${args.resolvedSteps.map((h, i) => `${i + 1}) ${h}`).join(" | ")}`
      : "",
    args.resolvedSuccessCriteria.length > 0
      ? `- What success feels like: ${args.resolvedSuccessCriteria.join("; ")}`
      : "",
    parentLesson
      ? `- Reviewing this prior lesson: "${parentLesson.title}"${parentLesson.description ? ` — ${parentLesson.description}` : ""}`
      : "",
  ].filter(Boolean);
  const sections = [lessonLines.join("\n")];
  if (args.schedulingFragment) sections.push(args.schedulingFragment);
  return sections.join("\n\n");
}

/**
 * Preset prompts in the "Ask Fern to expand" panel. Each one is a one-shot
 * request — Fern gets the lesson context + the instruction, returns prose,
 * and the result is rendered as a dismissable card.
 *
 * Domain-agnostic instructions (no "warmup / reps / film yourself" baked in)
 * so they work for programming, language, music, math, and physical skills.
 */
export interface DeepenPreset {
  id: string;
  label: string;
  icon: string;
  instruction: string;
}

export const DEEPEN_PRESETS: DeepenPreset[] = [
  {
    id: "lesson-plan",
    label: "build me a full lesson plan",
    icon: "📋",
    instruction:
      "Write a structured lesson plan that fits EXACTLY the HARD TIME BUDGET shown in the SCHEDULING block — not more. Read the budget. Sum your blocks. Their minutes must equal the budget or be slightly under, never over. Open with a 1-sentence intent. Then a short ramp-in, main work in 1–3 short blocks, and a brief close ending with one reflection prompt for the journal. Sizes scale to the budget: a 15-min session should NOT have a 10-min ramp-in. Reference the prior session by name when you build on it. Use natural prose with short labeled blocks. End with the explicit minute total in parentheses, e.g. \"(total: 20 min)\".",
  },
  {
    id: "why-it-works",
    label: "why does this actually work?",
    icon: "🔬",
    instruction:
      "Explain the mechanism behind this session — what mental model, neural pathway, or structural understanding it actually trains. Be specific to the subject. Mention 1 alternative approach and what that one trains differently. Keep it warm and concrete, not academic.",
  },
  {
    id: "break-down-step",
    label: "break down the hardest step",
    icon: "🪜",
    instruction:
      "Identify the hardest step in the 'how' list and break it into a 4-part progression a beginner can layer in. For each sub-step, name one cue to attend to and one common failure mode. Be subject-specific.",
  },
  {
    id: "mistakes",
    label: "what will I get wrong?",
    icon: "⚠︎",
    instruction:
      "List 4 specific mistakes someone running this session for the first time will likely make. For each, give: the mistake (1 sentence), why it happens (1 sentence), and the immediate self-correction (1 sentence). Write naturally — no rigid table.",
  },
  {
    id: "easier",
    label: "give me an easier variation",
    icon: "🌱",
    instruction:
      "Propose an easier variation of this session for someone who tried it and felt overwhelmed. Reduce scope, time, or load — but keep the core training stimulus. Give the modified 'how' as numbered steps.",
  },
  {
    id: "harder",
    label: "make it harder",
    icon: "🔥",
    instruction:
      "Propose a harder variation for someone who passed this session and wants more challenge. Stay in the same skill family — don't introduce a new subject. Give the modified 'how' as numbered steps + 1 sentence on why it's harder.",
  },
];

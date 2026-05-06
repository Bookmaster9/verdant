/**
 * Prompt for generating a Verdant sprout plan from a goal + deadline + resources.
 *
 * To edit: change the strings below. Both `SPROUT_PLAN_SYSTEM` and
 * `buildSproutPlanUserPrompt` are pulled in by `src/lib/generate-sprout.ts`,
 * which sends them to the OpenAI Chat Completions API with
 * `response_format: { type: "json_object" }`.
 *
 * To test a prompt change locally without going through the UI, run:
 *   npx tsx scripts/test-sprout-prompt.ts "your goal" "YYYY-MM-DD"
 * (see scripts/test-sprout-prompt.ts).
 */

export const SPROUT_PLAN_MODEL = "gpt-4o-mini";
export const SPROUT_PLAN_TEMPERATURE = 0.4;

export const SPROUT_PLAN_SYSTEM = `You are Verdant, a learning plan designer.

You design "sprouts" — multi-week learning plans for self-directed learners. A sprout is a sequence of small, dated sessions that move a learner from "vague goal" to "concrete demonstrable skill" by their deadline.

Use these principles:
- **Phases first.** Break the plan into 2–5 named phases (e.g. Foundations / Build / Combine / Polish), each with a sharp focus sentence.
- **Lessons and milestones only.** Emit ONLY tasks of type "lesson" and "milestone". DO NOT emit any tasks of type "review". Verdant generates review tasks automatically using a spaced-repetition scheduler that adapts to the learner's performance — your reviews would conflict with it.
- **Milestone gates.** End each phase with a milestone task that visibly proves the phase is complete (e.g. "film yourself doing 2 clean reps"). Set \`preferStandalone: true\` on milestones so they don't share a daily block.
- **Realistic time.** Keep individual sessions in the 15–90 minute range. Most lessons should be 30–60 min; milestones 30–60 min.
- **Pace to the user's actual time budget.** The user prompt includes a per-week minutes summary; respect anomaly notes (e.g. "mostly blocked Mon/Tue") by placing lighter weeks where reality is constrained. Leave headroom — the spaced-repetition scheduler will add review sessions automatically.
- **Time-of-day hints.** Default \`preferredTimeOfDay\` to the user's strongest histogram bucket. Mornings for milestones when possible.
- **Priority.** Every task must have \`priority\`: "core" tasks are essential to the goal; "stretch" tasks are extras that may be dropped if the schedule overflows. Mark stretch sparingly.
- **Use the resources.** If the user provided links, weave them into lesson tasks via the resourceRef field when it is a single video or article.
- **YouTube playlists.** If the user pasted a playlist URL (\`...playlist?list=...\` or \`watch?v=...\&list=...\`), Verdant assigns each **lesson** session the next video in playlist order after generation — you do not need to duplicate video URLs on every lesson; focus titles and pedagogy on what to do in that sitting. When \`YOUTUBE_API_KEY\` is set, **lesson** durations are overwritten from each video’s runtime (+ 5 minutes buffer) — your \`minutes\` values for lessons with YouTube links are only a fallback.
- **No fluff.** Every task should advance the goal. No "introduction to learning" filler.
- **Concrete pedagogy per task.** Every task ships with three pedagogical fields the learner reads on the session page:
  - \`objective\`: the single concrete thing this session is for. For lessons → a deliverable (notes, a worked example, a clip). For milestones → a target the learner must demonstrate end-to-end. One sentence.
  - \`steps\`: 3–5 short imperative sentences telling the learner exactly how to spend the time. Tailor to the actual subject — no boilerplate like "warm up" unless physical, no "watch the demo" unless there's a video.
  - \`successCriteria\`: 2–4 short, concrete phrases the learner can self-check against (not "you understand it", but "you can re-derive the formula without the textbook"). Domain-specific.

Return a single JSON object that exactly matches the schema the user describes — no commentary, no markdown, no code fences.`;

export interface SproutPlanPromptInput {
  targetSkill: string;
  startDate: string; // "YYYY-MM-DD"
  deadline: string;
  weeks: number;
  initialResources: string[];
  /** Optional context produced by lib/availability-summary.ts. */
  availability?: {
    typicalWeeklyMinutes: number;
    perWeek: { weekIndex: number; minutes: number; note: string | null }[];
    preferredTimeOfDayHistogram: { morning: number; afternoon: number; evening: number };
  };
  /** Optional weekly target the user declared in settings. */
  weeklyMinutesTarget?: number | null;
  /** Optional freeform note from the plan creation form. Pasted verbatim. */
  freeformNote?: string | null;
}

export function buildSproutPlanUserPrompt(input: SproutPlanPromptInput): string {
  const availabilityLines: string[] = [];
  if (input.availability) {
    const a = input.availability;
    availabilityLines.push(
      ``,
      `Availability summary (do not propose more than this fits):`,
      `- Typical weekly capacity: ~${a.typicalWeeklyMinutes} minutes.`,
      ...(input.weeklyMinutesTarget != null
        ? [`- User's stated weekly target: ${input.weeklyMinutesTarget} minutes.`]
        : []),
      `- Per-week minutes:`,
      ...a.perWeek.map(
        (w) =>
          `  - week ${w.weekIndex}: ${w.minutes} min${w.note ? ` (${w.note})` : ""}`
      ),
    );
    const h = a.preferredTimeOfDayHistogram;
    if (h.morning + h.afternoon + h.evening > 0) {
      availabilityLines.push(
        `- Past effectiveness by time of day: morning=${h.morning}, afternoon=${h.afternoon}, evening=${h.evening}. Bias \`preferredTimeOfDay\` toward the strongest bucket.`
      );
    }
  }

  const noteLines: string[] = [];
  if (input.freeformNote && input.freeformNote.trim().length > 0) {
    noteLines.push(``, `User's note (verbatim):`, `"""`, input.freeformNote.trim(), `"""`);
  }

  const lines = [
    `Design a sprout for: ${input.targetSkill}`,
    ``,
    `Window: ${input.startDate} → ${input.deadline} (~${input.weeks} week${input.weeks === 1 ? "" : "s"})`,
    `Resources the user already has:${
      input.initialResources.length === 0
        ? " (none — propose phases without specific resourceRefs)"
        : "\n" + input.initialResources.map((r, i) => `  ${i + 1}. ${r}`).join("\n")
    }`,
    ...availabilityLines,
    ...noteLines,
    ``,
    `Return JSON of this exact shape:`,
    JSON.stringify(
      {
        summary:
          "1-2 sentence pitch of the plan, in plain prose (no markdown).",
        phases: [
          {
            name: "Phase name (1-2 words)",
            focus:
              "One sentence: what this phase teaches the body / mind to do.",
          },
        ],
        tasks: [
          {
            id: 'OPTIONAL stable id like "t-week0-foundations". If you use mustFollowTaskId, the predecessor must have an id.',
            title: "Concrete session title",
            type: 'lesson | milestone — DO NOT emit "review". Reviews are auto-generated.',
            minutes: "integer in [15, 90]",
            weekIndex: `integer in [0, ${input.weeks - 1}]`,
            dayOffsetInWeek: "integer in [0, 6] — 0 = Monday",
            description:
              "1-3 sentences: what this session is about, in plain prose. The 'what'. No bullet lists, no markdown.",
            objective:
              "REQUIRED. One sentence. For lessons: the concrete deliverable (e.g. 'a one-page summary of the chain rule with two worked examples'). For milestones: the target to demonstrate end-to-end (e.g. 'derive the gradient of softmax from scratch on paper, no references').",
            steps: [
              "REQUIRED. 3-5 short imperative sentences — exactly how the learner spends the time. Tailored to the subject. No filler like 'warm up' unless physical, no 'watch the demo' unless there's a video.",
            ],
            successCriteria: [
              "REQUIRED. 2-4 short, concrete phrases the learner can self-check against. Domain-specific — not 'you understand it', but 'you can re-derive the formula without the textbook'.",
            ],
            resourceRef:
              "OPTIONAL: a URL or resource name from the list above, if the session uses it.",
            preferredTimeOfDay:
              '"morning" | "afternoon" | "evening" | "any" — soft hint.',
            mustFollowTaskId:
              "OPTIONAL: id of the task this one must come after (e.g. milestone after the lessons it tests).",
            minDaysAfterPredecessor:
              "OPTIONAL integer days; pair with mustFollowTaskId.",
            preferStandalone:
              "OPTIONAL boolean. Set true on milestones so they don't share a daily block.",
            priority:
              '"core" | "stretch" — required. Stretch tasks are dropped first when overflow happens.',
          },
        ],
        rationale: [
          "Bullet point: why a key decision was made.",
          "Another bullet — pacing, ordering, or sequencing choices.",
          "3-6 bullets total. Plain prose, no markdown.",
        ],
        weeklyShape: {
          lessons: "typical lesson count per week (integer)",
          reviews: "typical review count per week (integer)",
          milestoneEvery: 'string: "phase" | "week" | "biweekly"',
        },
        sessionsPlanned: "total session count across the plan (integer)",
      },
      null,
      2
    ),
    ``,
    `Constraints:`,
    `- 2-5 phases. Each phase ends with a milestone task.`,
    `- Spread tasks across the whole window — do not pile everything into week 0.`,
    `- DO NOT emit any "review" tasks. Verdant adds adaptive review sessions automatically; including reviews here would double-book the calendar.`,
    `- Every task must have a priority of "core" or "stretch".`,
    `- The "rationale" array is your audit trail: why this phase order, why this pacing, why these milestones. The user reads it.`,
    `- weeklyShape and sessionsPlanned describe the plan you produced (not abstract advice). Set weeklyShape.reviews to 0 — reviews are scheduled separately.`,
  ];
  return lines.join("\n");
}

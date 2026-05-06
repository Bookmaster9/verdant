/**
 * Prompt for generating "Fern's notes" — short, observational notes that
 * appear at the top of a sprout's tend page. Fern is the wandering forest
 * sprite mascot; her notes feel personal, observational, and lightly
 * encouraging — never pushy.
 *
 * Edit the strings below to change Fern's voice or what she notices.
 * The output is a JSON array of {kicker, body} objects, persisted on the
 * LearningPlan row and refreshable via POST /api/plans/:id/fern-notes.
 */

export const FERN_NOTES_MODEL = "gpt-4o-mini";
export const FERN_NOTES_TEMPERATURE = 0.7;

export const FERN_NOTES_SYSTEM = `You are Fern — a quiet forest sprite who tends a learner's "garden" in the Verdant app. You write three short observational notes that appear above their plan.

Voice rules:
- Lowercase. Soft. Specific. Never preachy.
- Short — each note is one or two sentences (under 35 words).
- Reference real signals from the data the user gave you: a rating that moved, a streak that exists, a time-of-day pattern, a milestone coming up, a session they skipped. Never invent specifics.
- Use sentence case. No emoji. No exclamation marks.
- Don't address the user as "you" more than necessary; sound observational, not coachy.
- If the data is sparse (no completions yet, no ratings), say so honestly — encourage the first session, don't fabricate observations.

Always produce exactly three notes, in this order, with these kickers:
1. "fern's note"     — your warmest observation about the work so far
2. "fern noticed"    — a pattern in the data (slot, streak, rating shift, missed day)
3. "fern's reminder" — what to focus on next (a milestone, an upcoming session, a recovery day)

Return only valid JSON in the exact shape the user describes — no commentary, no markdown.`;

export interface FernNotesContext {
  planTitle: string;
  planSummary: string;
  daysToBloom: number;
  totalTasks: number;
  doneCount: number;
  averageRating: number | null;
  recentCompletions: Array<{
    title: string;
    date: string;
    rating: number | null;
  }>;
  upcoming: Array<{
    title: string;
    date: string;
    type: "lesson" | "review" | "milestone";
  }>;
  nextMilestone: { title: string; date: string } | null;
}

export function buildFernNotesUserPrompt(ctx: FernNotesContext): string {
  return [
    `Plan: ${ctx.planTitle}`,
    `Summary: ${ctx.planSummary}`,
    `Days to bloom: ${ctx.daysToBloom}`,
    `Tasks: ${ctx.doneCount} of ${ctx.totalTasks} done`,
    `Average rating across rated sessions: ${
      ctx.averageRating == null ? "n/a" : ctx.averageRating.toFixed(2) + " / 5"
    }`,
    ``,
    `Recent completions (newest first, up to 6):`,
    ctx.recentCompletions.length === 0
      ? "  (none yet)"
      : ctx.recentCompletions
          .map(
            (c) =>
              `  - ${c.date} · ${c.title}${
                c.rating != null ? ` · ${c.rating}/5` : " · (unrated)"
              }`
          )
          .join("\n"),
    ``,
    `Upcoming (next 6):`,
    ctx.upcoming.length === 0
      ? "  (none scheduled)"
      : ctx.upcoming
          .map((u) => `  - ${u.date} · ${u.type} · ${u.title}`)
          .join("\n"),
    ``,
    `Next milestone: ${
      ctx.nextMilestone
        ? `${ctx.nextMilestone.title} on ${ctx.nextMilestone.date}`
        : "(none scheduled)"
    }`,
    ``,
    `Return JSON of this exact shape:`,
    JSON.stringify(
      {
        notes: [
          { kicker: "fern's note", body: "..." },
          { kicker: "fern noticed", body: "..." },
          { kicker: "fern's reminder", body: "..." },
        ],
      },
      null,
      2
    ),
  ].join("\n");
}

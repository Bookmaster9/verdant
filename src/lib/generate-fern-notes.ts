import OpenAI from "openai";
import { z } from "zod";
import type { FernNote } from "@/types/plan";
import {
  FERN_NOTES_MODEL,
  FERN_NOTES_SYSTEM,
  FERN_NOTES_TEMPERATURE,
  buildFernNotesUserPrompt,
  type FernNotesContext,
} from "@/prompts/fern-notes";

const responseSchema = z.object({
  notes: z
    .array(
      z.object({
        kicker: z.string().min(1),
        body: z.string().min(1),
      })
    )
    .min(1),
});

function ruleBasedFallback(ctx: FernNotesContext): FernNote[] {
  const notes: FernNote[] = [];
  if (ctx.averageRating != null && ctx.averageRating >= 4) {
    notes.push({
      kicker: "fern's note",
      body: `your sessions are landing at ${ctx.averageRating.toFixed(
        1
      )} on average — strong soil. i'll keep weaving similar slots.`,
    });
  } else if (ctx.averageRating != null && ctx.averageRating < 3) {
    notes.push({
      kicker: "fern's note",
      body: `sessions are averaging ${ctx.averageRating.toFixed(
        1
      )}. let's lighten the next week — tell me which days felt heaviest.`,
    });
  } else if (ctx.doneCount === 0) {
    notes.push({
      kicker: "fern's note",
      body: `no sessions tended yet. tend the first one and rate it — that's how i learn what time of day works for you.`,
    });
  } else {
    notes.push({
      kicker: "fern's note",
      body: `${ctx.doneCount} session${ctx.doneCount === 1 ? "" : "s"} tended so far. keep rating them — every star teaches me a slot.`,
    });
  }
  notes.push({
    kicker: "fern noticed",
    body:
      ctx.recentCompletions.length > 0
        ? `your last session was "${ctx.recentCompletions[0].title}" on ${ctx.recentCompletions[0].date}.`
        : `nothing in the journal yet — the first entry sets the rhythm.`,
  });
  notes.push({
    kicker: "fern's reminder",
    body: ctx.nextMilestone
      ? `milestone coming: "${ctx.nextMilestone.title}" on ${ctx.nextMilestone.date}. set your phone up to film yourself before you start.`
      : ctx.upcoming.length === 0
        ? `no sessions ahead. ask me below to rebalance from today.`
        : `${ctx.upcoming.length} session${ctx.upcoming.length === 1 ? "" : "s"} on the road ahead. click any one to see the demo and the cues.`,
  });
  return notes;
}

export async function generateFernNotes(
  ctx: FernNotesContext
): Promise<{ notes: FernNote[]; usedAi: boolean }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return { notes: ruleBasedFallback(ctx), usedAi: false };
  }
  const openai = new OpenAI({ apiKey: key });
  const userContent = buildFernNotesUserPrompt(ctx);
  try {
    const res = await openai.chat.completions.create({
      model: FERN_NOTES_MODEL,
      temperature: FERN_NOTES_TEMPERATURE,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: FERN_NOTES_SYSTEM },
        { role: "user", content: userContent },
      ],
    });
    const text = res.choices[0]?.message?.content;
    if (!text) return { notes: ruleBasedFallback(ctx), usedAi: false };
    const parsed = responseSchema.parse(JSON.parse(text));
    return { notes: parsed.notes.slice(0, 3), usedAi: true };
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[generateFernNotes] falling back to rule-based:", err);
    }
    return { notes: ruleBasedFallback(ctx), usedAi: false };
  }
}

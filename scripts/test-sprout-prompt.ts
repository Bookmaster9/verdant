/**
 * Quick CLI to test prompt edits without going through the UI.
 *
 * Usage:
 *   npx tsx scripts/test-sprout-prompt.ts "your goal" "YYYY-MM-DD" [resource-url ...]
 *
 * Examples:
 *   npx tsx scripts/test-sprout-prompt.ts "fingerstyle guitar" "2026-09-01"
 *   npx tsx scripts/test-sprout-prompt.ts "Korean A1" "2026-08-15" "https://ttmik.com/" "Anki Topik 1 deck"
 *
 * Prints the structured plan JSON. Reads OPENAI_API_KEY from .env (loaded by Next).
 * If unset, prints the rule-based fallback plan so you can still inspect shape.
 */
import { config } from "dotenv";
config();

import { generatePlanWithAI } from "@/lib/generate-sprout";

async function main() {
  const [, , goal, deadline, ...resources] = process.argv;
  if (!goal || !deadline) {
    console.error(
      "usage: tsx scripts/test-sprout-prompt.ts <goal> <YYYY-MM-DD> [resource ...]"
    );
    process.exit(1);
  }
  const deadlineDate = new Date(deadline);
  if (Number.isNaN(deadlineDate.getTime())) {
    console.error(`invalid deadline: ${deadline}`);
    process.exit(1);
  }
  const startDate = new Date();
  const plan = await generatePlanWithAI({
    targetSkill: goal,
    deadline: deadlineDate,
    startDate,
    initialResources: resources,
  });
  console.log(JSON.stringify(plan, null, 2));
}

void main();

/**
 * Resolve the pedagogical content for a PlanTask — objective, steps,
 * success criteria — so both the page renderer and the Fern chat API see
 * the same view. When the AI generator filled these fields, return them
 * verbatim. Otherwise fall back to domain-agnostic templates.
 *
 * Mirrors the fallbacks in `src/app/plan/[id]/session/[taskId]/page.tsx`.
 * Kept here so server-only code (chat API) doesn't have to import a client/
 * server hybrid page module.
 */

import type { PlanTask, ScheduledSession, SproutPlan } from "@/types/plan";
import { format, differenceInCalendarDays, parseISO } from "date-fns";
import { phaseForWeek } from "@/lib/phase";

export function resolveObjective(task: PlanTask, parent?: PlanTask): string {
  if (task.objective) return task.objective;
  if (task.type === "milestone") {
    return "Demonstrate the skill end-to-end on your own — without referencing the lessons that taught it.";
  }
  if (task.type === "review") {
    if (parent?.objective) {
      return `Re-engage with the deliverable from "${parent.title}": ${parent.objective}`;
    }
    return "Reconstruct the prior lesson in your own words — without peeking — then check yourself against the source.";
  }
  return "Produce one concrete artifact you can point to: notes, a worked example, a clip, a diagram.";
}

export function resolveSteps(task: PlanTask, parent?: PlanTask): string[] {
  if (task.steps && task.steps.length >= 2) return task.steps;
  if (task.type === "review" && parent?.steps && parent.steps.length >= 2) {
    return [
      `Re-engage with: "${parent.title}". Don't peek at the source yet.`,
      "From memory, sketch out the core idea or redo the deliverable in rough form.",
      "Compare your version to the original — circle the gaps, not the wins.",
      "Write what surprised you in the journal below.",
    ];
  }
  if (task.description) {
    const split = task.description
      .split(/\n+|\.\s+(?=[A-Z])/g)
      .map((s) => s.trim())
      .filter(Boolean);
    if (split.length >= 2) return split;
  }
  if (task.type === "milestone") {
    return [
      `Carve out ${task.minutes} uninterrupted minutes and gather the materials you need.`,
      "Run through the target end-to-end on your own, without referencing the lessons.",
      "Repeat once more, then assess against the success criteria below.",
      "Capture what felt solid and what didn't in the journal.",
    ];
  }
  if (task.type === "review") {
    return [
      "Pull up the prior lesson — but don't open it yet.",
      "From memory, reconstruct the core idea or redo the deliverable in rough form.",
      "Check yourself against the source. Note where you drifted.",
      "Capture one new insight in the journal below.",
    ];
  }
  return [
    `Block out ${task.minutes} minutes with no interruptions and the source ready.`,
    "Engage actively — read, watch, or work through the source with notes in hand.",
    "Produce the deliverable, even a rough first pass. Get it on paper or screen.",
    "Note one thing that was sharper or fuzzier than expected in the journal.",
  ];
}

export function resolveSuccessCriteria(
  task: PlanTask,
  parent?: PlanTask
): string[] {
  if (task.successCriteria && task.successCriteria.length > 0) {
    return task.successCriteria;
  }
  if (
    task.type === "review" &&
    parent?.successCriteria &&
    parent.successCriteria.length > 0
  ) {
    return parent.successCriteria;
  }
  if (task.type === "milestone") {
    return [
      "You can do it end-to-end without consulting the prior lessons.",
      "Your output is consistent — not just one good run.",
      "You can describe in one sentence what changed since the start of the phase.",
    ];
  }
  if (task.type === "review") {
    return [
      "You can recall the core idea without consulting your notes.",
      "You noticed at least one thing that wasn't sharp the first time.",
      "You'd be comfortable being asked about this cold next week.",
    ];
  }
  return [
    "You finished the deliverable, even if it's rough.",
    "You can summarize the core idea in one sentence.",
    "You'd be ready to apply this in a real task tomorrow.",
  ];
}

/**
 * Build the "scheduling + position" fragment that grounds Fern in WHERE in
 * the plan this lesson sits. Without it, Fern produces generic 60-minute
 * plans for 20-minute sessions and ignores what the learner already did.
 *
 * Returns a multi-line string ready to drop into the system context.
 */
export function buildSchedulingFragment(args: {
  task: PlanTask;
  plan: { startDate: Date; deadline: Date };
  sprout: SproutPlan;
  schedule: ScheduledSession[];
  /** When true, this is a synthesized review (not in sprout.tasks). */
  isReview: boolean;
  parentLesson?: PlanTask;
  now?: Date;
}): string {
  const now = args.now ?? new Date();
  const lines: string[] = [];

  // Hard time budget — repeated in the most assertive form so the model
  // can't drift into 60-min plans for 20-min sessions.
  lines.push(
    `- HARD TIME BUDGET: ${args.task.minutes} minutes. Anything you write — lesson plans, exercises, drills — must fit inside ${args.task.minutes} minutes. If you list time-boxed blocks, their minutes MUST sum to ${args.task.minutes} or less. Do not exceed.`
  );

  // Scheduled date / day of week
  const scheduledFor = args.schedule.find(
    (row) =>
      row.planTaskId === args.task.id ||
      row.agenda?.some((a) => a.planTaskId === args.task.id)
  );
  if (scheduledFor) {
    const start = parseISO(scheduledFor.start);
    const end = parseISO(scheduledFor.end);
    const today = startOfDay(now);
    const startDay = startOfDay(start);
    const dayDelta = differenceInCalendarDays(startDay, today);
    let when: string;
    if (dayDelta === 0) when = "today";
    else if (dayDelta === 1) when = "tomorrow";
    else if (dayDelta === -1) when = "yesterday";
    else if (dayDelta > 1 && dayDelta <= 7) when = `in ${dayDelta} days`;
    else if (dayDelta < -1 && dayDelta >= -7) when = `${Math.abs(dayDelta)} days ago (overdue)`;
    else when = format(start, "MMM d");
    lines.push(
      `- Scheduled for: ${format(start, "EEEE")}, ${format(start, "MMM d")} at ${format(start, "h:mm a")}–${format(end, "h:mm a")} (${when})`
    );
  } else {
    lines.push(`- Scheduled for: not yet on the calendar`);
  }

  // Position in plan — only meaningful for non-review tasks (reviews live
  // outside sprout.tasks).
  const tasks = args.sprout.tasks ?? [];
  const sortedTasks = [...tasks].sort(
    (a, b) =>
      a.weekIndex - b.weekIndex || a.dayOffsetInWeek - b.dayOffsetInWeek
  );
  const phases = args.sprout.phases ?? [];

  if (!args.isReview) {
    const idx = sortedTasks.findIndex((t) => t.id === args.task.id);
    if (idx >= 0) {
      lines.push(
        `- Position in sprout: session ${idx + 1} of ${sortedTasks.length} (${sortedTasks.length - idx - 1} to go)`
      );
    }

    // Phase position
    const phaseIdx = phaseForWeek(args.task.weekIndex, phases.length);
    const phase = phases[phaseIdx];
    if (phase) {
      const phaseTasks = sortedTasks.filter(
        (t) => phaseForWeek(t.weekIndex, phases.length) === phaseIdx
      );
      const phaseTaskIdx = phaseTasks.findIndex((t) => t.id === args.task.id);
      lines.push(
        `- Phase: "${phase.name}" (focus: ${phase.focus}) — session ${
          phaseTaskIdx + 1
        } of ${phaseTasks.length} in this phase`
      );
    }

    // Previous + next sessions in the plan order
    if (idx > 0) {
      const prev = sortedTasks[idx - 1];
      lines.push(
        `- Just before: "${prev.title}" (${prev.type}, ${prev.minutes} min)`
      );
    } else {
      lines.push(`- Just before: nothing — this is the first session in the sprout`);
    }
    if (idx >= 0 && idx < sortedTasks.length - 1) {
      const next = sortedTasks[idx + 1];
      lines.push(
        `- Coming next: "${next.title}" (${next.type}, ${next.minutes} min)`
      );
    } else if (idx === sortedTasks.length - 1) {
      lines.push(`- Coming next: nothing — this is the last session before deadline`);
    }
  } else if (args.parentLesson) {
    // For reviews, anchor to the parent lesson instead of plan position.
    lines.push(
      `- This review is reinforcing: "${args.parentLesson.title}" (${args.parentLesson.minutes} min lesson). The original lesson covered: ${args.parentLesson.description ?? "(no description)"}`
    );
  }

  // Deadline countdown
  const daysToDeadline = differenceInCalendarDays(args.plan.deadline, now);
  if (daysToDeadline > 0) {
    lines.push(
      `- Plan deadline: ${format(args.plan.deadline, "MMM d")} (${daysToDeadline} days from today)`
    );
  } else if (daysToDeadline === 0) {
    lines.push(`- Plan deadline: today`);
  } else {
    lines.push(
      `- Plan deadline: ${format(args.plan.deadline, "MMM d")} (passed ${Math.abs(daysToDeadline)} days ago)`
    );
  }

  return ["SCHEDULING + POSITION:", ...lines].join("\n");
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

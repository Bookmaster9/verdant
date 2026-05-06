/**
 * Load FSRS-projected review instances for a plan and convert them to
 * `PlanTask[]` so they can be repacked alongside the plan's lessons +
 * milestones.
 *
 * This bridges a gap that bit us hard: lessons + milestones live in
 * `LearningPlan.planJson`, but reviews are FSRS-managed `ReviewInstance` rows
 * not present in `planJson.tasks`. Repack paths that pulled tasks from
 * `planJson` alone were silently DROPPING every projected review session
 * during a reflow. Use this helper at every repack site so reviews ride
 * along.
 *
 * Only `projected: true` (not yet rated) reviews are returned. Completed
 * reviews stay in the DB as history but don't need re-placement.
 */
import { prisma } from "@/lib/db";
import { reviewInstanceToTask } from "@/lib/fsrs-to-tasks";
import type { PlanTask, SproutPlan } from "@/types/plan";

export async function loadProjectedReviewTasks(args: {
  planId: string;
  sproutPlan: SproutPlan;
  planStartDate: Date;
}): Promise<PlanTask[]> {
  const reviews = await prisma.reviewInstance.findMany({
    where: { planId: args.planId, projected: true, completedAt: null },
    include: { lessonState: true },
  });
  if (reviews.length === 0) return [];
  const titleByLessonId = new Map(
    (args.sproutPlan.tasks ?? []).map((t) => [t.id, t.title] as const)
  );
  return reviews.map((r) =>
    reviewInstanceToTask({
      review: r,
      lessonTitle: titleByLessonId.get(r.lessonState.lessonId) ?? "lesson",
      parentLessonId: r.lessonState.lessonId,
      planStartDate: args.planStartDate,
    })
  );
}

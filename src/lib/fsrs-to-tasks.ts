/**
 * Adapter from FSRS-managed review state (Prisma `ReviewInstance` rows) into
 * the `PlanTask` shape consumed by the slot-scoring packer. Lets the packer
 * stay ignorant of FSRS — it just sees a unified task list with a `dueAt`
 * hint on review tasks.
 */
import type { ReviewInstance } from "@prisma/client";
import type { PlanTask } from "@/types/plan";

/** Default minutes for a single review session. Short enough to bundle. */
const REVIEW_MINUTES = 15;

/** Minimum days between a lesson and its first review (matches FSRS seeding). */
const MIN_DAYS_AFTER_LESSON = 1;

export function reviewInstanceToTask(args: {
  review: ReviewInstance;
  lessonTitle: string;
  /**
   * Parent lesson PlanTask.id. When provided AND the lesson is in the same
   * pack call, the packer enforces "review must come after lesson" as a hard
   * constraint via `mustFollowTaskId`. Omit only when the parent lesson is
   * already on the schedule (i.e. post-rating chain extension) — the packer's
   * predecessor lookup only considers tasks within the current pack call, so
   * setting it for an absent predecessor is a silent no-op.
   */
  parentLessonId?: string;
  /**
   * Plan start date — used to derive `weekIndex` from the review's `dueAt`.
   * Without this, every review defaults to week 0 and the packer treats them
   * all as "should land in the first week" regardless of when FSRS wants them.
   */
  planStartDate?: Date;
}): PlanTask {
  const dueDate = new Date(args.review.dueAt);
  const weekIndex = args.planStartDate
    ? Math.max(
        0,
        Math.floor(
          (dueDate.getTime() - args.planStartDate.getTime()) /
            (7 * 86_400_000)
        )
      )
    : 0;
  const dayOffsetInWeek = (dueDate.getDay() + 6) % 7; // Mon=0..Sun=6
  return {
    id: args.review.id,
    title: `Review: ${args.lessonTitle}`,
    type: "review",
    minutes: REVIEW_MINUTES,
    weekIndex,
    dayOffsetInWeek,
    dueAt: args.review.dueAt.toISOString(),
    preferStandalone: false,
    priority: "core",
    mustFollowTaskId: args.parentLessonId,
    minDaysAfterPredecessor: args.parentLessonId
      ? MIN_DAYS_AFTER_LESSON
      : undefined,
  };
}

/**
 * Combine plan tasks (lessons + milestones from `planJson`) with adapter-built
 * review tasks. Returns the unified list ready for the packer.
 */
export function mergeTasksWithReviews(args: {
  planTasks: PlanTask[];
  reviews: Array<{
    review: ReviewInstance;
    lessonTitle: string;
    parentLessonId?: string;
  }>;
  planStartDate?: Date;
}): PlanTask[] {
  const reviewTasks = args.reviews.map((r) =>
    reviewInstanceToTask({ ...r, planStartDate: args.planStartDate })
  );
  return [...args.planTasks, ...reviewTasks];
}

/**
 * Verdant's FSRS wrapper. All FSRS math is delegated to `ts-fsrs`; this module
 * holds Verdant-specific concerns: intensity → retention mapping, projection
 * out to the deadline (or beyond, under `maintain` mode), rating conversion
 * between our UI scale ({1,2,4,5}) and the library scale (1-4).
 *
 * State storage is per-lesson (LessonState in Prisma). Future per-concept
 * migration changes the FK on LessonState/ReviewInstance — the math here is
 * unaffected.
 */
import { fsrs, createEmptyCard, Rating, type Card, type Grade } from "ts-fsrs";

/** Map plan `intensity` (1=gentle, 2=steady, 3=focused) → FSRS request_retention. */
export const INTENSITY_TO_RETENTION: Record<number, number> = {
  1: 0.8,
  2: 0.9,
  3: 0.95,
};

/** Lower retention used after a plan's deadline when `postDeadlineMode === "maintain"`. */
export const MAINTAIN_RETENTION = 0.7;

/** Hard cap on projected reviews per lesson. Guards `maintain` mode from runaway projection. */
const MAX_PROJECTED_REVIEWS_PER_LESSON = 30;

/** First review interval after the seeding lesson, in days. FSRS spec default. */
const FIRST_REVIEW_OFFSET_DAYS = 1;

/** Convert intensity (1-3) to the FSRS `request_retention` parameter. */
export function retentionForIntensity(intensity: number): number {
  return INTENSITY_TO_RETENTION[intensity] ?? INTENSITY_TO_RETENTION[2];
}

/** Convert Verdant UI rating ({1,2,4,5}) to the ts-fsrs Grade enum (1-4). */
export function uiRatingToGrade(ui: number): Grade {
  switch (ui) {
    case 1:
      return Rating.Again as Grade;
    case 2:
      return Rating.Hard as Grade;
    case 4:
      return Rating.Good as Grade;
    case 5:
      return Rating.Easy as Grade;
    default:
      return Rating.Good as Grade;
  }
}

/** Numeric label for each rating, used for slot-effectiveness signal. */
export const UI_RATING_VALUES = [1, 2, 4, 5] as const;
export type UiRating = (typeof UI_RATING_VALUES)[number];

/**
 * Stored snapshot of FSRS state for one lesson. Mirrors the `LessonState`
 * Prisma model but kept as a plain shape to keep this module DB-agnostic.
 */
export interface LessonStateSnapshot {
  difficulty: number;
  stability: number;
  lastReview: Date | null;
  lapses: number;
}

/** Build the ts-fsrs `Card` value for an existing lesson state. */
function snapshotToCard(snap: LessonStateSnapshot, dueAt: Date): Card {
  // `state` is recoverable from `lapses` + `lastReview` heuristically; FSRS only
  // needs it to pick the right transition table. Lessons with one or more lapses
  // are in Relearning; otherwise once reviewed they're Review; never reviewed → New.
  const state = snap.lastReview
    ? snap.lapses > 0
      ? 3 /* Relearning */
      : 2 /* Review */
    : 0; /* New */
  return {
    due: dueAt,
    stability: snap.stability,
    difficulty: snap.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: snap.lastReview ? 1 : 0,
    lapses: snap.lapses,
    state: state as Card["state"],
    last_review: snap.lastReview ?? undefined,
  };
}

/** Default state for a brand-new lesson the user hasn't reviewed yet. */
export function initialLessonState(): LessonStateSnapshot {
  const empty = createEmptyCard(new Date());
  return {
    difficulty: empty.difficulty,
    stability: empty.stability,
    lastReview: null,
    lapses: 0,
  };
}

/**
 * Apply a rating to a lesson's FSRS state and return the next state + the
 * recommended next due date. The caller is expected to persist both.
 */
export function applyRating(args: {
  state: LessonStateSnapshot;
  uiRating: UiRating;
  now: Date;
  intensity: number;
}): { next: LessonStateSnapshot; dueAt: Date } {
  const f = fsrs({ request_retention: retentionForIntensity(args.intensity) });
  const card = snapshotToCard(args.state, args.now);
  const grade = uiRatingToGrade(args.uiRating);
  const item = f.next(card, args.now, grade);
  return {
    next: {
      difficulty: item.card.difficulty,
      stability: item.card.stability,
      lastReview: args.now,
      lapses: item.card.lapses,
    },
    dueAt: item.card.due,
  };
}

/**
 * Project a lesson's full review chain forward from the current state until
 * the deadline (or the maintenance horizon). Each step assumes a "Good" rating —
 * the chain represents the *expected* schedule and is regenerated whenever the
 * user actually rates a review.
 *
 * Returns due dates for each projected review, in chronological order. Empty
 * array if no reviews fit before the deadline (and not in maintain mode).
 */
export function projectReviewChain(args: {
  state: LessonStateSnapshot;
  /** End time of the seeding lesson (used as the "now" for the first projection step). */
  lessonEnd: Date;
  /** End-of-day deadline for the plan. */
  deadline: Date;
  intensity: number;
  postDeadlineMode: "stop" | "maintain";
}): Date[] {
  const dueDates: Date[] = [];

  // First projected review: a fixed offset after the lesson, regardless of FSRS
  // math. This anchors the chain — without a first review, there's no rating
  // event to drive the rest of the schedule.
  const firstDue = new Date(
    args.lessonEnd.getTime() + FIRST_REVIEW_OFFSET_DAYS * 86_400_000
  );
  if (firstDue > args.deadline && args.postDeadlineMode === "stop") {
    return [];
  }
  dueDates.push(firstDue);

  // Walk the chain forward by simulating Good ratings at each projected due date.
  let card: Card = snapshotToCard(args.state, firstDue);
  let now = firstDue;
  let activeRetention = retentionForIntensity(args.intensity);
  let crossedDeadline = false;

  for (let i = 1; i < MAX_PROJECTED_REVIEWS_PER_LESSON; i++) {
    // Switch retention to maintenance once we cross the deadline.
    if (!crossedDeadline && now >= args.deadline) {
      if (args.postDeadlineMode === "stop") break;
      activeRetention = MAINTAIN_RETENTION;
      crossedDeadline = true;
    }
    const f = fsrs({ request_retention: activeRetention });
    const item = f.next(card, now, Rating.Good as Grade);
    const nextDue = item.card.due;

    // Stop mode: truncate the chain when the next review would land past the deadline.
    // The previously-pushed review is already at or before the deadline, so the
    // user hits the deadline at retention ≥ R_target by construction.
    if (nextDue > args.deadline && args.postDeadlineMode === "stop") break;

    dueDates.push(nextDue);
    card = item.card;
    now = nextDue;
  }

  return dueDates;
}

/**
 * Plan a fresh FSRS state for every lesson task and project an initial review
 * chain per lesson. Used at plan creation and migration. Returns plain shapes
 * that the caller persists via Prisma.
 *
 * `lessonEndByTaskId` maps lesson PlanTask.id → the time at which that lesson
 * is currently scheduled to end (i.e. when FSRS should anchor "review starts").
 * Lessons not in the map are skipped (e.g. they didn't fit in the calendar).
 */
export function seedFsrsForPlan(args: {
  lessonTaskIds: string[];
  lessonEndByTaskId: Map<string, Date>;
  deadline: Date;
  intensity: number;
  postDeadlineMode: "stop" | "maintain";
}): {
  lessonStates: Array<{
    lessonId: string;
    difficulty: number;
    stability: number;
    lapses: number;
  }>;
  reviewsByLessonId: Map<string, Date[]>;
} {
  const lessonStates: Array<{
    lessonId: string;
    difficulty: number;
    stability: number;
    lapses: number;
  }> = [];
  const reviewsByLessonId = new Map<string, Date[]>();

  for (const lessonId of args.lessonTaskIds) {
    const initial = initialLessonState();
    lessonStates.push({
      lessonId,
      difficulty: initial.difficulty,
      stability: initial.stability,
      lapses: 0,
    });

    const lessonEnd = args.lessonEndByTaskId.get(lessonId);
    if (!lessonEnd) {
      reviewsByLessonId.set(lessonId, []);
      continue;
    }

    const dueDates = projectReviewChain({
      state: initial,
      lessonEnd,
      deadline: args.deadline,
      intensity: args.intensity,
      postDeadlineMode: args.postDeadlineMode,
    });
    reviewsByLessonId.set(lessonId, dueDates);
  }

  return { lessonStates, reviewsByLessonId };
}

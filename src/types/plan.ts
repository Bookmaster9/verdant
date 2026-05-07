export type TaskType = "lesson" | "review" | "milestone";

export type TimeOfDay = "morning" | "afternoon" | "evening" | "any";

export interface PlanTask {
  id: string;
  title: string;
  type: TaskType;
  minutes: number;
  /**
   * Soft hint: AI-preferred week offset from `startDate` (0 = first week).
   * Honored by the scoring packer as a preference, not a hard constraint.
   */
  weekIndex: number;
  /** Soft hint: AI-preferred day-of-week (0 = Mon, 6 = Sun). */
  dayOffsetInWeek: number;
  description?: string;
  resourceRef?: string;

  // --- Hint fields (design Q5). Optional with sensible defaults so old plans keep working. ---
  /** AI-preferred time of day. Defaults to "any" when absent. */
  preferredTimeOfDay?: TimeOfDay;
  /** Spacing rule: this task must come after the named predecessor. */
  mustFollowTaskId?: string;
  /** Minimum days between predecessor and this task (used with mustFollowTaskId). */
  minDaysAfterPredecessor?: number;
  /** When true, packer won't merge this task with others into a daily block. */
  preferStandalone?: boolean;
  /** Drop-order signal: stretch tasks dropped first when overflow can't fit before deadline. */
  priority?: "core" | "stretch";
  /**
   * FSRS-recommended due date (review tasks only). Soft hint with a heavy weight in
   * the scoring packer — closer to `dueAt` is much better than farther. ISO string.
   */
  dueAt?: string;

  // --- Pedagogical content fields. Optional — old plans without them fall back to
  //     domain-agnostic copy in the session detail page. New plans get these from
  //     the AI generator (see prompts/sprout-plan.ts).

  /**
   * The single concrete thing this session is for. Rendered with a type-specific
   * label: "deliverable" for lessons, "goal" for reviews, "target" for milestones.
   * One sentence, plain prose.
   */
  objective?: string;

  /**
   * Numbered steps for "how to do it". 2–5 short sentences. When absent, the page
   * falls back to splitting `description`, then to a domain-agnostic template.
   */
  steps?: string[];

  /**
   * Bullets for "what success feels like". 2–4 short phrases — concrete enough that
   * the learner can self-assess. Domain-specific (the AI writes them per task).
   */
  successCriteria?: string[];
}

export interface SproutPlan {
  summary: string;
  phases: { name: string; focus: string }[];
  tasks: PlanTask[];
  /**
   * Optional structured fields captured from the AI plan generator,
   * exposed via the AI plan disclosure on the tend page.
   */
  rationale?: string[];
  weeklyShape?: {
    lessons: number;
    reviews: number;
    milestoneEvery: string;
  };
  sessionsPlanned?: number;
}

/** One Fern's note rendered above the phase trail on the tend page. */
export interface FernNote {
  kicker: string; // e.g. "fern's note"
  body: string;
}

/**
 * Day-of-week tokens used inside `PlacementRule` filters and targets.
 * 0 = Mon ... 6 = Sun. The string form is what the AI emits; helpers
 * in `placement-rules.ts` map between the two.
 */
export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/**
 * Filter clause used to select which tasks/sessions a rule applies to. AND
 * across populated fields. Empty filter matches everything.
 */
export interface RuleFilter {
  type?: TaskType;
  dayOfWeek?: DayOfWeek[];
  weekIndex?: number;
  phaseIndex?: number;
  priority?: "core" | "stretch";
  taskIds?: string[];
}

/**
 * Declarative placement rule emitted by the NL editor (or stored as a plan
 * preference). The AI never picks specific times; rules feed into
 * `packWithScoring` and the packer chooses slots.
 *
 * Three verbs:
 *   - "prefer": soft pull. Adds a positive score term for matching tasks
 *     against slots that satisfy `target`. Loses to FSRS dueAt + predecessor.
 *   - "forbid": hard exclusion. Compiled into `BusyInterval[]` covering the
 *     `window`, so the packer's filter step rejects matching slots.
 *   - "pin": hard, exact. Sets `locked: true` on the named session and
 *     fixes its time. Equivalent to the legacy lock_session op + exact start.
 */
export type PlacementRule =
  | {
      kind: "prefer";
      filter: RuleFilter;
      target: {
        dayOfWeek?: DayOfWeek[];
        timeOfDay?: TimeOfDay;
        weekIndex?: number;
      };
    }
  | {
      kind: "forbid";
      filter: RuleFilter;
      window: {
        dayOfWeek?: DayOfWeek[];
        date?: string; // YYYY-MM-DD
        dateRange?: { from: string; to: string }; // YYYY-MM-DD inclusive
      };
    }
  | {
      kind: "pin";
      sessionId: string;
      start: string; // ISO
    };

export interface TimeWindow {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
}

/**
 * Per-day list of allowed time windows. Keys are weekday indices using
 * `Date.getDay()` semantics (Sun=0..Sat=6). Each day maps to zero or more
 * non-overlapping `{start, end}` ranges; the heatmap UI lets users pick
 * non-contiguous hours, which coalesce into the minimal set of ranges per day.
 */
export type TimeWindows = Record<string, TimeWindow[] | undefined>;

export interface ScheduledSession {
  id: string;
  /** First task in this block (for backwards compatibility). */
  planTaskId: string;
  /**
   * When several plan tasks share one daily meeting, listed here with minutes.
   * Omitted for legacy single-task sessions.
   */
  agenda?: Array<{
    planTaskId: string;
    title: string;
    type: TaskType;
    minutes: number;
  }>;
  start: string; // ISO
  end: string;
  /** Event title: combined agenda titles when multiple tasks share the block. */
  title: string;
  type: TaskType;
  calendarEventId?: string;
  googleSynced?: boolean;
  /**
   * When true, the packer treats this session as a hard external block:
   * it stays put on reschedules and blocks other tasks from its slot. Set
   * via the tend-page toggle, or implicitly when the user drags the event
   * inside Google Calendar (drift adoption).
   */
  locked?: boolean;
  /**
   * ISO timestamp set when the lazy missed-detection pass has already credited
   * a "missed" signal to the hour-utility map for this session. Prevents
   * double-counting on repeat dashboard reads. Only set on past sessions that
   * never got a completion. Cleared if the session is later moved (move-session
   * already produces a fresh placement, so the old session is gone).
   */
  missedSignalAppliedAt?: string;
}

import { auth } from "@/auth";
import { Shell } from "@/components/Shell";
import { prisma } from "@/lib/db";
import { ensureUserPreferences } from "@/lib/user";
import type { PlanTask, ScheduledSession, SproutPlan } from "@/types/plan";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { parseISO } from "date-fns";
import {
  TypeBadge,
  YouTubeBlock,
} from "@/components/verdant/SessionPrimitives";
import { LeafSprig, Sprout } from "@/components/verdant/art";
import { displayTitle, phaseForWeek, youtubeId } from "@/lib/phase";
import { SessionControls } from "./SessionControls";
import { JournalBox } from "./JournalBox";
import {
  FernGuidanceColumn,
  type ChatTurn,
  type PersistedDeepenCard,
} from "./FernGuidanceColumn";
import {
  resolveObjective,
  resolveSteps,
  resolveSuccessCriteria,
} from "@/lib/session-content";
import { findTaskJournalByTask } from "@/lib/task-journal";

function pickVideoFor(
  task: PlanTask,
  initialResources: string[]
): { id: string | null; caption?: string } {
  if (task.resourceRef) {
    const id = youtubeId(task.resourceRef);
    if (id) return { id, caption: task.resourceRef };
  }
  for (const r of initialResources) {
    const id = youtubeId(r);
    if (id) return { id, caption: r };
  }
  return { id: null };
}

function whyCopyFor(type: PlanTask["type"]): string {
  if (type === "milestone") {
    return "Milestones gate phases — the plan won't ramp until you pass. Treat this like a check-in, not a final exam: you're proving the prior weeks have integrated into something you own.";
  }
  if (type === "review") {
    return "Reviews are how lessons stick. Spaced repetition does more for retention than the original lesson did. Don't skip — even a short pass keeps the prior week alive.";
  }
  return "Lessons introduce new material. Show up with focus, engage with the source actively, and end the session with a concrete artifact — that's what makes it stick.";
}

function objectiveLabelFor(type: PlanTask["type"]): string {
  if (type === "milestone") return "your target";
  if (type === "review") return "your goal";
  return "your deliverable";
}

function objectiveTitleFor(type: PlanTask["type"]): string {
  if (type === "milestone") return "Target — what you must demonstrate";
  if (type === "review") return "Goal — what you're reinforcing";
  return "Deliverable — what you'll have at the end";
}

function fernReadFor(type: PlanTask["type"]): string {
  if (type === "milestone") {
    return "This is a checkpoint, not just a session. Bring full focus — capture evidence (notes, a recording, a screenshot). The next phase opens when you pass.";
  }
  if (type === "review") {
    return "Don't skip this — the spaced repetition is doing more than the original lesson did.";
  }
  return "First pass on this material? Engage actively, not passively. End with the deliverable in hand, even if it's rough.";
}

function parseChatTurns(json: string): ChatTurn[] {
  try {
    const arr = JSON.parse(json || "[]");
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t): t is ChatTurn =>
        t &&
        typeof t === "object" &&
        (t.role === "user" || t.role === "fern") &&
        typeof t.content === "string"
    );
  } catch {
    return [];
  }
}

function parseDeepenCards(json: string): PersistedDeepenCard[] {
  try {
    const arr = JSON.parse(json || "[]");
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (c): c is PersistedDeepenCard =>
        c &&
        typeof c === "object" &&
        typeof c.id === "string" &&
        typeof c.presetId === "string" &&
        typeof c.content === "string"
    );
  } catch {
    return [];
  }
}

// Session state mutates whenever the user marks done / re-rates / re-opens.
// Force-dynamic so the page never serves stale TaskCompletion / ReviewInstance
// data after a sibling edit elsewhere.
export const dynamic = "force-dynamic";

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string; taskId: string }>;
}) {
  const s = await auth();
  if (!s?.user?.id) {
    redirect("/login");
  }
  const { id, taskId } = await params;
  const plan = await prisma.learningPlan.findFirst({
    where: { id, userId: s.user.id },
  });
  if (!plan) notFound();

  const pref = await ensureUserPreferences(s.user.id);
  const tz = pref.userTimeZone || "UTC";

  const sprout: SproutPlan = JSON.parse(plan.planJson) as SproutPlan;
  const tasks = sprout.tasks || [];
  const planTask = tasks.find((t) => t.id === taskId);

  const schedule: ScheduledSession[] = JSON.parse(
    plan.scheduleJson || "[]"
  ) as ScheduledSession[];
  const scheduledFor = schedule.find(
    (row) =>
      row.planTaskId === taskId ||
      row.agenda?.some((a) => a.planTaskId === taskId)
  );

  // If the taskId isn't in planJson, look it up as a ReviewInstance.
  // FSRS-managed reviews live in their own table; we synthesize a PlanTask
  // shape so the rest of the rendering flow stays unchanged.
  let task: PlanTask;
  let isReview = false;
  let reviewState: { rating: number | null; completed: boolean } | null = null;
  let reviewParentLessonId: string | null = null;
  let parentLesson: PlanTask | undefined;

  if (planTask) {
    task = planTask;
  } else {
    const ri = await prisma.reviewInstance.findUnique({
      where: { id: taskId },
      include: { lessonState: true },
    });
    if (!ri || ri.planId !== plan.id) notFound();
    isReview = true;
    reviewParentLessonId = ri.lessonState.lessonId;
    parentLesson = tasks.find((t) => t.id === ri.lessonState.lessonId);
    const parentTitle = parentLesson?.title ?? "earlier lesson";
    const start = scheduledFor ? new Date(scheduledFor.start) : ri.dueAt;
    const startMs = start.getTime();
    const planStart = new Date(plan.startDate).getTime();
    const weekIndex = Math.max(
      0,
      Math.floor((startMs - planStart) / (7 * 86_400_000))
    );
    const dow = (start.getDay() + 6) % 7;
    task = {
      id: ri.id,
      title: `Review: ${parentTitle}`,
      type: "review",
      minutes: 15,
      weekIndex,
      dayOffsetInWeek: dow,
      description: parentLesson?.description
        ? `Re-engage with: ${parentLesson.description}`
        : `Pull up what you learned in "${parentTitle}" and rehearse the core idea.`,
      resourceRef: parentLesson?.resourceRef,
      dueAt: ri.dueAt.toISOString(),
      priority: "core",
    };
    reviewState = {
      rating: ri.rating,
      completed: ri.completedAt != null,
    };
  }

  const phases = sprout.phases || [];
  const phaseIdx = phaseForWeek(task.weekIndex, phases.length);
  const phaseName = phases[phaseIdx]?.name || "Phase";

  const initialResources: string[] = JSON.parse(
    plan.initialResources || "[]"
  ) as string[];
  const video = pickVideoFor(task, initialResources);

  const sortedTasks = [...tasks].sort(
    (a, b) => a.weekIndex - b.weekIndex || a.dayOffsetInWeek - b.dayOffsetInWeek
  );
  const taskIndex = sortedTasks.findIndex((t) => t.id === taskId);

  const reviewedLessons =
    task.type === "review"
      ? reviewParentLessonId
        ? tasks.filter((t) => t.id === reviewParentLessonId)
        : sortedTasks.filter(
            (t, i) =>
              i < taskIndex &&
              t.type === "lesson" &&
              phaseForWeek(t.weekIndex, phases.length) === phaseIdx
          )
      : [];
  const builtOn =
    task.type === "milestone" ? sortedTasks.filter((_, i) => i < taskIndex) : [];

  const [completion, journalEntry] = await Promise.all([
    isReview
      ? Promise.resolve(null)
      : prisma.taskCompletion.findUnique({
          where: { planId_taskId: { planId: id, taskId } },
        }),
    findTaskJournalByTask(id, taskId),
  ]);
  const initialDone = isReview
    ? Boolean(reviewState?.completed)
    : Boolean(completion?.completed);
  const initialRating = isReview
    ? reviewState?.rating && reviewState.rating >= 1
      ? reviewState.rating
      : 0
    : completion?.rating && completion.rating >= 1
      ? completion.rating
      : 0;

  const cueLines = resolveSuccessCriteria(task, parentLesson);
  const howSteps = resolveSteps(task, parentLesson);
  const objectiveBody = resolveObjective(task, parentLesson);
  const initialChatTurns = parseChatTurns(journalEntry?.chatJson ?? "[]");
  const initialDeepenCards = parseDeepenCards(journalEntry?.deepenJson ?? "[]");

  return (
    <Shell showHelper={false} showFooter={false}>
      <div
        className="session-shell"
        style={{
          padding: "12px 24px 16px",
          height: "calc(100vh - 64px)",
          minHeight: 600,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {/* prominent back + breadcrumb */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
            flexShrink: 0,
          }}
        >
          <Link
            href={`/plan/${id}`}
            className="btn"
            style={{ fontSize: 14, paddingLeft: 14, paddingRight: 16, gap: 8 }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>←</span>
            back to {plan.title}
          </Link>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--font-jetbrains)",
              fontSize: 12,
              color: "var(--ink-faded)",
            }}
          >
            <Link
              href="/dashboard"
              style={{ color: "inherit", textDecoration: "underline" }}
            >
              my garden
            </Link>
            <span>/</span>
            <Link
              href={`/plan/${id}`}
              style={{ color: "inherit", textDecoration: "underline" }}
            >
              {plan.title}
            </Link>
            <span>/</span>
            <span>{displayTitle(task.title, task.type)}</span>
          </div>
        </div>

        <div
          className="journal-edge session-three-col"
          style={{
            padding: "20px 24px",
            position: "relative",
          }}
        >
          <div
            className="tape"
            style={{ left: 32, top: -10, transform: "rotate(-4deg)" }}
          />

          {/* COL 1 — context: meta, title, video, fern's read, sprigs, journal */}
          <div className="session-col">
            <div
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <TypeBadge type={task.type} />
              <span className="chip">{phaseName}</span>
              <span className="chip moss">{task.minutes} min</span>
              {task.type === "milestone" && (
                <span className="chip sun">phase gate</span>
              )}
              {scheduledFor && (
                <span className="chip">
                  {new Intl.DateTimeFormat("en-US", {
                    timeZone: tz,
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: true,
                  })
                    .format(parseISO(scheduledFor.start))
                    .replace(", ", " · ")
                    .replace(" at ", " · ")}
                </span>
              )}
              {initialDone && <span className="chip moss">done ✓</span>}
            </div>

            <h1
              className="serif-display"
              style={{
                fontSize: 30,
                margin: 0,
                fontWeight: 400,
                letterSpacing: "-0.01em",
                lineHeight: 1.1,
              }}
            >
              {displayTitle(task.title, task.type)}
            </h1>
            <p
              style={{
                fontFamily: "var(--font-fraunces)",
                fontStyle: "italic",
                fontSize: 13,
                color: "var(--ink-soft)",
                margin: 0,
              }}
            >
              part of{" "}
              <Link
                href={`/plan/${id}`}
                style={{
                  color: "var(--moss-deep)",
                  textDecoration: "underline",
                }}
              >
                {plan.title}
              </Link>
            </p>

            <YouTubeBlock videoId={video.id} caption={video.caption} />

            <SessionControls
              planId={id}
              taskId={taskId}
              taskType={task.type}
              initialDone={initialDone}
              initialRating={initialRating}
            />

            <div
              className="ink-card soft"
              style={{ padding: 12, background: "var(--paper)" }}
            >
              <div className="tag" style={{ marginBottom: 4 }}>
                fern&apos;s read
              </div>
              <div
                style={{
                  fontFamily: "var(--font-fraunces)",
                  fontStyle: "italic",
                  fontSize: 13,
                  color: "var(--ink-soft)",
                  lineHeight: 1.45,
                }}
              >
                {fernReadFor(task.type)}
              </div>
            </div>

            {task.type === "lesson" && initialResources.length > 0 && (
              <div className="ink-card soft" style={{ padding: 10 }}>
                <div className="tag" style={{ marginBottom: 4 }}>
                  sprigs you brought
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  {initialResources.slice(0, 4).map((sp, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                      }}
                    >
                      <LeafSprig size={18} />
                      <div
                        style={{
                          fontFamily: "var(--font-fraunces)",
                          fontSize: 13,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {sp}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <JournalBox
              planId={id}
              taskId={taskId}
              taskType={task.type}
              initialBody={journalEntry?.body ?? ""}
              initialUpdatedAt={journalEntry?.updatedAt?.toISOString() ?? null}
            />
          </div>

          {/* COL 2 — the lesson itself */}
          <div className="session-col">
            {/* Objective: deliverable / goal / target. Top of col 2. */}
            <div
              className="ink-card"
              style={{
                padding: 16,
                background:
                  task.type === "milestone"
                    ? "var(--sun-soft)"
                    : task.type === "review"
                      ? "var(--sky-soft)"
                      : "var(--leaf-pale)",
              }}
            >
              <div className="tag" style={{ marginBottom: 4 }}>
                {objectiveLabelFor(task.type)}
              </div>
              <h3
                className="serif-display"
                style={{ fontSize: 18, margin: "0 0 6px", fontWeight: 500 }}
              >
                {objectiveTitleFor(task.type)}
              </h3>
              <p
                style={{
                  margin: 0,
                  fontFamily: "var(--font-fraunces)",
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: "var(--ink)",
                }}
              >
                {objectiveBody}
              </p>
            </div>

            <Section
              kicker="what it is"
              title="What"
              body={
                task.description ||
                `A ${task.minutes}-minute ${task.type} session in the ${phaseName} phase.`
              }
            />
            <Section
              kicker="why it matters"
              title="Why"
              body={whyCopyFor(task.type)}
            />

            <div>
              <div className="tag" style={{ marginBottom: 4 }}>
                how to do it
              </div>
              <h3
                className="serif-display"
                style={{ fontSize: 18, margin: "0 0 8px", fontWeight: 500 }}
              >
                How
              </h3>
              <ol
                style={{
                  margin: 0,
                  paddingLeft: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {howSteps.map((step, i) => (
                  <li
                    key={i}
                    className="ink-card soft"
                    style={{
                      padding: "8px 12px",
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                      background: "var(--paper-warm)",
                    }}
                  >
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        background: "var(--moss)",
                        color: "#f8f1de",
                        border: "1.5px solid var(--ink)",
                        display: "grid",
                        placeItems: "center",
                        flexShrink: 0,
                        fontFamily: "var(--font-fraunces)",
                        fontWeight: 600,
                        fontSize: 12,
                      }}
                    >
                      {i + 1}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-fraunces)",
                        fontSize: 14,
                        lineHeight: 1.4,
                        color: "var(--ink)",
                      }}
                    >
                      {step}
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            {cueLines.length > 0 && (
              <div
                className="ink-card"
                style={{ padding: 14, background: "var(--leaf-pale)" }}
              >
                <div className="tag" style={{ marginBottom: 6 }}>
                  what success feels like
                </div>
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 0,
                    listStyle: "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                  }}
                >
                  {cueLines.map((c, i) => (
                    <li
                      key={i}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                        fontFamily: "var(--font-fraunces)",
                        fontSize: 13,
                        lineHeight: 1.4,
                      }}
                    >
                      <span
                        style={{
                          marginTop: 5,
                          width: 6,
                          height: 6,
                          background: "var(--moss-deep)",
                          borderRadius: "50%",
                          flexShrink: 0,
                        }}
                      />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {task.type === "review" && reviewedLessons.length > 0 && (
              <div
                className="ink-card"
                style={{ padding: 14, background: "var(--sky-soft)" }}
              >
                <div className="tag" style={{ marginBottom: 6 }}>
                  reviewing these lessons
                </div>
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 6 }}
                >
                  {reviewedLessons.map((l) => (
                    <Link
                      key={l.id}
                      href={`/plan/${id}/session/${l.id}`}
                      className="ink-card soft"
                      style={{
                        padding: "8px 10px",
                        background: "var(--paper-warm)",
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        textDecoration: "none",
                        color: "inherit",
                      }}
                    >
                      <Sprout size={22} growth={0.55} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 500,
                            fontSize: 13,
                            fontFamily: "var(--font-fraunces)",
                          }}
                        >
                          {l.title}
                        </div>
                        <div
                          style={{
                            fontFamily: "var(--font-jetbrains)",
                            fontSize: 9,
                            color: "var(--ink-faded)",
                          }}
                        >
                          {l.minutes} min
                        </div>
                      </div>
                      <span
                        style={{ color: "var(--ink-faded)", fontSize: 13 }}
                      >
                        ›
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {task.type === "milestone" && builtOn.length > 0 && (
              <div
                className="ink-card"
                style={{ padding: 14, background: "var(--sun-soft)" }}
              >
                <div className="tag" style={{ marginBottom: 6 }}>
                  built on
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                    maxHeight: 280,
                    overflowY: "auto",
                  }}
                >
                  {builtOn.map((l, i) => (
                    <Link
                      key={l.id}
                      href={`/plan/${id}/session/${l.id}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "20px 1fr auto",
                        gap: 8,
                        alignItems: "center",
                        padding: "6px 8px",
                        background: "rgba(255,255,255,0.5)",
                        border: "1.25px dashed var(--ink-soft)",
                        borderRadius: 8,
                        textDecoration: "none",
                        color: "inherit",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-jetbrains)",
                          fontSize: 10,
                          color: "var(--ink-faded)",
                        }}
                      >
                        {i + 1}.
                      </span>
                      <div>
                        <div
                          style={{
                            fontFamily: "var(--font-fraunces)",
                            fontSize: 13,
                            fontWeight: 500,
                          }}
                        >
                          {l.title}
                        </div>
                        <div
                          style={{
                            fontFamily: "var(--font-jetbrains)",
                            fontSize: 9,
                            color: "var(--ink-faded)",
                          }}
                        >
                          {l.type}
                        </div>
                      </div>
                      <span
                        style={{ color: "var(--ink-faded)", fontSize: 13 }}
                      >
                        ›
                      </span>
                    </Link>
                  ))}
                </div>
                <div
                  style={{
                    marginTop: 8,
                    fontFamily: "var(--font-fraunces)",
                    fontStyle: "italic",
                    fontSize: 12,
                    color: "var(--ink-soft)",
                    lineHeight: 1.4,
                  }}
                >
                  Stuck on the milestone? The most reliable fix is going back
                  and re-running the weakest sessions above — not pushing
                  harder on the milestone itself.
                </div>
              </div>
            )}
          </div>

          {/* COL 3 — Fern's tutoring: deepen panel + chat */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              gap: 12,
            }}
          >
            <FernGuidanceColumn
              planId={id}
              taskId={taskId}
              taskTitle={displayTitle(task.title, task.type)}
              initialTurns={initialChatTurns}
              initialDeepenCards={initialDeepenCards}
            />
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Section({
  kicker,
  title,
  body,
}: {
  kicker: string;
  title: string;
  body: string;
}) {
  return (
    <div>
      <div className="tag" style={{ marginBottom: 4 }}>
        {kicker}
      </div>
      <h3
        className="serif-display"
        style={{ fontSize: 18, margin: "0 0 6px", fontWeight: 500 }}
      >
        {title}
      </h3>
      <p
        style={{
          margin: 0,
          fontFamily: "var(--font-fraunces)",
          fontSize: 14,
          lineHeight: 1.5,
          color: "var(--ink)",
        }}
      >
        {body}
      </p>
    </div>
  );
}

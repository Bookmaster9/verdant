import { auth } from "@/auth";
import { Shell } from "@/components/Shell";
import { loadPlanState } from "@/lib/load-plan-state";
import { prisma } from "@/lib/db";
import type { FernNote, ScheduledSession, SproutPlan, TaskType } from "@/types/plan";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { format, parseISO, differenceInCalendarDays } from "date-fns";
import { PlanActions } from "./PlanActions";
import { DeleteSproutButton } from "./DeleteSproutButton";
import { RoadAheadRow } from "./RoadAheadRow";
import { FernNotesSection } from "./FernNotesSection";
import { ConflictBanner } from "./ConflictBanner";
import { Sprout, ForestSprite, LeafSprig } from "@/components/verdant/art";
import { SectionTitle } from "@/components/verdant/SectionTitle";
import { StarRating } from "@/components/verdant/StarRating";
import { AiPlanDisclosure } from "@/components/verdant/AiPlanDisclosure";
import { displayTitle, phaseForWeek } from "@/lib/phase";

export default async function PlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const s = await auth();
  if (!s?.user?.id) {
    redirect("/login");
  }
  const { id } = await params;
  const state = await loadPlanState({
    planId: id,
    userId: s.user.id,
    accessToken: s.accessToken,
  });
  if (!state) {
    notFound();
  }
  const { plan, schedule, completions, conflicts } = state;
  const sprout: SproutPlan = JSON.parse(plan.planJson) as SproutPlan;
  const recs: string[] = JSON.parse(plan.recommendations || "[]") as string[];
  const done = new Set(
    completions.filter((c) => c.completed).map((c) => c.taskId)
  );
  const effByTask = Object.fromEntries(
    completions.map((c) => [c.taskId, c.rating])
  ) as Record<string, number | null | undefined>;

  const totalTasks = sprout.tasks?.length || schedule.length || 1;
  const doneCount = sprout.tasks?.filter((t) => done.has(t.id)).length || 0;
  const growth = Math.max(0.05, Math.min(1, doneCount / totalTasks));

  const now = new Date();
  const daysToBloom = Math.max(
    0,
    differenceInCalendarDays(new Date(plan.deadline), now)
  );

  const phases = sprout.phases || [];
  const phaseTaskCounts = phases.map((_, idx) => {
    const phaseTasks = (sprout.tasks || []).filter(
      (t) => phaseForWeek(t.weekIndex, phases.length) === idx
    );
    const phaseDone = phaseTasks.filter((t) => done.has(t.id)).length;
    return { total: phaseTasks.length, done: phaseDone };
  });
  const activePhase = (() => {
    const i = phaseTaskCounts.findIndex(
      (p) => p.done < p.total && p.total > 0
    );
    return i === -1 ? Math.max(0, phaseTaskCounts.length - 1) : i;
  })();

  // Status-based bucketing: a task is in the journal iff the user committed it
  // (rated + marked done). Everything else lives in to-do, including past-but-
  // unmarked sessions. The schedule timeline is the *display* axis, not the
  // ownership axis — completion status alone decides the bucket.
  const reviewInstances = await prisma.reviewInstance.findMany({
    where: { planId: id },
    include: { lessonState: true },
  });
  const reviewCompletedIds = new Set(
    reviewInstances.filter((r) => r.completedAt != null).map((r) => r.id)
  );

  function entryTaskIds(row: ScheduledSession): string[] {
    if (row.agenda && row.agenda.length > 0) {
      return row.agenda.map((a) => a.planTaskId);
    }
    return [row.planTaskId];
  }
  function isEntryCompleted(row: ScheduledSession): boolean {
    return entryTaskIds(row).every(
      (tid) => done.has(tid) || reviewCompletedIds.has(tid)
    );
  }

  type ToDoRow = {
    id: string;
    title: string;
    type: TaskType;
    start: Date;
    end: Date;
    primaryTaskId: string;
    isOverdue: boolean;
    rating: number;
  };

  const toDo: ToDoRow[] = schedule
    .filter((row) => !isEntryCompleted(row))
    .map((row) => {
      const primaryTaskId =
        row.agenda && row.agenda.length > 0
          ? row.agenda[0].planTaskId
          : row.planTaskId;
      const start = parseISO(row.start);
      const end = parseISO(row.end);
      return {
        id: row.id,
        title: row.title,
        type: row.type,
        start,
        end,
        primaryTaskId,
        isOverdue: end < now,
        rating: effByTask[primaryTaskId] || 0,
      };
    })
    .sort((a, b) => {
      // Overdue first, then chronological
      if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
      return a.start.getTime() - b.start.getTime();
    });

  // Journal sources from completion records, not schedule entries — completed
  // future tasks have their schedule entry removed (slot freed) but the journal
  // entry persists. This is the rule "tasks always live in one bucket."
  type JournalRow = {
    key: string;
    taskId: string; // for href
    title: string;
    type: TaskType;
    completedAt: Date | null;
    scheduledStart: Date | null;
    rating: number;
  };
  const journal: JournalRow[] = [];
  // Lessons + milestones
  for (const c of completions) {
    if (!c.completed) continue;
    const t = (sprout.tasks ?? []).find((x) => x.id === c.taskId);
    if (!t) continue;
    const sess = schedule.find(
      (row) =>
        row.planTaskId === c.taskId ||
        row.agenda?.some((a) => a.planTaskId === c.taskId)
    );
    journal.push({
      key: `c-${c.id}`,
      taskId: c.taskId,
      title: t.title,
      type: t.type,
      completedAt: c.completedAt,
      scheduledStart: sess ? parseISO(sess.start) : null,
      rating: c.rating ?? 0,
    });
  }
  // Reviews
  for (const ri of reviewInstances) {
    if (!ri.completedAt) continue;
    const parent = (sprout.tasks ?? []).find((t) => t.id === ri.lessonState.lessonId);
    const title = `Review: ${parent?.title ?? "lesson"}`;
    const sess = schedule.find(
      (row) =>
        row.planTaskId === ri.id ||
        row.agenda?.some((a) => a.planTaskId === ri.id)
    );
    journal.push({
      key: `r-${ri.id}`,
      taskId: ri.id,
      title,
      type: "review",
      completedAt: ri.completedAt,
      scheduledStart: sess ? parseISO(sess.start) : null,
      rating: ri.rating ?? 0,
    });
  }
  journal.sort((a, b) => {
    const ad = a.completedAt?.getTime() ?? 0;
    const bd = b.completedAt?.getTime() ?? 0;
    return bd - ad; // most recent first
  });

  const initialResources: string[] = JSON.parse(
    plan.initialResources || "[]"
  ) as string[];

  // Fern's notes — persisted on LearningPlan, AI-authored.
  // The client component below auto-generates the first batch on view.
  const fernNotes = JSON.parse(plan.fernNotes || "[]") as FernNote[];

  return (
    <Shell>
      <div style={{ padding: "12px 36px 60px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 14,
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
          <span>{plan.title}</span>
        </div>

        <div className="journal-edge" style={{ padding: 32, position: "relative" }}>
          <div
            className="tape"
            style={{ left: 32, top: -10, transform: "rotate(-4deg)" }}
          />
          <div
            className="tape"
            style={{ right: 60, top: -10, transform: "rotate(3deg)" }}
          />

          {/* hero */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "240px 1fr 220px",
              gap: 32,
              alignItems: "center",
              marginBottom: 24,
            }}
          >
            <div
              style={{
                background:
                  "linear-gradient(180deg, var(--sky-soft) 0%, var(--paper-warm) 70%)",
                border: "1.5px solid var(--ink)",
                borderRadius: 16,
                padding: 18,
                position: "relative",
                height: 220,
              }}
            >
              <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
                <div className="sway">
                  <Sprout
                    size={170}
                    growth={growth}
                    mood={growth < 0.2 ? "sleepy" : "happy"}
                  />
                </div>
              </div>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 16,
                  background: "var(--soil)",
                  borderTop: "1.5px solid var(--ink)",
                  borderRadius: "0 0 14px 14px",
                }}
              />
            </div>
            <div>
              <div className="tag" style={{ marginBottom: 6 }}>
                sprout · started {format(new Date(plan.createdAt), "MMM d")}
              </div>
              <h1
                className="serif-display"
                style={{
                  fontSize: 48,
                  margin: "0 0 8px",
                  fontWeight: 400,
                  letterSpacing: "-0.01em",
                }}
              >
                {plan.title}
              </h1>
              <p
                style={{
                  fontSize: 17,
                  color: "var(--ink-soft)",
                  lineHeight: 1.5,
                  margin: "0 0 14px",
                  maxWidth: 560,
                }}
              >
                {sprout.summary}
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span className="chip moss">{Math.round(growth * 100)}% grown</span>
                <span className="chip">{daysToBloom} days to bloom</span>
                <span className="chip">
                  {doneCount} of {totalTasks} sessions
                </span>
                <span className="chip sun">
                  due {format(new Date(plan.deadline), "MMM d")}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Link href="/plan/new" className="btn primary">
                + new sprout
              </Link>
              <Link href="/settings" className="btn">
                tend the soil
              </Link>
              <DeleteSproutButton planId={id} title={plan.title} />
            </div>
          </div>

          {/* AI plan response — toggle dropdown with click-through tabs */}
          <AiPlanDisclosure sprout={sprout} />

          {/* FERN'S NOTES — AI-authored, persisted, lazy-generated on first view */}
          <FernNotesSection
            planId={id}
            initialNotes={fernNotes}
            initialGeneratedAt={
              plan.fernNotesGeneratedAt
                ? plan.fernNotesGeneratedAt.toISOString()
                : null
            }
          />

          {/* phase trail */}
          {phases.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <SectionTitle kicker="growth phases">The trail to bloom</SectionTitle>
              <div style={{ position: "relative", paddingTop: 16 }}>
                <svg
                  style={{
                    position: "absolute",
                    top: 28,
                    left: 40,
                    right: 40,
                    width: "calc(100% - 80px)",
                    height: 8,
                    zIndex: 0,
                  }}
                  preserveAspectRatio="none"
                  viewBox="0 0 1000 8"
                >
                  <path
                    d="M0 4 Q 250 -2, 500 4 T 1000 4"
                    stroke="var(--moss)"
                    strokeWidth="2.5"
                    strokeDasharray="6 6"
                    fill="none"
                  />
                </svg>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${phases.length}, 1fr)`,
                    gap: 16,
                    position: "relative",
                    zIndex: 1,
                  }}
                >
                  {phases.map((p, i) => {
                    const phaseDone =
                      phaseTaskCounts[i].done >= phaseTaskCounts[i].total &&
                      phaseTaskCounts[i].total > 0;
                    const isActive = i === activePhase && !phaseDone;
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            width: 56,
                            height: 56,
                            borderRadius: "50%",
                            background: phaseDone
                              ? "var(--moss)"
                              : isActive
                                ? "var(--sun)"
                                : "var(--paper-warm)",
                            border: "1.5px solid var(--ink)",
                            display: "grid",
                            placeItems: "center",
                            boxShadow: "2px 2px 0 var(--ink)",
                          }}
                        >
                          {phaseDone ? (
                            <span style={{ color: "#f8f1de", fontSize: 24 }}>
                              ✓
                            </span>
                          ) : isActive ? (
                            <Sprout size={42} growth={0.5} />
                          ) : (
                            <span
                              style={{
                                fontFamily: "var(--font-fraunces)",
                                fontWeight: 600,
                                fontSize: 18,
                              }}
                            >
                              {i + 1}
                            </span>
                          )}
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div
                            style={{
                              fontFamily: "var(--font-fraunces)",
                              fontWeight: 500,
                              fontSize: 16,
                            }}
                          >
                            {p.name}
                          </div>
                          <div
                            style={{
                              fontFamily: "var(--font-fraunces)",
                              fontStyle: "italic",
                              fontSize: 13,
                              color: "var(--ink-faded)",
                              lineHeight: 1.3,
                              marginTop: 2,
                              maxWidth: 200,
                            }}
                          >
                            {p.focus}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr 1fr",
              gap: 28,
            }}
          >
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 10,
                }}
              >
                <h3
                  className="serif-display"
                  style={{ fontSize: 24, margin: 0, fontWeight: 500 }}
                >
                  The road ahead
                </h3>
                <span
                  style={{
                    fontFamily: "var(--font-jetbrains)",
                    fontSize: 11,
                    color: "var(--ink-faded)",
                  }}
                >
                  {toDo.length} to do · click to open
                </span>
              </div>
              {toDo.length === 0 ? (
                <div
                  className="dotted"
                  style={{
                    padding: 24,
                    textAlign: "center",
                    color: "var(--ink-faded)",
                    fontFamily: "var(--font-fraunces)",
                    fontStyle: "italic",
                  }}
                >
                  to-do is empty — everything tended.
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    position: "relative",
                  }}
                >
                  {/* dashed moss vine running down the timeline */}
                  <div
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: 22,
                      top: 30,
                      bottom: 30,
                      width: 0,
                      borderLeft: "2.5px dashed var(--moss)",
                      opacity: 0.5,
                      zIndex: 0,
                    }}
                  />
                  {toDo.map((row) => (
                    <Link
                      key={row.id}
                      href={`/plan/${id}/session/${row.primaryTaskId}`}
                      style={{
                        display: "flex",
                        alignItems: "stretch",
                        gap: 14,
                        position: "relative",
                        textDecoration: "none",
                        color: "inherit",
                      }}
                    >
                      <div
                        style={{
                          width: 44,
                          height: 44,
                          borderRadius: "50%",
                          background: row.isOverdue
                            ? "#f3cbc1"
                            : "var(--paper-warm)",
                          border: row.isOverdue
                            ? "1.5px solid var(--berry)"
                            : "1.5px solid var(--ink)",
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                          zIndex: 2,
                          fontFamily: "var(--font-jetbrains)",
                          fontSize: 11,
                          alignSelf: "center",
                        }}
                      >
                        <div style={{ textAlign: "center", lineHeight: 1.1 }}>
                          <div style={{ fontWeight: 600 }}>
                            {format(row.start, "EEE")}
                          </div>
                          <div style={{ color: "var(--ink-faded)" }}>
                            {format(row.start, "HH:mm")}
                          </div>
                        </div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <RoadAheadRow
                          title={row.title}
                          type={row.type}
                          rating={row.rating}
                          done={false}
                          overdue={row.isOverdue}
                        />
                      </div>
                    </Link>
                  ))}
                </div>
              )}

              <ConflictBanner
                planId={id}
                conflicts={conflicts.lockedConflicts.map((c) => ({
                  sessionId: c.session.id,
                  sessionTitle: c.session.title,
                  sessionStart: c.session.start,
                  sessionEnd: c.session.end,
                  overlappingCount: c.overlapping.length,
                }))}
              />
              <PlanActions planId={id} hasPrevPlan={!!plan.planJsonPrev} />
            </div>

            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 10,
                }}
              >
                <h3
                  className="serif-display"
                  style={{ fontSize: 24, margin: 0, fontWeight: 500 }}
                >
                  The journal so far
                </h3>
                <span
                  style={{
                    fontFamily: "var(--font-jetbrains)",
                    fontSize: 11,
                    color: "var(--ink-faded)",
                  }}
                >
                  {journal.length} entries · scroll
                </span>
              </div>
              <div
                className="ink-card soft scroll-area"
                style={{
                  padding: "6px 14px",
                  background: "var(--paper)",
                  maxHeight: 360,
                  overflowY: "auto",
                  backgroundImage:
                    "repeating-linear-gradient(0deg, transparent 0, transparent 36px, rgba(43,36,24,0.04) 36px, rgba(43,36,24,0.04) 37px)",
                }}
              >
                {journal.length === 0 ? (
                  <p
                    style={{
                      fontFamily: "var(--font-fraunces)",
                      fontStyle: "italic",
                      color: "var(--ink-faded)",
                      margin: "16px 0",
                      fontSize: 14,
                    }}
                  >
                    nothing tended yet — your first entry will land here.
                  </p>
                ) : (
                  journal.map((row, i, arr) => (
                    <Link
                      key={row.key}
                      href={`/plan/${id}/session/${row.taskId}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "60px 1fr auto 14px",
                        gap: 10,
                        alignItems: "center",
                        padding: "10px 0",
                        borderBottom:
                          i < arr.length - 1
                            ? "1.25px dashed var(--ink-soft)"
                            : "none",
                        textDecoration: "none",
                        color: "inherit",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "var(--font-jetbrains)",
                          fontSize: 11,
                          color: "var(--ink-faded)",
                        }}
                      >
                        {row.completedAt
                          ? format(row.completedAt, "MMM d")
                          : row.scheduledStart
                            ? format(row.scheduledStart, "MMM d")
                            : "—"}
                      </div>
                      <div
                        style={{
                          fontFamily: "var(--font-fraunces)",
                          fontSize: 15,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {displayTitle(row.title, row.type)}
                      </div>
                      <StarRating value={row.rating || 0} size={16} />
                      <span
                        style={{
                          color: "var(--ink-faded)",
                          fontSize: 14,
                        }}
                      >
                        ›
                      </span>
                    </Link>
                  ))
                )}
              </div>

              {initialResources.length > 0 && (
                <>
                  <h3
                    className="serif-display"
                    style={{ fontSize: 22, margin: "22px 0 10px", fontWeight: 500 }}
                  >
                    Sprigs you brought
                  </h3>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    {initialResources.map((r, i) => (
                      <div
                        key={i}
                        className="ink-card soft"
                        style={{
                          padding: "10px 12px",
                          display: "flex",
                          gap: 10,
                          alignItems: "center",
                        }}
                      >
                        <LeafSprig size={36} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 500,
                              fontSize: 14,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {r}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {recs.length > 0 && (
                <div
                  className="ink-card"
                  style={{
                    padding: 16,
                    marginTop: 22,
                    background: "var(--leaf-pale)",
                    position: "relative",
                  }}
                >
                  <div style={{ position: "absolute", left: -10, top: -16 }}>
                    <ForestSprite size={56} />
                  </div>
                  <div style={{ paddingLeft: 50 }}>
                    <div className="tag" style={{ marginBottom: 4 }}>
                      fern&apos;s suggested resources
                    </div>
                    <ul
                      style={{
                        margin: 0,
                        paddingLeft: 18,
                        fontFamily: "var(--font-fraunces)",
                        fontSize: 14,
                        lineHeight: 1.5,
                        color: "var(--ink)",
                      }}
                    >
                      {recs.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}


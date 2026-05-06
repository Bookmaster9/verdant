import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export type TaskJournalRecord = {
  id: string;
  planId: string;
  taskId: string;
  body: string;
  chatJson: string;
  deepenJson: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * `TaskJournal` exists in schema.prisma but the generated client only updates after
 * `npx prisma generate`. On Windows, a running `next dev` can lock the query engine
 * and block generate — then `prisma.taskJournal` is missing at runtime.
 */
export function getTaskJournalDelegate(): unknown {
  return (prisma as unknown as { taskJournal?: unknown }).taskJournal;
}

/** Use when a route must write journal rows — returns 503 if the client wasn’t generated. */
export function taskJournalUnavailable(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Database client is out of date. Stop the dev server, run `npx prisma generate`, then start again.",
    },
    { status: 503 }
  );
}

export async function findTaskJournalByTask(
  planId: string,
  taskId: string
): Promise<TaskJournalRecord | null> {
  const tj = getTaskJournalDelegate() as
    | {
        findUnique(args: {
          where: { planId_taskId: { planId: string; taskId: string } };
        }): Promise<TaskJournalRecord | null>;
      }
    | undefined;
  if (!tj) return null;
  return tj.findUnique({
    where: { planId_taskId: { planId, taskId } },
  });
}

import { redirect } from "next/navigation";

/**
 * Legacy route. The "completed task" view used to live here, but it diverged
 * badly from the session detail page — same task, different layout, missing
 * the what / why / how / success criteria / journal box content. We now render
 * everything on /plan/[id]/session/[taskId] regardless of done state (the
 * SessionControls block flips to "in your journal" when completed). This route
 * is kept as a redirect so any old bookmarks or in-flight links still resolve.
 */
export default async function LegacyJournalEntryPage({
  params,
}: {
  params: Promise<{ id: string; taskId: string }>;
}) {
  const { id, taskId } = await params;
  redirect(`/plan/${id}/session/${taskId}`);
}

import { auth } from "@/auth";
import { Shell } from "@/components/Shell";
import { NewPlanForm } from "./plan-form";
import { redirect } from "next/navigation";
import { ensureUserPreferences } from "@/lib/user";

export default async function NewPlanPage() {
  const s = await auth();
  if (!s?.user?.id) {
    redirect("/login");
  }
  const pref = await ensureUserPreferences(s.user.id);
  // Onboarding modal gates the form for first-time users only. Once dismissed
  // (either path), `onboardedAt` is set and never re-prompts.
  return (
    <Shell>
      <NewPlanForm
        showOnboarding={pref.onboardedAt == null}
        initialTimeWindowsJson={pref.timeWindows}
        initialMaxMinutesDay={pref.maxMinutesDay}
        initialPushToCalendar={pref.pushToCalendar}
        initialHourUtilityJson={pref.hourUtility}
      />
    </Shell>
  );
}

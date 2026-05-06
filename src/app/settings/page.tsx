import { auth } from "@/auth";
import { Shell } from "@/components/Shell";
import { ensureUserPreferences } from "@/lib/user";
import { DEFAULT_TIME_WINDOWS } from "@/lib/default-preferences";
import { prisma } from "@/lib/db";
import { parsePlacementRules } from "@/lib/placement-rules";
import { redirect } from "next/navigation";
import { SettingsForm } from "./SettingsForm";
import {
  PersistentRulesSection,
  type PlanRulesGroup,
} from "@/components/verdant/PersistentRulesSection";
import { SectionTitle } from "@/components/verdant/SectionTitle";

export default async function SettingsPage() {
  const s = await auth();
  if (!s?.user?.id) {
    redirect("/login");
  }
  const [pref, plans] = await Promise.all([
    ensureUserPreferences(s.user.id),
    prisma.learningPlan.findMany({
      where: { userId: s.user.id },
      select: { id: true, title: true, placementRules: true, status: true, deadline: true },
      orderBy: { deadline: "asc" },
    }),
  ]);
  const ruleGroups: PlanRulesGroup[] = plans
    .map((p) => ({
      planId: p.id,
      planTitle: p.title,
      rules: parsePlacementRules(p.placementRules),
    }))
    .filter((g) => g.rules.length > 0);

  return (
    <Shell>
      <div style={{ padding: "12px 36px 60px", display: "grid", placeItems: "start center" }}>
        <div style={{ width: "min(920px, 100%)" }}>
          <SectionTitle kicker="settings">Tend the soil</SectionTitle>
          <p
            style={{
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              fontSize: 14,
              color: "var(--ink-faded)",
              margin: "0 0 22px",
            }}
          >
            time windows and the daily cap shape every plan we plot.
          </p>
          <SettingsForm
            maxMinutesDay={pref.maxMinutesDay}
            weeklyMinutesTarget={pref.weeklyMinutesTarget}
            pushToCalendar={pref.pushToCalendar}
            timeWindows={pref.timeWindows}
            defaultJson={JSON.stringify(DEFAULT_TIME_WINDOWS, null, 2)}
            userEmail={s.user.email}
          />
          <div style={{ marginTop: 22 }}>
            <PersistentRulesSection groups={ruleGroups} />
          </div>
        </div>
      </div>
    </Shell>
  );
}

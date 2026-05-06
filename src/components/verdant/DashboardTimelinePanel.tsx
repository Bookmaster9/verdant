"use client";

import { useState } from "react";
import {
  TodayTimeline,
  type TimelineEvent,
} from "@/components/verdant/TodayTimeline";
import { ConflictResolveModal } from "@/components/verdant/ConflictResolveModal";

export function DashboardTimelinePanel({
  events,
  nowMinutes,
  upNext,
  calendarConnected,
}: {
  events: TimelineEvent[];
  nowMinutes: number;
  upNext?: TimelineEvent;
  calendarConnected: boolean;
}) {
  const [modal, setModal] = useState<{
    planId: string;
    sessionId: string;
    title: string;
  } | null>(null);

  return (
    <>
      <TodayTimeline
        events={events}
        nowMinutes={nowMinutes}
        upNext={upNext}
        calendarConnected={calendarConnected}
        onConflictSession={(e) => {
          if (!e.planId) return;
          setModal({
            planId: e.planId,
            sessionId: e.id,
            title: e.title,
          });
        }}
      />
      <ConflictResolveModal
        open={modal !== null}
        onClose={() => setModal(null)}
        planId={modal?.planId ?? ""}
        sessionId={modal?.sessionId ?? ""}
        sessionTitle={modal?.title ?? ""}
      />
    </>
  );
}

import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { defaultTimeWindowsJson } from "@/lib/default-preferences";
import { ensureUserPreferences } from "@/lib/user";
import { NextResponse } from "next/server";
import { z } from "zod";

const patch = z.object({
  // Each weekday key (0-6, Date.getDay() semantics) maps to zero or more
  // {start, end} ranges. The heatmap UI always sends the array shape.
  timeWindows: z
    .record(
      z.string(),
      z.array(z.object({ start: z.string(), end: z.string() }))
    )
    .optional(),
  // Slider in the settings form goes 15..180; keep the validator floor in
  // sync so the API doesn't silently reject the lower notches of the slider.
  maxMinutesDay: z.number().min(15).max(300).optional(),
  weeklyMinutesTarget: z.number().int().min(30).max(3000).nullable().optional(),
  pushToCalendar: z.boolean().optional(),
  /** Dashboard sprout sort mode. Dragging tiles client-side flips this to "custom". */
  sproutSortMode: z.enum(["deadline", "created", "custom"]).optional(),
  /** Custom-mode reorder. Plan IDs in display order; missing IDs sort to end. */
  sproutCustomOrder: z.array(z.string()).optional(),
  /** Onboarding completion stamp. The modal sends `true` to record "now"; we
   *  never accept a client-supplied date. Once set, never re-prompts. */
  onboardedNow: z.boolean().optional(),
  /** IANA tz from the browser (e.g. "America/New_York"). Posted on shell
   *  mount whenever it differs from the persisted value. */
  userTimeZone: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_+\-/]+$/)
    .optional(),
});

export async function GET() {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pref = await ensureUserPreferences(s.user.id);
  return NextResponse.json(pref);
}

export async function PATCH(request: Request) {
  const s = await auth();
  if (!s?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const b = await request.json().catch(() => ({}));
  const p = patch.safeParse(b);
  if (!p.success) {
    return NextResponse.json({ error: p.error.message }, { status: 400 });
  }
  const data: Record<string, string | number | boolean | null> = {};
  if (p.data.timeWindows) {
    data.timeWindows = JSON.stringify(p.data.timeWindows);
  }
  if (p.data.maxMinutesDay !== undefined) {
    data.maxMinutesDay = p.data.maxMinutesDay;
  }
  if (p.data.weeklyMinutesTarget !== undefined) {
    data.weeklyMinutesTarget = p.data.weeklyMinutesTarget;
  }
  if (p.data.pushToCalendar !== undefined) {
    data.pushToCalendar = p.data.pushToCalendar;
  }
  if (p.data.sproutSortMode !== undefined) {
    data.sproutSortMode = p.data.sproutSortMode;
  }
  if (p.data.sproutCustomOrder !== undefined) {
    data.sproutCustomOrder = JSON.stringify(p.data.sproutCustomOrder);
  }
  if (p.data.onboardedNow === true) {
    data.onboardedAt = new Date().toISOString();
  }
  if (p.data.userTimeZone !== undefined) {
    data.userTimeZone = p.data.userTimeZone;
  }
  const pref = await prisma.userPreference.upsert({
    where: { userId: s.user.id },
    create: {
      userId: s.user.id,
      timeWindows: p.data.timeWindows
        ? JSON.stringify(p.data.timeWindows)
        : defaultTimeWindowsJson(),
      maxMinutesDay: p.data.maxMinutesDay ?? 90,
    },
    update: data,
  });
  return NextResponse.json(pref);
}

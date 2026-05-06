# todo

Running list of follow-ups flagged during design implementation. Add new items at the bottom of the relevant section. Strike through (`~~item~~`) once shipped.

## Bugs / correctness

- [ ] **Schedule silently drops tasks that don't fit before the deadline.**
  When the AI returns more tasks than fit in the window (case in point: a 6-task plan with a 5-day deadline + 30 min/day cap dropped the milestone), `buildScheduleFromPlan` just returns the partial schedule with no signal. Surface a "N task(s) could not be placed before your deadline" warning on the tend page (or block plan creation when more than X tasks won't fit).
- [ ] **`buildScheduleFromPlan` ignores `dayOffsetInWeek`.**
  It sorts tasks by `type` first (`lesson < review < milestone`), then `id.localeCompare`, then packs day-by-day. The AI's intended week + day placement gets thrown away — all lessons end up scheduled before any review. Either honor `weekIndex` + `dayOffsetInWeek` directly, or sort tasks by `(weekIndex * 7 + dayOffsetInWeek)` before bucketing.

## AI plan / Fern notes

- [ ] **Backfill the new `SproutPlan` fields for existing plans.**
  Plans created before the prompt change have no `rationale` / `weeklyShape` / `sessionsPlanned`, so the AI Plan disclosure on the tend page shows an empty / sparse panel for them. Either add a one-shot script (`scripts/backfill-ai-plan.ts`) that re-runs `generatePlanWithAI` for old plans and merges the new fields into `planJson`, or add a "regenerate plan" button on the tend page.
- [ ] **Auto-refresh Fern notes after major plan changes.**
  Notes are stale after a rebalance, NL edit, or a fresh batch of completions. Bust the `fernNotes` cache (or call `POST /api/plans/[id]/fern-notes`) from the relevant PATCH paths, or expose a "refresh after edit" trigger. Currently only the manual `↻ refresh` button on the section updates them.
- [ ] **Add a "tasks" tab to `AiPlanDisclosure`.**
  Users (and we, when debugging) sometimes want to see the full raw task list — title / type / minutes / weekIndex / dayOffsetInWeek / description / resourceRef — without leaving the tend page. Easy debugging surface.

## Tooling / DX

- [ ] **Add `tsx` to devDependencies.**
  `scripts/test-sprout-prompt.ts` runs via `npx tsx ...` which installs on first call. Pinning it as a dev dep makes the test loop reproducible.
- [ ] **Pre-existing lint debt blocks `next build`.**
  `src/lib/generate-sprout.ts` and `src/lib/time-windows.ts` had `@typescript-eslint/no-unused-vars` / `prefer-const` errors before this branch. They still trip `next build`. Untouched here to keep diffs scoped — sweep them when convenient.
- [ ] **`src/auth.ts` reports a TS2664 augmentation error from `next-auth/jwt`.**
  Pre-existing, doesn't affect runtime. Probably resolved by a `next-auth` v5 upgrade — worth checking next time the dependency is bumped.

## UX polish

- [ ] **Default daily cap of 30 min/day is too tight for most generated plans.**
  The AI tends to suggest 30–60 min sessions; with a 30-min cap they get clamped silently. Either raise the default in `lib/default-preferences.ts`, prompt the user during sprout creation, or warn at plan-time when many sessions exceed the cap.
- [ ] **YouTube embeds: confirm Shorts URLs render in 16:9 cleanly.**
  The `/shorts/<id>` regex now extracts the ID, but Shorts are vertical — the 16:9 iframe will letterbox. Consider detecting Shorts and switching to a portrait aspect ratio for those.

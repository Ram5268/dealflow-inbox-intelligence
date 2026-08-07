# DealFlow — Bug Triage

Buckets:
- **PRE_WIPE** — must be fixed before any destructive DB wipe / re-extract.
- **PRE_LIVE** — must be fixed before the real inbox goes live to the user.
- **ITERATE** — improve opportunistically; not blocking.
- **FIXED** — resolved; kept for traceability.

## PRE_WIPE
_(none open)_

## PRE_LIVE
_(none open)_

## ITERATE

- **Cross-turn verifier grounding — verifier only sees the current turn's
  `tool_results`.** In a multi-turn chat, a reference to a listing surfaced in an
  earlier turn (e.g. Turn 1 lists "461 6th St at $1.75M", Turn 2 does a party
  search and mentions it) can be flagged as ungrounded by the Sonnet verifier,
  because the verifier is scoped to the *current* turn's tool output only. Benign
  today: it triggers one informed retry, self-corrects, does NOT fall back to
  canned, and returns the correct answer (observed on Gate 3 Flow A T2). Consider
  feeding prior-turn `tool_results` into the verifier grounding in Brief 6+ to
  eliminate the extra retry. — logged 2026-08-07 (Brief 5.1.2 Gate 3).

- **parseQuery kept for side-channel wiring (Brief 3 decision).** The Haiku
  tool_use loop replaced the old rigid-SQL retrieval pipeline, so `runRetrieval`
  (`lib/retrieval/index.ts`) is now dead code with no importers. But `parseQuery`
  (`lib/retrieval/queryParser.ts`) and the `ParsedQuery` type are still live —
  `app/api/chat/route.ts` calls `parseQuery` to feed composeContext's
  mortgage/ACRIS/DOB/calendar/matches side-channels. So the `lib/retrieval`
  module can't be deleted yet. Revisit (delete `queryParser.ts` + `index.ts`)
  when composeContext is refactored off `ParsedQuery`. Header comment added to
  `queryParser.ts`. — logged 2026-08-06 (Brief 4.0 Step 4).

- **REMINDER: re-enable the StreetEasy sync when connecting real Microsoft auth.**
  During seed-only trial mode the StreetEasy status sweep was *paused* via
  `STREETEASY_SYNC_ENABLED=false` in `.env` — with no real inbox flow it had no
  legitimate work and was marking seed test rows `stale` (draining the demo
  inventory; e.g. the West Village 2BR went stale between smoke tests). When real
  Microsoft auth + inbox flow goes live, flip `STREETEASY_SYNC_ENABLED` back to
  `true`. Also decide at that point whether to add an `isTestData` guard to the
  sweep (the proper long-term fix) so real + seed test data can coexist safely
  without the sweep draining the test rows. — logged 2026-08-05 (Brief 3.0 follow-up).

- **Calendar READ during chat returns "no context" when the Outlook fetch fails.**
  The chat surface has a calendar-confirm WRITE fast-path (propose → "confirm" →
  `createCalendarEvent`), but no way for Haiku to actively *read* the schedule —
  it only sees whatever the `calendarFetcher` side-channel injects, and answers
  "I can't access your calendar" when that fetch is empty/fails. Consider adding
  a dedicated `get_calendar_events` tool in a future brief so Haiku can query the
  calendar the same way it queries listings/parties. Distinct from the existing
  calendar-confirm WRITE fast-path. — logged 2026-08-05 (Brief 3.0).

## FIXED

- **`bedsScore` treated studios (`beds = 0`) as unknown.** `bedsScore()` started
  with `if (!listingBeds || !isoBeds) return 5` — because `0` is falsy, an exact
  studio↔studio match scored **5** (unknown-credit) instead of full credit
  (**20**); worse, a studio *listing* scored 5 against ANY demand (a 2BR seeker
  was indistinguishable from a studio seeker). **Fixed** in Brief 3.0 Step 4:
  extracted the function to `lib/matching/bedsScore.ts` (pure, unit-testable) and
  switched the guard to `== null` so a real `0` scores on its own merits.
  Verified on seed data: Lauren Park (studio) ↔ SEED_RENT_02 (Midtown studio
  $2,800) went **75 → 90**; a 2BR-seeker vs the same studio dropped to **70**, so
  the studio-seeker now correctly out-scores the mismatch. 6 unit tests added to
  `lib/matching/priceOverlap.test.ts`. — fixed 2026-08-05 (Brief 3.0, commit 2e64c31).

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
  `lib/matching/priceOverlap.test.ts`. — fixed 2026-08-05 (Brief 3.0, commit 33aa1b2).

# DealFlow — Bug Triage

Buckets:
- **PRE_WIPE** — must be fixed before any destructive DB wipe / re-extract.
- **PRE_LIVE** — must be fixed before the real inbox goes live to the user.
- **ITERATE** — improve opportunistically; not blocking.

## PRE_WIPE
_(none open)_

## PRE_LIVE
_(none open)_

## ITERATE

- **`bedsScore` treats studios (`beds = 0`) as unknown.** In `lib/matchmaking.ts`,
  `bedsScore()` starts with `if (!listingBeds || !isoBeds) return 5` — because `0`
  is falsy, an exact studio↔studio match scores **5** (the "unknown" credit)
  instead of full credit (**20**). Surfaced by the Brief 2.5 seed-match eval:
  studio "perfect" matches land at **75** instead of 90. Real issue for Manhattan
  rentals (heavy studio inventory). Fix: distinguish `null`/`undefined` from `0`
  (e.g. `== null` checks) so a real 0-bed value scores on its own merits.
  — logged 2026-08-05 (Brief 2.5).

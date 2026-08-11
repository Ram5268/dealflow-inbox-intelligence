// Flag posture for prod (Brief 8.0-lite Fix #3c):
//   TEST_MODE_ONLY=false             — Mojo counterparts hydrate in drafts/schedule
//   MATCHING_TEST_MODE_ONLY=false    — matcher writes Match rows against live data
//   INGESTION_TEST_MODE_ONLY=false   — webhook accepts real Zapier POSTs
// Any other combo = dev/audit mode; downstream behavior is best-effort, not supported.
//
// Brief 7.0 — isolation gate for the matching engine, the analog of Brief 6.0's
// INGESTION_TEST_MODE_ONLY (extraction) and Brief 5.0's TEST_MODE_ONLY (chat/reads).
//
// While the matching engine is being validated against the hand-crafted fixture
// set (test/fixtures/matches/), NO production trigger path may fire a match run.
// Brief 7.0 deliberately builds NO such triggers — the engine is a callable
// library that only the fixture harness invokes. This flag exists so that when
// Brief 7.2 wires the real production triggers (a webhook that fires on new
// supply arrival, a nightly re-scan cron), each of those entry points can gate
// itself behind !isMatchingTestModeOnly() and early-return / 423 while the flag
// is on.
//
// This does NOT block the engine's pure, callable form: findMatchesForListing /
// findMatchesForParty are library functions the harness calls directly against
// isTestData rows, so fixture runs stay isolated and cannot fire on real data.
//
// Flip to false (or delete the .env line) once real Mojo sync + production
// triggers exist and are meant to run. Independent of the other two gates.
export function isMatchingTestModeOnly(): boolean {
  return process.env.MATCHING_TEST_MODE_ONLY === 'true'
}

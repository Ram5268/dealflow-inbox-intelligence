// Brief 5.0 — single source of truth for "seed-data-only" test mode.
//
// While Ryan trials the app on the 56 seed rows (isTestData=true), real Mojo /
// RawEmail data is severely corrupted and would pollute DriftInteraction logs
// and blow up query cost. When TEST_MODE_ONLY=true, every real-data read path
// (chat tools, matchmaker, ingestion, StreetEasy sync, Mojo/Instantly APIs) is
// gated to seed data or skipped entirely. Flip to false (or delete the .env
// line) to let real data through again — that's the escape hatch.
export function isTestModeOnly(): boolean {
  return process.env.TEST_MODE_ONLY === 'true'
}

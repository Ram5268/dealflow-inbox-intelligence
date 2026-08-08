// Brief 6.0 — isolation gate for the ingestion/extraction side, the analog of
// Brief 5.0's TEST_MODE_ONLY (which gates chat + reads). While the V2 extractor
// is being validated against the hand-crafted fixture set, no PRODUCTION path may
// run ingestion/extraction against real Graph email or the real DB. When
// INGESTION_TEST_MODE_ONLY=true, every automatic/production ingestion entry point
// (the sync route, attachment reprocessing, the reprocess-backlog script, and the
// ingestEmailV2 orchestrator itself) early-returns.
//
// This does NOT block the extractor's pure, callable form: the fixture harness
// calls runExtraction()/buildContext() directly and never touches these gated
// paths, so fixture runs stay isolated and cannot pollute production tables.
//
// Flip to false (or delete the .env line) to re-enable real ingestion — that's the
// escape hatch. Independent of TEST_MODE_ONLY (chat) by design.
export function isIngestionTestModeOnly(): boolean {
  return process.env.INGESTION_TEST_MODE_ONLY === 'true'
}

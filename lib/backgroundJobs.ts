// All background crons removed. Every Microsoft Graph and StreetEasy
// operation runs during a user-initiated Check In or Review button click,
// so the OAuth session token is fresh.
//
// Architectural decision (2026-05-31):
//   - Microsoft Graph tokens expire ~hourly and can't refresh without a
//     user session. Automated jobs that need Graph access (inbox sync,
//     daily report) silently fail.
//   - StreetEasy hotsheet is now ingested via the normal email pipeline
//     (lib/ingestion/extractors/hotsheetEmailExtractor.ts) — no scraping
//     needed since StreetEasy emails the hotsheet daily.
//
// startBackgroundJobs() is kept as a no-op for compatibility with the
// existing bootstrap call. If we ever add a cron that doesn't need a user
// session (e.g. quota-counter reset), reintroduce the schedule here.

const g = globalThis as typeof globalThis & { _dealflowJobsStarted?: boolean }

export function startBackgroundJobs() {
  if (g._dealflowJobsStarted) return
  g._dealflowJobsStarted = true
  console.log('[DealFlow] Background jobs disabled — all sync is manual via Check In / Review.')
}

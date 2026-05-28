import cron from 'node-cron'

// Guard against multiple starts from hot reload in dev
const g = globalThis as typeof globalThis & { _dealflowJobsStarted?: boolean }

export function startBackgroundJobs() {
  if (g._dealflowJobsStarted) return
  g._dealflowJobsStarted = true

  console.log('[DealFlow] Starting background jobs...')

  // Inbox auto-sync disabled — triggered manually via /api/sync/run (Check In button).

  // StreetEasy hotsheet at 4:54am Eastern — before daily report so matches are included
  cron.schedule('54 4 * * *', async () => {
    try {
      const { runHotsheetSync } = await import('./streetEasyHotsheet')
      const result = await runHotsheetSync()
      console.log(`[DealFlow] Hotsheet: +${result.sales} sales, +${result.rentals} rentals, ${result.matches} buyer matches`)
    } catch (e) {
      console.error('[DealFlow] Hotsheet sync error:', (e as Error).message)
    }
  }, { timezone: 'America/New_York' })

  // StreetEasy status sweep at 5:30am Eastern — between hotsheet (4:54) and daily report (6:00).
  // Re-checks recently-stored listings against the live StreetEasy API and flips
  // streetEasyStatus to delisted/sold/in_contract as appropriate. Depends only on
  // RAPIDAPI_KEY (no Microsoft Graph token), so it runs autonomously regardless of
  // whether the inbox token is fresh.
  cron.schedule('30 5 * * *', async () => {
    try {
      const { runDailyStatusSweep } = await import('./streetEasySync')
      const result = await runDailyStatusSweep()
      console.log(`[DealFlow] Status sweep: ${JSON.stringify(result)}`)
    } catch (e) {
      console.error('[DealFlow] Status sweep error:', (e as Error).message)
    }
  }, { timezone: 'America/New_York' })

  // Daily report at 6:00am Eastern Time
  cron.schedule('0 6 * * *', async () => {
    try {
      const { generateAndSendDailyReport } = await import('./emailReport')
      await generateAndSendDailyReport()
    } catch (e) {
      console.error('[DealFlow] Daily report error:', (e as Error).message)
    }
  }, { timezone: 'America/New_York' })

  console.log('[DealFlow] Background jobs running: hotsheet at 4:54am ET, status sweep at 5:30am ET, daily report at 6am ET (inbox sync is manual-only)')
}

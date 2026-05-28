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

  // PAUSED for catch-up phase (see plan/layer-1-the-sweep-immutable-mitten.md).
  // While Phase X.3 (SE ID backfill) and X.4 (catch-up sweep) consume budget,
  // the daily cron would double-spend on the same records. Re-enable in Phase X.5.
  /*
  cron.schedule('30 5 * * *', async () => {
    try {
      const { runDailyStatusSweep } = await import('./streetEasySync')
      const result = await runDailyStatusSweep()
      console.log(`[DealFlow] Status sweep: ${JSON.stringify(result)}`)
    } catch (e) {
      console.error('[DealFlow] Status sweep error:', (e as Error).message)
    }
  }, { timezone: 'America/New_York' })
  */

  // Daily report at 6:00am Eastern Time
  cron.schedule('0 6 * * *', async () => {
    try {
      const { generateAndSendDailyReport } = await import('./emailReport')
      await generateAndSendDailyReport()
    } catch (e) {
      console.error('[DealFlow] Daily report error:', (e as Error).message)
    }
  }, { timezone: 'America/New_York' })

  console.log('[DealFlow] Background jobs running: hotsheet at 4:54am ET, daily report at 6am ET (status sweep paused for catch-up; inbox sync is manual-only)')
}

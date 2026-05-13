import cron from 'node-cron'

// Guard against multiple starts from hot reload in dev
const g = globalThis as typeof globalThis & { _dealflowJobsStarted?: boolean }

export function startBackgroundJobs() {
  if (g._dealflowJobsStarted) return
  g._dealflowJobsStarted = true

  console.log('[DealFlow] Starting background jobs...')

  // Sync every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { runIncrementalSync } = await import('./backgroundSync')
      const result = await runIncrementalSync()
      if (!result.skipped && result.newEmails > 0) {
        console.log(`[DealFlow] Sync: +${result.newEmails} emails, +${result.newOpps} opportunities`)
      }
    } catch (e) {
      // Silently ignore token expiry errors
    }
  })

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

  // Daily report at 6:00am Eastern Time
  cron.schedule('0 6 * * *', async () => {
    try {
      const { generateAndSendDailyReport } = await import('./emailReport')
      await generateAndSendDailyReport()
    } catch (e) {
      console.error('[DealFlow] Daily report error:', (e as Error).message)
    }
  }, { timezone: 'America/New_York' })

  console.log('[DealFlow] Background jobs running: sync every 5min, hotsheet at 4:54am ET, daily report at 6am ET')
}

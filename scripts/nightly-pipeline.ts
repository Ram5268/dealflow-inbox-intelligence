// Brief 35: run the nightly pipeline locally, with the same code as
// /api/cron/nightly-pipeline.
//
//   npx tsx scripts/nightly-pipeline.ts                           # dry run (default): all steps; SQL rolled back, list not saved
//   npx tsx scripts/nightly-pipeline.ts --step=scoring            # one step, dry run: crm | scoring | queue
//   npx tsx scripts/nightly-pipeline.ts --apply                   # writes (on the live database also --i-mean-live)
// The dry run of steps 1-2 runs the real statements, each step in one
// transaction, and rolls back, so it briefly takes the same row locks as a real
// run: don't run it around the nightly job at 09:00 UTC (5 am ET in summer, 4 am
// in winter).
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { closeCrmPool } from '../lib/crm-sync/roClient'
import { runNightlyPipeline, type StepName } from '../lib/nightlyPipeline'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/nightly-pipeline.ts (DATABASE_URL)')

const STEP_FLAGS: Record<string, StepName> = { crm: 'crmLeadSync', scoring: 'scoring', queue: 'callQueue' }

async function main() {
  const flag = process.argv.find(a => a.startsWith('--step='))?.slice('--step='.length)
  if (flag && !STEP_FLAGS[flag]) throw new Error('usage: [--step=crm|scoring|queue] [--apply [--i-mean-live]]')
  const result = await runNightlyPipeline({ dryRun: !APPLY, only: flag ? STEP_FLAGS[flag] : undefined })
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(async () => { await closeCrmPool(); await prisma.$disconnect() })

// Brief 35: run the nightly pipeline locally, with the same code as
// /api/cron/nightly-pipeline.
//
//   npx tsx scripts/nightly-pipeline.ts --dry-run                 # all steps; SQL rolled back, list not saved
//   npx tsx scripts/nightly-pipeline.ts --step=scoring --dry-run  # one step: crm | scoring | queue
//   npx tsx scripts/nightly-pipeline.ts                           # live
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { closeCrmPool } from '../lib/crm-sync/roClient'
import { runNightlyPipeline, type StepName } from '../lib/nightlyPipeline'

const STEP_FLAGS: Record<string, StepName> = { crm: 'crmLeadSync', scoring: 'scoring', queue: 'callQueue' }

async function main() {
  const flag = process.argv.find(a => a.startsWith('--step='))?.slice('--step='.length)
  if (flag && !STEP_FLAGS[flag]) throw new Error('usage: [--step=crm|scoring|queue] [--dry-run]')
  const result = await runNightlyPipeline({ dryRun: process.argv.includes('--dry-run'), only: flag ? STEP_FLAGS[flag] : undefined })
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(async () => { await closeCrmPool(); await prisma.$disconnect() })

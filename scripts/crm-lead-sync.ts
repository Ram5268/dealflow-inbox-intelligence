// Brief 34: manual / backfill run of the CRM → DealFlow lead sync, using the
// same runner as /api/cron/nightly-pipeline.
//
//   npx tsx scripts/crm-lead-sync.ts --dry-run   # runs every statement, then rolls back
//   npx tsx scripts/crm-lead-sync.ts             # live
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { closeCrmPool } from '../lib/crm-sync/roClient'
import { runCrmLeadSync } from '../lib/crm-sync/runSync'

async function main() {
  const result = await runCrmLeadSync({ dryRun: process.argv.includes('--dry-run') })
  console.log(JSON.stringify(result, null, 2))
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(async () => { await closeCrmPool(); await prisma.$disconnect() })

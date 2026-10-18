// Brief 34: manual / backfill run of the CRM → DealFlow lead sync, using the
// same runner as /api/cron/nightly-pipeline.
//
//   npx tsx scripts/crm-lead-sync.ts             # dry run (default): runs every statement, then rolls back
//   npx tsx scripts/crm-lead-sync.ts --apply     # writes (on the live database also --i-mean-live)
// The CRM read (DATABASE_URL_CRM_RO) is read-only either way.
// The dry run runs the real statements in one transaction and rolls back, so
// it briefly takes the same row locks as a real run: don't run it around the
// nightly job at 09:00 UTC (5 am ET in summer, 4 am in winter).
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { closeCrmPool } from '../lib/crm-sync/roClient'
import { runCrmLeadSync } from '../lib/crm-sync/runSync'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/crm-lead-sync.ts (DATABASE_URL)')

async function main() {
  const result = await runCrmLeadSync({ dryRun: !APPLY })
  console.log(JSON.stringify(result, null, 2))
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(async () => { await closeCrmPool(); await prisma.$disconnect() })

// Brief 48 data step DS-2: add 45 test buyers [Ryan 1.12, 2026-10-19;
// pre-approved, BRIEF_48.md §4].
//
// Adds 45 BUYER_ISO test rows (isTestData: true, tag [TEST_48], ids
// test48-buyer-opp-NNN) to Ryan's organization, aimed at the CRM's Brooklyn
// 1–3 family sellers, built like the closed PR #4's generator with made-up
// agents. With today's 205 that makes 250; if the count has moved, the dry run
// says so and reports the total, and it still adds exactly 45 [Brief 48
// executor, 2026-10-23]. --restore deletes exactly the rows this run created,
// and what the nightly made from them since. Details: lib/dataSteps/ds2TestBuyers.ts.
// It prints counts and ids only. It uses the DATABASE_URL in its environment
// only (it doesn't load .env).
//
//   npx tsx scripts/brief48-ds2-add-test-buyers.ts                                   # dry run: today's count, the total, the plan fingerprint
//   npx tsx scripts/brief48-ds2-add-test-buyers.ts --apply --expect <n> --plan <fingerprint> --i-mean-live  # add them, then the after-check
//   npx tsx scripts/brief48-ds2-add-test-buyers.ts --check <before-copy>
//   npx tsx scripts/brief48-ds2-add-test-buyers.ts --restore <before-copy> [--apply --expect <n> --plan <fingerprint> --i-mean-live]
// The before-copy goes to ~/dev/brief48-dealflow-fixes/private/ (or --preimage-dir <dir>).
import { resolve } from 'node:path'
import { databaseName, maintenanceApply } from '../lib/dbGuard'
import { dataStepClient } from '../lib/dataSteps/client'
import { safeErrorLine } from '../lib/dataSteps/common'
import { EXIT, runStep } from '../lib/dataSteps/runner'
import { ds2Step } from '../lib/dataSteps/ds2TestBuyers'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply on
// a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/brief48-ds2-add-test-buyers.ts (DATABASE_URL)')

// Its own client: Prisma logs nothing (a query error can quote row values) and
// a dead connection times out; without --apply it can only read (lib/dataSteps/client.ts).
const db = dataStepClient(process.env.DATABASE_URL, { readOnly: !APPLY })

runStep(ds2Step, {
  db, argv: process.argv, apply: APPLY, database: databaseName(process.env.DATABASE_URL), repoRoot: resolve(__dirname, '..'),
})
  .then(code => { process.exitCode = code })
  .catch(e => { console.error(safeErrorLine(e)); process.exitCode = EXIT.failed })
  .finally(() => db.$disconnect())

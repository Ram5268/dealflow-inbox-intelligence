// Brief 48 data step DS-1: remove the duplicate spreadsheet copies [Ryan 1.4,
// 2026-10-19: keep the original record; pre-approved, BRIEF_48.md §4].
//
// MojoContact rows the CRM copy marked metadata.source = 'duplicate' (csv_*
// twins of a CRM lead, each with metadata.duplicateOf = the kept record) are
// deleted in Ryan's organization. Everything pointing at them is first moved to
// the kept record (dismissals, call history, email events, feedback) or removed
// (derived rows: matches, the duplicates' call-list rows), in the same
// transaction; logs, chat and reports that mention them are only counted. A row
// of any other table with a foreign key to a duplicate blocks the run. The kept
// records are never written. Details: lib/dataSteps/ds1Duplicates.ts.
// It prints counts and ids only. It uses the DATABASE_URL in its environment
// only (it doesn't load .env).
//
//   npx tsx scripts/brief48-ds1-remove-duplicates.ts                                   # dry run: counts, the --expect number, the plan fingerprint
//   npx tsx scripts/brief48-ds1-remove-duplicates.ts --apply --expect <n> --plan <fingerprint> --i-mean-live  # apply exactly that plan, then the after-check
//   npx tsx scripts/brief48-ds1-remove-duplicates.ts --check <before-copy>              # the read-only after-check again
//   npx tsx scripts/brief48-ds1-remove-duplicates.ts --restore <before-copy>            # restore dry run
//   npx tsx scripts/brief48-ds1-remove-duplicates.ts --restore <before-copy> --apply --expect <n> --plan <fingerprint> --i-mean-live
// The before-copy goes to ~/dev/brief48-dealflow-fixes/private/ (or --preimage-dir <dir>).
import { resolve } from 'node:path'
import { databaseName, maintenanceApply } from '../lib/dbGuard'
import { dataStepClient } from '../lib/dataSteps/client'
import { safeErrorLine } from '../lib/dataSteps/common'
import { EXIT, runStep } from '../lib/dataSteps/runner'
import { ds1Step } from '../lib/dataSteps/ds1Duplicates'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply on
// a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/brief48-ds1-remove-duplicates.ts (DATABASE_URL)')

// Its own client: Prisma logs nothing (a query error can quote row values) and
// a dead connection times out; without --apply it can only read (lib/dataSteps/client.ts).
const db = dataStepClient(process.env.DATABASE_URL, { readOnly: !APPLY })

runStep(ds1Step, {
  db, argv: process.argv, apply: APPLY, database: databaseName(process.env.DATABASE_URL), repoRoot: resolve(__dirname, '..'),
})
  .then(code => { process.exitCode = code })
  .catch(e => { console.error(safeErrorLine(e)); process.exitCode = EXIT.failed })
  .finally(() => db.$disconnect())

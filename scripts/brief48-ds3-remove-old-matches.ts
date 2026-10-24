// Brief 48 data step DS-3: remove the old matcher's leftover match rows
// [Brief 48 §4, from PR 1; pre-approved by Ryan 2026-10-19].
//
// Match rows written by the retired matcher (lib/matchmaking.ts): no tier and
// one of its five notes, anchored at both ends; one note holds a homeowner's
// name and address. Removed in Ryan's organization if nothing uses them; if the
// call list, feedback, chat, Drift or reports name them, the dry run reports it
// and --apply also needs --allow-referenced (then the call list and feedback
// drop those ids; text is left as is). Details: lib/dataSteps/ds3LegacyMatches.ts.
// It prints counts and ids only, never a note. It uses the DATABASE_URL in its
// environment only (it doesn't load .env).
//
//   npx tsx scripts/brief48-ds3-remove-old-matches.ts                                   # dry run: counts, the --expect number, the plan fingerprint
//   npx tsx scripts/brief48-ds3-remove-old-matches.ts --apply --expect <n> --plan <fingerprint> --i-mean-live [--allow-referenced]
//   npx tsx scripts/brief48-ds3-remove-old-matches.ts --check <before-copy>
//   npx tsx scripts/brief48-ds3-remove-old-matches.ts --restore <before-copy> [--apply --expect <n> --plan <fingerprint> --i-mean-live]
// The before-copy goes to ~/dev/brief48-dealflow-fixes/private/ (or --preimage-dir <dir>).
import { resolve } from 'node:path'
import { databaseName, maintenanceApply } from '../lib/dbGuard'
import { dataStepClient } from '../lib/dataSteps/client'
import { safeErrorLine } from '../lib/dataSteps/common'
import { EXIT, runStep } from '../lib/dataSteps/runner'
import { ds3Step } from '../lib/dataSteps/ds3LegacyMatches'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply on
// a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/brief48-ds3-remove-old-matches.ts (DATABASE_URL)')

// Its own client: Prisma logs nothing (a query error can quote row values) and
// a dead connection times out; without --apply it can only read (lib/dataSteps/client.ts).
const db = dataStepClient(process.env.DATABASE_URL, { readOnly: !APPLY })

runStep(ds3Step, {
  db, argv: process.argv, apply: APPLY, database: databaseName(process.env.DATABASE_URL), repoRoot: resolve(__dirname, '..'),
})
  .then(code => { process.exitCode = code })
  .catch(e => { console.error(safeErrorLine(e)); process.exitCode = EXIT.failed })
  .finally(() => db.$disconnect())

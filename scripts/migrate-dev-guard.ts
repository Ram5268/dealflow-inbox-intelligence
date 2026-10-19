// Brief 47 (PR 2), engineering precaution (Brief 41.2 found-not-fixed;
// confirmed 2026-10-18): `npm run db:migrate` runs this first, and
// `prisma migrate dev` only if it exits 0 (package.json:
// "ts-node … scripts/migrate-dev-guard.ts && prisma migrate dev", so
// `npm run db:migrate -- --name x` still hands `--name x` to Prisma).
// `prisma migrate dev` is Prisma's development tool: when the database doesn't
// match the migration history it offers to reset it, which erases every row.
// So it only runs on a *_perf or *_test database, with no override.
//
// .env is loaded exactly as prisma.config.ts loads it (`import 'dotenv/config'`:
// .env in the folder it's run from, never replacing a variable that's already
// set), so this checks the same DATABASE_URL Prisma will use; a missing or
// unreadable URL is refused too. Prisma also takes SHADOW_DATABASE_URL, a
// scratch database it wipes and rebuilds on each run, so when that is set it
// must be a test database as well.
//
// Production migrations never go through this: they stay
// `prisma migrate deploy`, run only as a named data step.
// lib/__tests__/scriptGuards.test.ts checks all of this, and runs it.
import 'dotenv/config'
import { databaseName, refuseLiveDatabase } from '../lib/dbGuard'

refuseLiveDatabase(process.env.DATABASE_URL, 'prisma migrate dev (npm run db:migrate, DATABASE_URL)')
if (process.env.SHADOW_DATABASE_URL) {
  refuseLiveDatabase(process.env.SHADOW_DATABASE_URL, 'prisma migrate dev (npm run db:migrate, SHADOW_DATABASE_URL)')
}

console.log(`db:migrate guard: database "${databaseName(process.env.DATABASE_URL)}" is a test database, so prisma migrate dev may run.`)

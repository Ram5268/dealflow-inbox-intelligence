// Brief 48 (data steps): the database client the data-step scripts use
// [engineering precaution]. Like lib/prisma.ts, but:
//   - Prisma logs nothing itself: a failed query's text could quote row values,
//     so the scripts print only lib/dataSteps/common.ts safeErrorLine;
//   - client-side time limits, so a dead connection can't hang a run forever
//     (seen with Railway's proxy in Brief 35).
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

//   - Brief 48 review: without --apply (dry runs, --check, a restore's dry run)
//     the connection itself is read-only, as scripts/valuation-switch-preview.ts.
export function dataStepClient(url: string | undefined, { readOnly = false }: { readOnly?: boolean } = {}): PrismaClient {
  const pool = new Pool({
    connectionString: url, max: 2, connectionTimeoutMillis: 20_000, query_timeout: 600_000, keepAlive: true,
    ...(readOnly && { options: '-c default_transaction_read_only=on' }),
  })
  return new PrismaClient({ adapter: new PrismaPg(pool), log: [], errorFormat: 'minimal' })
}

import { Pool, type QueryConfig } from 'pg'

// Brief 34: read-only pg pool into the CRM's `dealflow_crm` database, mirroring
// the CRM's own src/lib/core-data/dealflow-sync/ro-client.ts. DealFlow never
// writes to the CRM. Statements must start with SELECT/WITH, and each runs in
// a READ ONLY transaction, which also rejects a `WITH … DELETE` that the text
// check alone would let through.
//
// Brief 41.2 (PR C, audit M3): one statement per call. With no params node-pg
// uses the simple query protocol, which runs every statement in the text, so
// `SELECT 1; COMMIT; DELETE …` would end the READ ONLY transaction and run the
// DELETE outside it. So any `;` before an optional trailing one is refused,
// even one inside a string literal or a comment (that fails closed). The
// statement is also sent over the extended protocol (queryMode 'extended'),
// where Postgres itself refuses more than one statement. Engineering precaution
// from the Oct 16, 2026 system-map review. This file is the only reader of
// DATABASE_URL_CRM_RO (lib/crm-sync/__tests__/roSettingUsage.test.ts).

let pool: Pool | null = null

function getPool(): Pool {
  if (pool) return pool
  const url = process.env.DATABASE_URL_CRM_RO
  if (!url) throw new Error('DATABASE_URL_CRM_RO not set')
  pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 8_000, idleTimeoutMillis: 10_000 })
  return pool
}

export function assertSelectOnly(sql: string): void {
  const head = sql.trimStart().toLowerCase()
  if (!head.startsWith('select') && !head.startsWith('with')) {
    throw new Error('CRM RO client only permits SELECT/WITH statements')
  }
  const body = sql.trimEnd()
  if ((body.endsWith(';') ? body.slice(0, -1) : body).includes(';')) {
    throw new Error('CRM RO client only permits one statement')
  }
}

export async function crmQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  assertSelectOnly(sql)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN READ ONLY')
    // queryMode isn't in @types/pg yet; pg 8.20 reads it (lib/query.js).
    const query: QueryConfig & { queryMode: 'extended' } = { text: sql, values: params, queryMode: 'extended' }
    return (await client.query(query)).rows as T[]
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

export async function closeCrmPool(): Promise<void> {
  if (!pool) return
  await pool.end()
  pool = null
}

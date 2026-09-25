import { Pool } from 'pg'

// Brief 34: read-only pg pool into the CRM's `dealflow_crm` database, mirroring
// the CRM's own src/lib/core-data/dealflow-sync/ro-client.ts. DealFlow never
// writes to the CRM. Statements must start with SELECT/WITH, and each runs in
// a READ ONLY transaction, which also rejects a `WITH … DELETE` that the text
// check alone would let through.

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
}

export async function crmQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  assertSelectOnly(sql)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN READ ONLY')
    return (await client.query(sql, params)).rows as T[]
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

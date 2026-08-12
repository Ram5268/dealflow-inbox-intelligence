// One-off export of the live Railway Postgres DB to JSONL + CSV per table.
// Defensive: per-table try/catch, batched queries for big tables,
// incremental manifest writes, all progress logged to disk so background
// runs are observable even if stdout buffers. Uses sync appendFileSync
// instead of streams to avoid 'close' event hangs.
import 'dotenv/config'
import { mkdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { prisma } from '../lib/prisma'

const STAGE = process.env.STAGE ?? '/tmp/dealflow_db_export'
const LOG   = `${STAGE}/export.log`
mkdirSync(`${STAGE}/jsonl`, { recursive: true })
mkdirSync(`${STAGE}/csv`,   { recursive: true })

const BATCH = 500
const BATCH_THRESHOLD = 1500

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stdout.write(line)
  try { appendFileSync(LOG, line) } catch {}
}

function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString()
  if (v instanceof Uint8Array) return `[binary ${v.length} bytes]`
  if (v instanceof Buffer) return `[binary ${v.length} bytes]`
  return v
}

function isVectorish(v: unknown): boolean {
  if (Array.isArray(v) && v.length > 64 && v.every(x => typeof x === 'number')) return true
  if (typeof v === 'string' && v.length > 1000 && (v.startsWith('[') || v.startsWith('('))) return true
  return false
}

function csvCell(v: unknown): string {
  if (v == null) return ''
  if (isVectorish(v)) {
    if (Array.isArray(v)) return `"[${v.length}-dim vector — see JSONL]"`
    return `"[vector ${(v as string).length} chars — see JSONL]"`
  }
  if (v instanceof Uint8Array || v instanceof Buffer) return `"[binary ${v.length} bytes]"`
  let s = typeof v === 'string' ? v
        : typeof v === 'bigint' ? v.toString()
        : v instanceof Date ? v.toISOString()
        : typeof v === 'object' ? JSON.stringify(v, jsonReplacer)
        : String(v)
  s = s.replace(/\r?\n/g, ' \\n ').replace(/"/g, '""')
  return `"${s}"`
}

interface ExportSummary { table: string; rows: number; jsonlBytes: number; csvBytes: number; vectorCols: string[]; error: string | null }

async function getRowCount(tableName: string): Promise<number> {
  const r = await prisma.$queryRawUnsafe<Array<{n: bigint}>>(`SELECT COUNT(*)::bigint AS n FROM "${tableName}"`)
  return Number(r[0].n)
}

async function exportTable(tableName: string): Promise<ExportSummary> {
  const summary: ExportSummary = { table: tableName, rows: 0, jsonlBytes: 0, csvBytes: 0, vectorCols: [], error: null }
  const jsonlPath = `${STAGE}/jsonl/${tableName}.jsonl`
  const csvPath   = `${STAGE}/csv/${tableName}.csv`
  writeFileSync(jsonlPath, '')
  writeFileSync(csvPath, '')

  const total = await getRowCount(tableName)
  summary.rows = total
  if (total === 0) return summary

  const vectorCols = new Set<string>()
  let headerWritten = false
  let cols: string[] = []
  const batched = total > BATCH_THRESHOLD

  let offset = 0
  while (offset < total) {
    const take = batched ? BATCH : total
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM "${tableName}" ORDER BY 1 LIMIT ${take} OFFSET ${offset}`,
    )
    if (rows.length === 0) break

    if (!headerWritten) {
      cols = Object.keys(rows[0])
      appendFileSync(csvPath, cols.map(c => `"${c}"`).join(',') + '\n')
      for (const r of rows.slice(0, Math.min(rows.length, 50))) {
        for (const [k, v] of Object.entries(r)) {
          if (isVectorish(v)) vectorCols.add(k)
        }
      }
      headerWritten = true
    }

    const jsonChunk = rows.map(r => JSON.stringify(r, jsonReplacer)).join('\n') + '\n'
    appendFileSync(jsonlPath, jsonChunk)

    const csvChunk = rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\n') + '\n'
    appendFileSync(csvPath, csvChunk)

    offset += rows.length
    if (batched && offset % (BATCH * 5) === 0) log(`    ${tableName} batch: ${offset}/${total}`)
  }

  summary.vectorCols = [...vectorCols]
  summary.jsonlBytes = statSync(jsonlPath).size
  summary.csvBytes   = statSync(csvPath).size
  return summary
}

async function main() {
  writeFileSync(LOG, '')
  const startedAt = new Date().toISOString()
  log(`Export started at ${startedAt}`)

  const tableRows = await prisma.$queryRawUnsafe<Array<{table_name: string}>>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `)
  const tables = tableRows.map(r => r.table_name).filter(t => !t.startsWith('_'))
  log(`Found ${tables.length} tables`)

  const summaries: ExportSummary[] = []
  for (const t of tables) {
    const t0 = Date.now()
    log(`Exporting ${t} ...`)
    try {
      const s = await exportTable(t)
      summaries.push(s)
      log(`  ${t}: ${s.rows} rows  JSONL ${(s.jsonlBytes/1024/1024).toFixed(2)}MB  CSV ${(s.csvBytes/1024/1024).toFixed(2)}MB  ${((Date.now()-t0)/1000).toFixed(1)}s${s.vectorCols.length ? `  vec=[${s.vectorCols.join(',')}]` : ''}`)
    } catch (e) {
      const msg = (e as Error).message.slice(0, 200)
      summaries.push({ table: t, rows: -1, jsonlBytes: 0, csvBytes: 0, vectorCols: [], error: msg })
      log(`  ${t}: ERROR ${msg}`)
    }

    // Incremental manifest write after each table.
    writeFileSync(`${STAGE}/manifest.json`, JSON.stringify({
      exportedAt: startedAt,
      database: 'railway:dealflow (production)',
      totalTables: tables.length,
      completedTables: summaries.length,
      totalRows: summaries.reduce((s, t) => s + (t.rows > 0 ? t.rows : 0), 0),
      totalJsonlBytes: summaries.reduce((s, t) => s + t.jsonlBytes, 0),
      totalCsvBytes:   summaries.reduce((s, t) => s + t.csvBytes, 0),
      tables: summaries,
    }, null, 2))
  }

  log(`DONE — ${summaries.length}/${tables.length} tables exported`)
  await prisma.$disconnect()
}

main().catch(async (e) => { log(`FATAL: ${(e as Error).message}`); await prisma.$disconnect(); process.exit(1) })

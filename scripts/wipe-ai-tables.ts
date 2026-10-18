import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { mkdirSync, writeFileSync } from 'node:fs'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): it deletes every chunk, match and
// AI-made listing, so it refuses any database but a *_perf or *_test one, with
// no override. CONFIRM_WIPE=yes is still needed there.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/wipe-ai-tables.ts (DATABASE_URL)')

// Brief 2.5, Step 2 — selective wipe of V1-buggy AI-generated tables.
//
// DELETES (cheap to regenerate): DocumentChunk, Match, ExtractedOpportunity.
// PRESERVES (real user data / auth / observation log): everything else — most
// importantly RawEmail, ConnectedMailbox, MojoContact, LinkedResource, and the
// DriftInteraction* instrumentation tables (auth-adjacent: they hold the chat
// observation log, not AI-generated cards).
//
// Guarded: dry-run by default (writes pre-counts + prints them). Set
// CONFIRM_WIPE=yes to actually delete. Deletes run in a single transaction so
// a partial failure rolls back cleanly — never row-by-row.

const DELETE_TABLES   = ['DocumentChunk', 'Match', 'ExtractedOpportunity'] as const
const PRESERVE_TABLES = ['RawEmail', 'ConnectedMailbox', 'MojoContact', 'LinkedResource', 'User', 'Organization', 'AIExtractionLog'] as const
const DRIFT_TABLES    = ['DriftInteraction', 'DriftInteractionClick', 'DriftInteractionFeedback'] as const

async function count(t: string): Promise<number> {
  const r = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "${t}"`)
  return Number(r[0].n)
}
async function countAll(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of [...DELETE_TABLES, ...PRESERVE_TABLES, ...DRIFT_TABLES]) out[t] = await count(t)
  return out
}

function renderMd(pre: Record<string, number>): string {
  return [
    '# Pre-seed / pre-wipe row counts — Brief 2.5, Step 2',
    '',
    'Captured immediately before the selective wipe of AI-generated tables.',
    'A full DB snapshot zip was exported to `~/Downloads` as insurance before any DELETE ran.',
    '',
    '## Deleted (V1 AI outputs — cheap to regenerate)',
    '| table | pre-wipe count |',
    '|---|---|',
    ...DELETE_TABLES.map(t => `| ${t} | ${pre[t]} |`),
    '',
    '## Preserved (real user data / auth / observation log)',
    '| table | count |',
    '|---|---|',
    ...PRESERVE_TABLES.map(t => `| ${t} | ${pre[t]} |`),
    ...DRIFT_TABLES.map(t => `| ${t} | ${pre[t]} |`),
    '',
    '_Not present in this schema (no-op): SyncRun, ExtractedListing, LandlordLead, SellerLead._',
    '_User = 0 (auth is org-scoped via the singleton Organization row)._',
    '',
  ].join('\n')
}

async function main() {
  const pre = await countAll()

  mkdirSync('docs/eval', { recursive: true })
  writeFileSync('docs/eval/pre-seed-counts.md', renderMd(pre))
  console.log('Wrote docs/eval/pre-seed-counts.md')

  if (process.env.CONFIRM_WIPE !== 'yes') {
    console.log('\n── DRY RUN (set CONFIRM_WIPE=yes to execute) ── pre-wipe counts:')
    console.table(pre)
    await prisma.$disconnect()
    return
  }

  // Single atomic transaction. Order: DocumentChunk (independent), then Match
  // (must precede ExtractedOpportunity — Match.opportunityId FK), then
  // ExtractedOpportunity. Array form as specified; interactive+timeout fallback
  // only if the batch form trips Prisma's default transaction window.
  let res: Array<{ count: number }>
  try {
    res = await prisma.$transaction([
      prisma.documentChunk.deleteMany({}),
      prisma.match.deleteMany({}),
      prisma.extractedOpportunity.deleteMany({}),
    ])
  } catch (e) {
    console.warn('Array-form $transaction failed; retrying interactive (still atomic):', (e as Error).message)
    res = await prisma.$transaction(async (tx) => {
      const c = await tx.documentChunk.deleteMany({})
      const m = await tx.match.deleteMany({})
      const o = await tx.extractedOpportunity.deleteMany({})
      return [c, m, o]
    }, { timeout: 120_000, maxWait: 20_000 })
  }
  const [chunks, matches, opps] = res

  const post = await countAll()

  console.log('\n=== DELETED (rows removed) ===')
  console.log(`  DocumentChunk:        ${chunks.count}`)
  console.log(`  Match:                ${matches.count}`)
  console.log(`  ExtractedOpportunity: ${opps.count}`)

  console.log('\n=== DELETE TARGETS (pre -> post, expect 0) ===')
  for (const t of DELETE_TABLES) console.log(`  ${t.padEnd(22)} ${pre[t]} -> ${post[t]}`)

  console.log('\n=== PRESERVED (pre -> post, expect unchanged) ===')
  let mismatch = false
  for (const t of [...PRESERVE_TABLES, ...DRIFT_TABLES]) {
    const ok = pre[t] === post[t]
    if (!ok) mismatch = true
    console.log(`  ${t.padEnd(26)} ${pre[t]} -> ${post[t]}  ${ok ? 'OK' : '*** CHANGED ***'}`)
  }

  const verifyRows = await prisma.driftInteraction.count({ where: { query: { startsWith: '[VERIFY 2.5]' } } })
  const realRows   = await prisma.driftInteraction.count({ where: { NOT: { query: { startsWith: '[VERIFY 2.5]' } } } })
  console.log(`\nDriftInteraction preserved: ${verifyRows} [VERIFY 2.5] executor-test row(s) + ${realRows} real interaction row(s)`)

  await prisma.$disconnect()
  if (mismatch) { console.error('\n*** A PRESERVED TABLE COUNT CHANGED — STOP AND INVESTIGATE ***'); process.exit(1) }
  console.log('\nWipe complete. All preserved tables intact.')
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

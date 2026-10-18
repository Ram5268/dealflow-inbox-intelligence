// Brief 44 data step V2 — store the fingerprint of the valuation job's import key.
//
// The monthly valuation job (GitHub Actions) sends its key, kept in GitHub's secret
// VALUATION_IMPORT_SECRET, as a bearer token to POST /api/valuations/import and GET
// /api/valuations/targets. DealFlow compares the token's SHA-256 with ServiceKey
// 'valuation-import' (lib/valuations/auth.ts). This writes that row: the fingerprint
// only, never the key. A production data step (Ryan's yes given in advance,
// 2026-10-17). Engineering precautions (Brief 44 §4): the key is read from stdin
// only (never the command line or the environment), and neither it nor its
// fingerprint is printed, in any mode or on any error. It uses the DATABASE_URL in
// its environment only (it doesn't load .env).
//
//   <key> | npx tsx scripts/valuation-service-key.ts           # dry run (default): says create or rotate
//   <key> | npx tsx scripts/valuation-service-key.ts --apply   # write the fingerprint (rotatedAt on a rotation)
// On the live database --apply also needs --i-mean-live.
import { prisma } from '../lib/prisma'
import { maintenanceApply } from '../lib/dbGuard'
import { KEY_REFUSED, MAX_STDIN_BYTES, keyFromStdin, storeServiceKey } from '../lib/valuations/serviceKey'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply on a
// database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/valuation-service-key.ts (DATABASE_URL)')

// Everything piped in, or null: a terminal (a typed key would show on screen) or too much.
async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length
    if (size > MAX_STDIN_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const key = keyFromStdin(await readStdin())
  if (key == null) {
    console.error(KEY_REFUSED)
    process.exitCode = 2
    return
  }
  const out = await storeServiceKey(prisma, key, APPLY)
  if (out.exitCode === 0) console.log(out.message)
  else console.error(out.message)
  process.exitCode = out.exitCode
}

main()
  .catch(e => {
    // Only the class name: a message could quote the query.
    console.error(`Failed (${e instanceof Error ? e.constructor.name : 'unknown'}). Nothing about the key is printed.`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

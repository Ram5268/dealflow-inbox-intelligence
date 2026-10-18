// One-time backfill: populate ExtractedOpportunity.units on records that
// have explicit "N-family" / "N-unit" patterns in their extractedTitle,
// extractedSummary, or propertyType. Pure DB work — no external API spend.
//
// Run:
//   npx tsx scripts/backfill-units.ts            # dry run (default; --dry-run still works)
//   npx tsx scripts/backfill-units.ts --apply    # write (on the live database also --i-mean-live)

import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/backfill-units.ts (DATABASE_URL)')

const WORD_NUM: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
}

// Match "2-family", "two family", "3 family", "2-Family", "5-unit", etc.
// Word boundary on both sides avoids matching inside larger words.
const FAMILY_RE = /\b(2|3|4|5|6|7|8|two|three|four|five|six|seven|eight)[\s\-]?(?:family|unit|units)\b/i

function extractUnits(text: string | null | undefined): number | null {
  if (!text) return null
  const m = text.match(FAMILY_RE)
  if (!m) return null
  const token = m[1].toLowerCase()
  if (/^\d+$/.test(token)) return parseInt(token, 10)
  return WORD_NUM[token] ?? null
}

async function main() {
  const dryRun = !APPLY

  const candidates = await prisma.extractedOpportunity.findMany({
    where: {
      units: null,
      OR: [
        { propertyType:     { contains: 'multi',  mode: 'insensitive' } },
        { propertyType:     { contains: 'family', mode: 'insensitive' } },
        { extractedTitle:   { contains: 'family', mode: 'insensitive' } },
        { extractedSummary: { contains: 'family', mode: 'insensitive' } },
        { extractedTitle:   { contains: 'unit',   mode: 'insensitive' } },
        { extractedSummary: { contains: 'unit',   mode: 'insensitive' } },
      ],
    },
    select: {
      id: true, address: true, extractedTitle: true,
      extractedSummary: true, propertyType: true,
    },
  })

  console.log(`[backfill-units] ${candidates.length} candidates to inspect`)

  const dist: Record<number, number> = {}
  let populated = 0
  let nullAfter = 0

  for (const r of candidates) {
    // Title first (most specific), then summary, then propertyType
    const found =
      extractUnits(r.extractedTitle) ??
      extractUnits(r.extractedSummary) ??
      extractUnits(r.propertyType)

    if (found != null) {
      dist[found] = (dist[found] ?? 0) + 1
      populated++
      if (!dryRun) {
        await prisma.extractedOpportunity.update({
          where: { id: r.id },
          data: { units: found },
        })
      }
    } else {
      nullAfter++
    }
  }

  console.log(`[backfill-units] populated: ${populated}, remained null: ${nullAfter}`)
  console.log('[backfill-units] unit count distribution:')
  console.table(
    Object.entries(dist).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .map(([units, count]) => ({ units: parseInt(units), count }))
  )

  if (dryRun) console.log('[backfill-units] DRY RUN — no DB writes performed. Re-run with --apply to write them.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

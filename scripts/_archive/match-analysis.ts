import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  const totalMatches = await prisma.match.count()
  const byType = await prisma.match.groupBy({
    by: ['counterpartType'],
    _count: { _all: true },
  })
  const scoreBuckets = await prisma.$queryRaw<Array<{ bucket: string; n: bigint }>>`
    SELECT
      CASE
        WHEN score >= 90 THEN '90-100'
        WHEN score >= 70 THEN '70-89'
        WHEN score >= 50 THEN '50-69'
        ELSE '<50'
      END AS bucket,
      COUNT(*)::bigint AS n
    FROM "Match"
    GROUP BY 1
    ORDER BY 1 DESC
  `

  // Buyer-side breakdown: how many matches per BUYER_ISO?
  const topBuyers = await prisma.$queryRaw<Array<{ extractedTitle: string; neighborhood: string | null; minPrice: number | null; maxPrice: number | null; beds: number | null; n: bigint }>>`
    SELECT eo."extractedTitle", eo."neighborhood", eo."minPrice", eo."maxPrice", eo."beds", COUNT(*)::bigint AS n
    FROM "Match" m
    JOIN "ExtractedOpportunity" eo ON eo.id = m."counterpartId"
    WHERE m."counterpartType" = 'opportunity' AND eo.category = 'BUYER_ISO'
    GROUP BY eo.id, eo."extractedTitle", eo."neighborhood", eo."minPrice", eo."maxPrice", eo."beds"
    ORDER BY n DESC
    LIMIT 10
  `

  // Listings appearing in many matches (sale side)
  const topListings = await prisma.$queryRaw<Array<{ extractedTitle: string; address: string | null; n: bigint }>>`
    SELECT eo."extractedTitle", eo.address, COUNT(*)::bigint AS n
    FROM "Match" m
    JOIN "ExtractedOpportunity" eo ON eo.id = m."opportunityId"
    GROUP BY eo.id, eo."extractedTitle", eo.address
    ORDER BY n DESC
    LIMIT 10
  `

  // Pool sizes
  const counts = await prisma.$queryRaw<Array<{ label: string; n: bigint }>>`
    SELECT 'BUYER_ISO total' AS label, COUNT(*)::bigint AS n FROM "ExtractedOpportunity" WHERE category='BUYER_ISO' AND "isDuplicate"=false
    UNION ALL SELECT 'RENTER_INQUIRY total', COUNT(*)::bigint FROM "ExtractedOpportunity" WHERE category='RENTER_INQUIRY' AND "isDuplicate"=false
    UNION ALL SELECT 'Sale listings total', COUNT(*)::bigint FROM "ExtractedOpportunity" WHERE category IN ('ACTIVE_SALE_LISTING','COMING_SOON_SALE','OFF_MARKET_SALE','PRICE_DROP','BACK_ON_MARKET','DEVELOPMENT_INVENTORY','COMING_SOON_DEVELOPMENT','SPONSOR_UNIT') AND "isDuplicate"=false
    UNION ALL SELECT 'Rental listings total', COUNT(*)::bigint FROM "ExtractedOpportunity" WHERE category='RENTAL_LISTING' AND "isDuplicate"=false
  `

  console.log('TOTAL MATCHES:', totalMatches)
  console.log('\nBY COUNTERPART TYPE:')
  byType.forEach(r => console.log(`  ${r.counterpartType.padEnd(25)} ${r._count._all}`))
  console.log('\nSCORE BUCKETS:')
  scoreBuckets.forEach(r => console.log(`  ${r.bucket.padEnd(10)} ${r.n}`))
  console.log('\nPOOL SIZES:')
  counts.forEach(r => console.log(`  ${r.label.padEnd(25)} ${r.n}`))
  console.log('\nTOP 10 BUYERS BY MATCH COUNT (these are the multi-match hubs):')
  topBuyers.forEach(r => console.log(`  ${String(r.n).padEnd(5)} → ${(r.extractedTitle ?? '').slice(0, 80)} [${r.neighborhood ?? '?'} | ${r.beds ?? '?'}BR | $${r.minPrice ?? 0}-$${r.maxPrice ?? 0}]`))
  console.log('\nTOP 10 OPPORTUNITIES (primary side) BY MATCH COUNT:')
  topListings.forEach(r => console.log(`  ${String(r.n).padEnd(5)} → ${(r.extractedTitle ?? '').slice(0, 80)} [${r.address ?? '?'}]`))
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

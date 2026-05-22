import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  const r = await (prisma as any).$queryRawUnsafe(`
    SELECT 
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE eo.category IN ('ACTIVE_SALE_LISTING','COMING_SOON_SALE','OFF_MARKET_SALE','PRICE_DROP','BACK_ON_MARKET'))::int as sales,
      COUNT(*) FILTER (WHERE eo.category = 'RENTAL_LISTING')::int as rentals,
      MIN(eo."createdAt")::date as earliest,
      MAX(eo."createdAt")::date as latest
    FROM "ExtractedOpportunity" eo
    JOIN "RawEmail" re ON re.id = eo."rawEmailId"
    WHERE re."graphMessageId" = 'streeteasy-hotsheet-synthetic'
  `) as any[]
  console.log(JSON.stringify(r[0], null, 2))
  await (prisma as any).$disconnect()
}
main()

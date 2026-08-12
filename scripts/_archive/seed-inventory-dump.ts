import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  const rows = await prisma.extractedOpportunity.findMany({
    where: { isTestData: true, processingStatus: 'active', isDuplicate: false },
    orderBy: { id: 'asc' },
    select: {
      id: true, category: true, extractedTitle: true, address: true,
      neighborhood: true, borough: true, beds: true, price: true,
      minPrice: true, maxPrice: true,
    },
  })
  console.log(`Total active seed rows: ${rows.length}`)
  const byCat = new Map<string, typeof rows>()
  for (const r of rows) {
    const arr = byCat.get(r.category) ?? []
    arr.push(r)
    byCat.set(r.category, arr)
  }
  for (const [cat, arr] of [...byCat.entries()].sort()) {
    console.log(`\n═══ ${cat} (${arr.length}) ═══`)
    for (const r of arr) {
      const price = r.price ?? (r.minPrice != null && r.maxPrice != null ? `${r.minPrice}-${r.maxPrice}` : (r.maxPrice ?? r.minPrice ?? '?'))
      const beds = r.beds != null ? `${r.beds}BR` : '?BR'
      console.log(`  ${r.id.padEnd(20)} | ${beds.padEnd(4)} | $${String(price).padEnd(20)} | ${(r.neighborhood ?? '?').padEnd(20)} | ${r.address ?? ''}`)
    }
  }
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })

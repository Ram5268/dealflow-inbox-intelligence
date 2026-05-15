import { prisma } from './lib/prisma'
import { Category } from '@prisma/client'

async function test() {
  const categoryFilter = [Category.RENTAL_LISTING]
  const searchNeighborhoods = ['dumbo', 'fort greene', 'brooklyn heights', 'vinegar hill', 'boerum hill']
  const catClause = categoryFilter ? [{ category: { in: categoryFilter } }] : []
  
  const result = await prisma.extractedOpportunity.findMany({
    where: {
      AND: [
        { isDuplicate: false },
        ...catClause,
        {
          OR: searchNeighborhoods.flatMap(n => [
            { neighborhood: { contains: n, mode: 'insensitive' } },
            { address: { contains: n, mode: 'insensitive' } },
          ])
        }
      ]
    },
    select: { id: true, extractedTitle: true, category: true, neighborhood: true, beds: true },
    take: 20
  })
  
  console.log('\n=== WITH RENTAL_LISTING FILTER ===')
  console.log('Results found:', result.length)
  if (result.length > 0) {
    console.table(result.map(r => ({ 
      title: r.extractedTitle?.slice(0, 40) || 'N/A', 
      category: r.category, 
      neighborhood: r.neighborhood || 'N/A', 
      beds: r.beds || 'N/A' 
    })))
  } else {
    console.log('(no results)')
  }
  
  await prisma.$disconnect()
}

test().catch(e => {
  console.error('Error:', e)
  process.exit(1)
})

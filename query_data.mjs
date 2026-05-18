import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

try {
  const data = await prisma.extractedOpportunity.findMany({
    take: 30,
    orderBy: { createdAt: 'desc' },
    select: {
      category: true,
      transactionType: true,
      address: true,
      neighborhood: true,
      borough: true,
      city: true,
      state: true,
      zip: true,
      price: true,
      minPrice: true,
      maxPrice: true,
      beds: true,
      baths: true,
      units: true,
      squareFeet: true,
      propertyType: true,
      sourceAgentName: true,
      sourceAgentEmail: true,
      sourceBrokerage: true,
      availabilityDate: true,
      extractedTitle: true,
      extractedSummary: true,
      classificationReason: true,
      confidenceScore: true,
      processingStatus: true
    }
  });
  console.log(JSON.stringify(data, null, 2));
} catch (err) {
  console.error('Database Error:', err.message);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}

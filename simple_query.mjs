import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

try {
  const data = await prisma.extractedOpportunity.findMany({ take: 5 });
  console.log('Found records:', data.length);
  console.log(JSON.stringify(data, null, 2));
} catch (err) {
  console.error('Error:', err.message);
} finally {
  await prisma.$disconnect();
}

import { prisma } from '../lib/prisma'

async function main() {
  const [contacts, raw, sample] = await Promise.all([
    prisma.mojoContact.count(),
    prisma.mojoRaw.count(),
    prisma.mojoContact.findMany({ take: 3, orderBy: { syncedAt: 'desc' }, select: { fullName: true, neighborhood: true, status: true, mojoList: true, syncedAt: true } }),
  ])
  console.log('MojoContacts in DB:', contacts)
  console.log('MojoRaw rows:', raw)
  console.log('Recent contacts:', JSON.stringify(sample, null, 2))
}

main().catch(console.error).finally(() => prisma.$disconnect())

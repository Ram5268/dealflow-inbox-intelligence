import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  // 1. Create the singleton org (idempotent — slug is unique).
  const org = await prisma.organization.upsert({
    where:  { slug: 'dealflow-ryan' },
    update: {},
    create: {
      name: 'Dealflow — Ryan Martin',
      slug: 'dealflow-ryan',
      plan: 'trial',
    },
  })
  console.log(`\n✅ Singleton org: ${org.id}`)
  console.log(`   Name: ${org.name}`)
  console.log(`   Slug: ${org.slug}\n`)

  // 2. Backfill organizationId across every data-bearing table.
  const updates: Array<[string, Promise<{ count: number }>]> = [
    ['User',                  prisma.user.updateMany({                 where: { organizationId: null }, data: { organizationId: org.id } })],
    ['ConnectedMailbox',      prisma.connectedMailbox.updateMany({     where: { organizationId: null }, data: { organizationId: org.id } })],
    ['RawEmail',              prisma.rawEmail.updateMany({             where: { organizationId: null }, data: { organizationId: org.id } })],
    ['ExtractedOpportunity',  prisma.extractedOpportunity.updateMany({ where: { organizationId: null }, data: { organizationId: org.id } })],
    ['SearchQuery',           prisma.searchQuery.updateMany({          where: { organizationId: null }, data: { organizationId: org.id } })],
    ['AuditLog',              prisma.auditLog.updateMany({             where: { organizationId: null }, data: { organizationId: org.id } })],
    ['ChatSession',           prisma.chatSession.updateMany({          where: { organizationId: null }, data: { organizationId: org.id } })],
    ['ChatMessage',           prisma.chatMessage.updateMany({          where: { organizationId: null }, data: { organizationId: org.id } })],
    ['MojoRaw',               prisma.mojoRaw.updateMany({              where: { organizationId: null }, data: { organizationId: org.id } })],
    ['MojoContact',           prisma.mojoContact.updateMany({          where: { organizationId: null }, data: { organizationId: org.id } })],
    ['InstantlyEvent',        prisma.instantlyEvent.updateMany({       where: { organizationId: null }, data: { organizationId: org.id } })],
    ['Match',                 prisma.match.updateMany({                where: { organizationId: null }, data: { organizationId: org.id } })],
    ['PushSubscription',      prisma.pushSubscription.updateMany({     where: { organizationId: null }, data: { organizationId: org.id } })],
    ['Attachment',            prisma.attachment.updateMany({           where: { organizationId: null }, data: { organizationId: org.id } })],
    ['Property',              prisma.property.updateMany({             where: { organizationId: null }, data: { organizationId: org.id } })],
    ['ListingStatusHistory',  prisma.listingStatusHistory.updateMany({ where: { organizationId: null }, data: { organizationId: org.id } })],
    ['PropertyIntelligence',  prisma.propertyIntelligence.updateMany({ where: { organizationId: null }, data: { organizationId: org.id } })],
    ['CriteriaProfile',       prisma.criteriaProfile.updateMany({      where: { organizationId: null }, data: { organizationId: org.id } })],
    ['ReviewQueueItem',       prisma.reviewQueueItem.updateMany({      where: { organizationId: null }, data: { organizationId: org.id } })],
    ['AIExtractionLog',       prisma.aIExtractionLog.updateMany({      where: { organizationId: null }, data: { organizationId: org.id } })],
    ['OutcomeFeedback',       prisma.outcomeFeedback.updateMany({      where: { organizationId: null }, data: { organizationId: org.id } })],
  ]

  console.log('Backfilling organizationId on existing rows…\n')
  for (const [label, promise] of updates) {
    const r = await promise
    console.log(`  ${label.padEnd(25)} ${r.count} rows`)
  }
  console.log('\n✅ Backfill complete.')
}

main()
  .catch(e => { console.error('\n❌ Backfill failed:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())

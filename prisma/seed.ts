import 'dotenv/config'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, Category, TransactionType } from '@prisma/client'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 47 (PR 2), engineering precaution (Brief 41.2 found-not-fixed;
// confirmed 2026-10-18): this writes demo emails and listings, and it's run by
// `npm run db:seed` and `prisma db seed`, from a folder whose .env may point at
// production. So, like the seed scripts in scripts/ (Brief 41.2 PR B's
// test-or-seed rule), it refuses any database but a *_perf or *_test one, with
// no override. .env is loaded first (the first import), and this runs before
// the pool is built, so it checks the URL the seed really uses
// (lib/__tests__/scriptGuards.test.ts checks).
refuseLiveDatabase(process.env.DATABASE_URL, 'prisma/seed.ts')

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  console.log('Seeding demo data...')

  const org = await prisma.organization.findUnique({
    where:  { slug: 'dealflow-ryan' },
    select: { id: true },
  })
  if (!org) {
    throw new Error(
      'Singleton organization "dealflow-ryan" not found. ' +
      'Run scripts/seed-tenancy.ts first.'
    )
  }
  const organizationId = org.id

  // Seed demo raw emails
  const emails = await Promise.all([
    prisma.rawEmail.upsert({
      where: { graphMessageId: 'demo-001' },
      create: {
        organizationId,
        graphMessageId: 'demo-001',
        subject: 'Coming Soon | 2-Family in Bed-Stuy | $1,995,000',
        senderName: 'Sarah Chen',
        senderEmail: 'sarah.chen@compass.com',
        receivedDateTime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        bodyPreview:
          'Hi Ryan, I have a beautiful 2-family coming to market in the heart of Bed-Stuy. 4br/2ba over 3br/1ba, fully renovated, private backyard. Asking $1,995,000. Available for showings next week.',
        processed: true,
      },
      update: {},
    }),
    prisma.rawEmail.upsert({
      where: { graphMessageId: 'demo-002' },
      create: {
        organizationId,
        graphMessageId: 'demo-002',
        subject: 'ISO: Brooklyn Multifamily | Budget up to $2.5M | Pre-approved buyer',
        senderName: 'Marcus Williams',
        senderEmail: 'marcus@bhsusa.com',
        receivedDateTime: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        bodyPreview:
          'Hey team, I have a serious pre-approved buyer looking for a 2-4 family in Brooklyn. Neighborhoods: Bed-Stuy, Crown Heights, Prospect Heights, or similar. Budget up to $2.5M. Can close in 60 days. Please send over anything you have!',
        processed: true,
      },
      update: {},
    }),
    prisma.rawEmail.upsert({
      where: { graphMessageId: 'demo-003' },
      create: {
        organizationId,
        graphMessageId: 'demo-003',
        subject: 'Renter inquiry - 1BR in Williamsburg, up to $3,500/mo',
        senderName: 'Apartment.com Lead',
        senderEmail: 'leads@apartments.com',
        receivedDateTime: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        bodyPreview:
          'A renter inquiry from your listing. Tenant is looking for a 1BR in Williamsburg or Greenpoint, budget up to $3,500/month, would like to move in by the 1st of next month. Please contact: Michael Torres, mtorres@gmail.com',
        processed: true,
      },
      update: {},
    }),
    prisma.rawEmail.upsert({
      where: { graphMessageId: 'demo-004' },
      create: {
        organizationId,
        graphMessageId: 'demo-004',
        subject: 'Just Listed | 2BR/2BA Upper West Side | $1,450,000',
        senderName: 'Douglas Elliman Blast',
        senderEmail: 'listings@elliman.com',
        receivedDateTime: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        bodyPreview:
          'NEW LISTING: 310 West 79th Street, Apt 4C. Stunning 2BR/2BA in full-service co-op. Renovated kitchen, city views, prewar details throughout. $1,450,000. Open house this Sunday 12-2pm.',
        processed: true,
      },
      update: {},
    }),
    prisma.rawEmail.upsert({
      where: { graphMessageId: 'demo-005' },
      create: {
        organizationId,
        graphMessageId: 'demo-005',
        subject: 'Open House This Weekend | Clinton Hill Townhouse',
        senderName: 'Corcoran Group',
        senderEmail: 'agents@corcoran.com',
        receivedDateTime: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
        bodyPreview:
          'You are invited to an open house at 427 Waverly Avenue, Clinton Hill. Saturday 1-3pm and Sunday 2-4pm. 3-story limestone townhouse, 4BR, original details, private garden, asking $2,750,000.',
        processed: true,
      },
      update: {},
    }),
    prisma.rawEmail.upsert({
      where: { graphMessageId: 'demo-006' },
      create: {
        organizationId,
        graphMessageId: 'demo-006',
        subject: 'BACK ON MARKET | Brooklyn Heights Condo | $875,000',
        senderName: 'Compass Listing Alerts',
        senderEmail: 'alerts@compass.com',
        receivedDateTime: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
        bodyPreview:
          'Deal fell through — back on market! 1BR/1BA at 100 Remsen Street, Brooklyn Heights. Gorgeous pre-war details, exposed brick, $875,000. Previous buyer had financing issues. Seller is motivated.',
        processed: true,
      },
      update: {},
    }),
    prisma.rawEmail.upsert({
      where: { graphMessageId: 'demo-007' },
      create: {
        organizationId,
        graphMessageId: 'demo-007',
        subject: 'Price Improvement | Park Slope 3BR | Now $1,299,000 (was $1,399,000)',
        senderName: 'Sotheby\'s International Realty',
        senderEmail: 'listings@sothebysrealty.com',
        receivedDateTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        bodyPreview:
          'Price improvement on 543 7th Street, Park Slope. Spacious 3BR/2BA condo now at $1,299,000 (reduced from $1,399,000). Seller motivated to close before the end of the month.',
        processed: true,
      },
      update: {},
    }),
    prisma.rawEmail.upsert({
      where: { graphMessageId: 'demo-008' },
      create: {
        organizationId,
        graphMessageId: 'demo-008',
        subject: 'RE: Team lunch this Friday',
        senderName: 'Jennifer Marks',
        senderEmail: 'jmarks@elliman.com',
        receivedDateTime: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        bodyPreview:
          'Hi Ryan, lunch is confirmed for Friday at 12:30pm at the usual spot. Let me know if you can make it!',
        processed: true,
      },
      update: {},
    }),
  ])

  console.log(`Created ${emails.length} demo raw emails`)

  // Seed extracted opportunities
  const ops = await Promise.all([
    prisma.extractedOpportunity.upsert({
      where: { id: 'demo-op-001' },
      create: {
        organizationId,
        id: 'demo-op-001',
        rawEmailId: emails[0].id,
        category: Category.COMING_SOON_SALE,
        transactionType: TransactionType.SALE,
        propertyType: '2-family',
        address: null,
        neighborhood: 'Bed-Stuy',
        borough: 'Brooklyn',
        city: 'New York',
        state: 'NY',
        zip: null,
        price: 1995000,
        beds: 7,
        baths: 3,
        units: 2,
        sourceAgentName: 'Sarah Chen',
        sourceAgentEmail: 'sarah.chen@compass.com',
        sourceBrokerage: 'Compass',
        extractedTitle: 'Coming Soon: Bed-Stuy 2-Family $1.995M',
        extractedSummary: 'Renovated 2-family in Bed-Stuy, 4br/2ba over 3br/1ba, private backyard. Coming to market next week.',
        classificationReason: 'Agent explicitly states "coming to market" and property details match 2-family sale.',
        confidenceScore: 0.95,
      },
      update: {},
    }),
    prisma.extractedOpportunity.upsert({
      where: { id: 'demo-op-002' },
      create: {
        organizationId,
        id: 'demo-op-002',
        rawEmailId: emails[1].id,
        category: Category.BUYER_ISO,
        transactionType: TransactionType.BUYER_NEED,
        propertyType: 'multifamily',
        neighborhood: 'Bed-Stuy / Crown Heights / Prospect Heights',
        borough: 'Brooklyn',
        city: 'New York',
        state: 'NY',
        maxPrice: 2500000,
        units: 4,
        sourceAgentName: 'Marcus Williams',
        sourceAgentEmail: 'marcus@bhsusa.com',
        sourceBrokerage: 'Brown Harris Stevens',
        clientSide: 'buyer',
        extractedTitle: 'Buyer ISO: Brooklyn 2-4 Family up to $2.5M',
        extractedSummary: 'Pre-approved buyer looking for 2-4 family in Bed-Stuy, Crown Heights, or Prospect Heights. Budget $2.5M, can close in 60 days.',
        classificationReason: 'ISO keyword and explicit buyer criteria with neighborhoods and budget.',
        confidenceScore: 0.97,
      },
      update: {},
    }),
    prisma.extractedOpportunity.upsert({
      where: { id: 'demo-op-003' },
      create: {
        organizationId,
        id: 'demo-op-003',
        rawEmailId: emails[2].id,
        category: Category.RENTER_INQUIRY,
        transactionType: TransactionType.RENTER_NEED,
        propertyType: '1BR apartment',
        neighborhood: 'Williamsburg',
        borough: 'Brooklyn',
        city: 'New York',
        state: 'NY',
        maxPrice: 3500,
        beds: 1,
        sourceAgentName: null,
        sourceAgentEmail: null,
        sourceBrokerage: null,
        clientSide: 'renter',
        extractedTitle: 'Renter Inquiry: 1BR Williamsburg/Greenpoint up to $3,500/mo',
        extractedSummary: 'Tenant looking for 1BR in Williamsburg or Greenpoint, budget $3,500/mo, wants to move in by 1st of next month.',
        classificationReason: 'Renter inquiry from portal lead, explicit budget and neighborhood.',
        confidenceScore: 0.92,
      },
      update: {},
    }),
    prisma.extractedOpportunity.upsert({
      where: { id: 'demo-op-004' },
      create: {
        organizationId,
        id: 'demo-op-004',
        rawEmailId: emails[3].id,
        category: Category.ACTIVE_SALE_LISTING,
        transactionType: TransactionType.SALE,
        propertyType: 'condo',
        address: '310 West 79th Street, Apt 4C',
        neighborhood: 'Upper West Side',
        borough: 'Manhattan',
        city: 'New York',
        state: 'NY',
        price: 1450000,
        beds: 2,
        baths: 2,
        sourceAgentName: null,
        sourceAgentEmail: null,
        sourceBrokerage: 'Douglas Elliman',
        extractedTitle: 'Just Listed: UWS 2BR/2BA Co-op $1.45M',
        extractedSummary: 'Renovated 2BR/2BA at 310 W 79th St in full-service co-op. Open house Sunday 12-2pm.',
        classificationReason: '"Just Listed" and "NEW LISTING" keywords with full address and price.',
        confidenceScore: 0.96,
      },
      update: {},
    }),
    prisma.extractedOpportunity.upsert({
      where: { id: 'demo-op-005' },
      create: {
        organizationId,
        id: 'demo-op-005',
        rawEmailId: emails[4].id,
        category: Category.OPEN_HOUSE,
        transactionType: TransactionType.SALE,
        propertyType: 'townhouse',
        address: '427 Waverly Avenue',
        neighborhood: 'Clinton Hill',
        borough: 'Brooklyn',
        city: 'New York',
        state: 'NY',
        price: 2750000,
        beds: 4,
        sourceAgentName: null,
        sourceAgentEmail: null,
        sourceBrokerage: 'Corcoran',
        extractedTitle: 'Open House: Clinton Hill Limestone Townhouse $2.75M',
        extractedSummary: '3-story limestone townhouse at 427 Waverly Ave, 4BR, private garden. Open house Sat 1-3pm, Sun 2-4pm.',
        classificationReason: '"Open house" keyword with address and price details.',
        confidenceScore: 0.94,
      },
      update: {},
    }),
    prisma.extractedOpportunity.upsert({
      where: { id: 'demo-op-006' },
      create: {
        organizationId,
        id: 'demo-op-006',
        rawEmailId: emails[5].id,
        category: Category.BACK_ON_MARKET,
        transactionType: TransactionType.SALE,
        propertyType: 'condo',
        address: '100 Remsen Street',
        neighborhood: 'Brooklyn Heights',
        borough: 'Brooklyn',
        city: 'New York',
        state: 'NY',
        price: 875000,
        beds: 1,
        baths: 1,
        sourceAgentName: null,
        sourceAgentEmail: null,
        sourceBrokerage: 'Compass',
        status: 'Back on market',
        extractedTitle: 'Back on Market: Brooklyn Heights 1BR $875K',
        extractedSummary: 'Pre-war 1BR/1BA at 100 Remsen St, Brooklyn Heights. Previous deal fell through, seller motivated.',
        classificationReason: '"Back on market" and "deal fell through" with price and motivated seller signals.',
        confidenceScore: 0.93,
      },
      update: {},
    }),
    prisma.extractedOpportunity.upsert({
      where: { id: 'demo-op-007' },
      create: {
        organizationId,
        id: 'demo-op-007',
        rawEmailId: emails[6].id,
        category: Category.PRICE_DROP,
        transactionType: TransactionType.SALE,
        propertyType: 'condo',
        address: '543 7th Street',
        neighborhood: 'Park Slope',
        borough: 'Brooklyn',
        city: 'New York',
        state: 'NY',
        price: 1299000,
        beds: 3,
        baths: 2,
        sourceAgentName: null,
        sourceAgentEmail: null,
        sourceBrokerage: "Sotheby's International Realty",
        status: 'Price reduced',
        extractedTitle: 'Price Drop: Park Slope 3BR $1.299M (was $1.399M)',
        extractedSummary: 'Park Slope 3BR/2BA condo reduced from $1,399,000 to $1,299,000. Seller wants to close end of month.',
        classificationReason: '"Price improvement" and explicit before/after prices with motivated seller.',
        confidenceScore: 0.96,
      },
      update: {},
    }),
  ])

  console.log(`Created ${ops.length} demo opportunities`)

  // Seed an audit log entry
  await prisma.auditLog.create({
    data: {
      organizationId,
      action: 'SEED',
      detailsJson: {
        message: 'Demo data seeded',
        rawEmailCount: emails.length,
        opportunityCount: ops.length,
      },
    },
  })

  console.log('Seed complete!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

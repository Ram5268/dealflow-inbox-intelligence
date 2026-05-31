import 'dotenv/config'
import { prisma } from '../lib/prisma'

async function main() {
  const org = await prisma.organization.findUnique({ where: { slug: 'dealflow-ryan' } })
  if (!org) throw new Error('Singleton org not found.')
  console.log(`Org: ${org.id} — ${org.name}\n`)

  const counts = await prisma.$queryRaw<Array<{ label: string; n: bigint }>>`
    SELECT 'User'                     AS label, COUNT(*)::bigint AS n FROM "User"                     WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'ConnectedMailbox',      COUNT(*)::bigint FROM "ConnectedMailbox"      WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'RawEmail',              COUNT(*)::bigint FROM "RawEmail"              WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'ExtractedOpportunity',  COUNT(*)::bigint FROM "ExtractedOpportunity"  WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'MojoContact',           COUNT(*)::bigint FROM "MojoContact"           WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'Match',                 COUNT(*)::bigint FROM "Match"                 WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'Attachment',            COUNT(*)::bigint FROM "Attachment"            WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'Property',              COUNT(*)::bigint FROM "Property"              WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'ReviewQueueItem',       COUNT(*)::bigint FROM "ReviewQueueItem"       WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'AIExtractionLog',       COUNT(*)::bigint FROM "AIExtractionLog"       WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'ChatSession',           COUNT(*)::bigint FROM "ChatSession"           WHERE "organizationId" = ${org.id}
    UNION ALL SELECT 'ChatMessage',           COUNT(*)::bigint FROM "ChatMessage"           WHERE "organizationId" = ${org.id}
  `
  counts.forEach(r => console.log(`  ${r.label.padEnd(25)} ${r.n}`))

  // Sanity: no orphans
  const orphans = await prisma.$queryRaw<Array<{ table_name: string; orphans: bigint }>>`
    SELECT 'ExtractedOpportunity' AS table_name, COUNT(*)::bigint AS orphans FROM "ExtractedOpportunity" WHERE "organizationId" IS NULL
    UNION ALL SELECT 'RawEmail',     COUNT(*)::bigint FROM "RawEmail"     WHERE "organizationId" IS NULL
    UNION ALL SELECT 'MojoContact',  COUNT(*)::bigint FROM "MojoContact"  WHERE "organizationId" IS NULL
    UNION ALL SELECT 'Match',        COUNT(*)::bigint FROM "Match"        WHERE "organizationId" IS NULL
  `
  console.log('\nOrphans (should all be 0):')
  orphans.forEach(r => console.log(`  ${r.table_name.padEnd(25)} ${r.orphans}`))
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

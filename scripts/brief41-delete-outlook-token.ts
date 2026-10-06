// Brief 41 (H10) — delete the stored Outlook login (ConnectedMailbox 'runtime-token').
//
// Outlook is on a compliance pause and GRAPH_ENABLED keeps the code from using a
// token, but the row itself still holds an access token and a refresh token in
// plain text. This removes it. A production data step: run it only with Ryan's
// OK. It never prints a token.
//
//   npx tsx scripts/brief41-delete-outlook-token.ts            # dry run (default): report only
//   npx tsx scripts/brief41-delete-outlook-token.ts --apply    # delete the row + an AuditLog entry
import 'dotenv/config'
import { prisma } from '../lib/prisma'

const ID = 'runtime-token'

async function main() {
  const apply = process.argv.includes('--apply')
  const row = await prisma.connectedMailbox.findUnique({
    where: { id: ID },
    select: {
      organizationId: true, email: true, provider: true, lastSyncAt: true, createdAt: true, updatedAt: true,
      accessTokenEncrypted: true, refreshTokenEncrypted: true,
    },
  })
  if (!row) {
    console.log(`No ConnectedMailbox '${ID}' row. Nothing to do.`)
    return
  }
  const emailsLinked = await prisma.rawEmail.count({ where: { mailboxId: ID } })
  console.log(JSON.stringify({
    found: ID,
    provider: row.provider,
    email: row.email,
    hasAccessToken: !!row.accessTokenEncrypted,
    hasRefreshToken: !!row.refreshTokenEncrypted,
    accessTokenExpiry: row.lastSyncAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    emailsLinkedToRow: emailsLinked,
  }, null, 2))

  if (!apply) {
    console.log('Dry run: nothing changed. Re-run with --apply to delete this row.')
    return
  }
  if (emailsLinked > 0) {
    console.log(`Refusing: ${emailsLinked} stored emails point at this row. Ask before going further.`)
    process.exitCode = 2
    return
  }
  await prisma.$transaction([
    prisma.connectedMailbox.delete({ where: { id: ID } }),
    prisma.auditLog.create({
      data: {
        organizationId: row.organizationId,
        action: 'OUTLOOK_TOKEN_DELETED',
        detailsJson: { source: 'brief41-delete-outlook-token', at: new Date().toISOString(), hadRefreshToken: !!row.refreshTokenEncrypted },
      },
    }),
  ])
  console.log(`Deleted ConnectedMailbox '${ID}' and logged OUTLOOK_TOKEN_DELETED.`)
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())

import 'dotenv/config'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { getMessageAttachments } from '../lib/microsoftGraph'
import { maintenanceApply, scriptArgs } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
// The dry run counts the candidates and calls nothing.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/backfill-attachments.ts (DATABASE_URL)')

// One-shot Phase 3D bootstrap. Finds RawEmail rows that flagged
// hasAttachments=true upstream but have no Attachment rows persisted (the
// pre-Phase-3D state of the table) and re-fetches the attachment bytes from
// Microsoft Graph. Strictly GET — read-only-rule compliant.
//
// Usage:
//   tsx scripts/backfill-attachments.ts                  # dry run: count the candidates
//   tsx scripts/backfill-attachments.ts --apply          # backfill 10 most recent
//   tsx scripts/backfill-attachments.ts --apply 25       # backfill N most recent

const MAX_FETCH_BYTES = 30 * 1024 * 1024   // 30MB — matches processAttachments PDF cap

function toPrismaBytes(b64: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(b64, 'base64')
  const ab  = new ArrayBuffer(buf.byteLength)
  const u8  = new Uint8Array(ab)
  u8.set(buf)
  return u8
}

async function main() {
  const [count] = scriptArgs()
  const limit = count ? parseInt(count, 10) : 10
  if (Number.isNaN(limit) || limit <= 0) {
    console.error('Usage: tsx scripts/backfill-attachments.ts [--apply [--i-mean-live]] [count=10]')
    process.exit(1)
  }

  // Targets: emails whose Graph payload said hasAttachments=true AND that
  // currently have zero Attachment rows. (Pre-Phase-3D emails.)
  const where: Prisma.RawEmailWhereInput = {
    rawJson:     { path: ['hasAttachments'], equals: true },
    attachments: { none: {} },
  }
  if (!APPLY) {
    const total = await prisma.rawEmail.count({ where })
    console.log(`[backfill] Dry run: ${total} candidate emails in all; --apply would backfill the ${Math.min(total, limit)} most recent. Nothing fetched or written.`)
    console.log('[backfill] Re-run with --apply to fetch their attachments from Outlook and save them.')
    return
  }
  const candidates = await prisma.rawEmail.findMany({
    where,
    select: { id: true, graphMessageId: true, subject: true, organizationId: true, receivedDateTime: true },
    orderBy: { receivedDateTime: 'desc' },
    take:    limit,
  })

  console.log(`[backfill] ${candidates.length} candidate emails`)

  let attachmentsWritten = 0
  let emailsWithBytes    = 0
  let graphFailures      = 0

  for (const email of candidates) {
    process.stdout.write(`  ${email.id} ${email.subject.slice(0, 60).padEnd(60)} … `)
    let atts
    try {
      atts = await getMessageAttachments(email.graphMessageId, MAX_FETCH_BYTES)
    } catch (e) {
      graphFailures++
      console.log(`GRAPH ERROR: ${(e as Error).message.slice(0, 100)}`)
      continue
    }

    let wroteAny = false
    for (const att of atts) {
      // Only real fileAttachments — skip itemAttachments (forwarded mails) and
      // referenceAttachments (links).
      const odataType = (att as unknown as Record<string, string>)['@odata.type']
      if (odataType && odataType !== '#microsoft.graph.fileAttachment') continue

      const rawBytes = att.contentBytes ? toPrismaBytes(att.contentBytes) : null

      try {
        await prisma.attachment.create({
          data: {
            organizationId: email.organizationId,
            rawEmailId:     email.id,
            name:           att.name ?? '',
            mimeType:       att.contentType ?? '',
            sizeBytes:      typeof att.size === 'number' ? att.size : null,
            contentBytes:   rawBytes,
          },
        })
        attachmentsWritten++
        if (rawBytes) wroteAny = true
      } catch (e) {
        console.log(`\n    [persist] ${att.name}: ${(e as Error).message}`)
      }
    }
    if (wroteAny) emailsWithBytes++
    console.log(`${atts.length} attachments fetched, ${wroteAny ? 'bytes cached' : 'no bytes'}`)
  }

  console.log()
  console.log(`[backfill] done.`)
  console.log(`  attachments written:     ${attachmentsWritten}`)
  console.log(`  emails with cached bytes: ${emailsWithBytes}`)
  console.log(`  graph failures:           ${graphFailures}`)
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1) })

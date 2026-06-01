import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { getMessageAttachments } from '../lib/microsoftGraph'

// One-shot Phase 3D bootstrap. Finds RawEmail rows that flagged
// hasAttachments=true upstream but have no Attachment rows persisted (the
// pre-Phase-3D state of the table) and re-fetches the attachment bytes from
// Microsoft Graph. Strictly GET — read-only-rule compliant.
//
// Usage:
//   tsx scripts/backfill-attachments.ts          # backfill 10 most recent
//   tsx scripts/backfill-attachments.ts 25       # backfill N most recent

const MAX_FETCH_BYTES = 30 * 1024 * 1024   // 30MB — matches processAttachments PDF cap

function toPrismaBytes(b64: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(b64, 'base64')
  const ab  = new ArrayBuffer(buf.byteLength)
  const u8  = new Uint8Array(ab)
  u8.set(buf)
  return u8
}

async function main() {
  const limit = process.argv[2] ? parseInt(process.argv[2], 10) : 10
  if (Number.isNaN(limit) || limit <= 0) {
    console.error('Usage: tsx scripts/backfill-attachments.ts [count=10]')
    process.exit(1)
  }

  // Targets: emails whose Graph payload said hasAttachments=true AND that
  // currently have zero Attachment rows. (Pre-Phase-3D emails.)
  const candidates = await prisma.rawEmail.findMany({
    where: {
      rawJson:     { path: ['hasAttachments'], equals: true },
      attachments: { none: {} },
    },
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

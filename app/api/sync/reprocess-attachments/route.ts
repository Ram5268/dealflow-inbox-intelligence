export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getMessageAttachments, testConnection } from '@/lib/microsoftGraph'
import { parseAttachment } from '@/lib/attachmentParser'
import { isIngestionTestModeOnly } from '@/lib/config/ingestionTestMode'
import { maintenanceEnabled, MAINTENANCE_OFF_BODY } from '@/lib/config/maintenance'

export const maxDuration = 300

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const CONCURRENCY = 2 // Graph MailboxConcurrency limit — keep low

async function processEmail(graphMessageId: string, dbId: string): Promise<{ status: 'ok' | 'none' | 'error'; error?: string }> {
  try {
    console.log(`[Reprocess] Fetching attachments for ${graphMessageId.slice(-10)}`)
    const attachments = await getMessageAttachments(graphMessageId)
    console.log(`[Reprocess] Got ${attachments.length} attachment(s)`)

    const parts: string[] = []
    for (const att of attachments) {
      console.log(`[Reprocess] Attachment: "${att.name}" size=${att.size} hasBytes=${!!att.contentBytes}`)
      if (att.size > MAX_ATTACHMENT_BYTES) {
        parts.push(`[attachment: ${att.name} — too large]`)
        continue
      }
      if (att.contentBytes) {
        console.log(`[Reprocess] Calling parseAttachment for: ${att.name}`)
        let text = ''
        try {
          text = await parseAttachment(att.name, att.contentType, att.contentBytes)
        } catch (parseErr) {
          console.error(`[Reprocess] parseAttachment threw for ${att.name}:`, (parseErr as Error).message)
        }
        console.log(`[Reprocess] parseAttachment result length: ${text.length}`)
        if (text.trim()) parts.push(`--- ${att.name} ---\n${text}`)
      } else {
        console.log(`[Reprocess] Skipping ${att.name} — no contentBytes`)
      }
    }
    const attachmentsText = parts.length > 0 ? parts.join('\n\n') : ''
    await prisma.rawEmail.update({ where: { id: dbId }, data: { attachmentsText } })
    return { status: parts.length > 0 ? 'ok' : 'none' }
  } catch (e) {
    const msg = (e as Error).message
    console.error(`[Reprocess] Failed ${graphMessageId.slice(-10)}:`, msg)
    console.error((e as Error).stack)
    await prisma.rawEmail.update({ where: { id: dbId }, data: { attachmentsText: '' } }).catch(() => {})
    return { status: 'error', error: msg }
  }
}

// Maintenance route (Brief 41's H6 switch, added here in Brief 48 PR 2
// [planner, Brief 48]): off unless MAINTENANCE_ENABLED=true. Nothing in the app
// calls it; past the switches it fetches from Outlook the attachments of every
// email with no saved attachment text, and saves that text.
export async function POST() {
  if (!maintenanceEnabled()) return NextResponse.json(MAINTENANCE_OFF_BODY, { status: 403 })
  // Brief 6.0 — ingestion isolation gate. Blocks production attachment
  // reprocessing (real Graph fetches + DB writes) during fixture validation.
  if (isIngestionTestModeOnly()) {
    return NextResponse.json(
      { ok: false, reason: 'INGESTION_TEST_MODE_ONLY is on' },
      { status: 423 },
    )
  }

  // Fail fast if token is invalid
  const conn = await testConnection()
  if (!conn.ok) {
    return NextResponse.json(
      { error: `Graph token invalid: ${conn.error}. Paste a fresh token in Settings first.` },
      { status: 401 }
    )
  }

  const toProcess = await prisma.rawEmail.findMany({
    where: { attachmentsText: null },
    select: { id: true, graphMessageId: true },
  })

  console.log(`[Reprocess] ${toProcess.length} emails to check, ${CONCURRENCY} at a time`)

  let withAttachments = 0
  let failed = 0
  const firstErrors: string[] = []

  // Process in batches of CONCURRENCY
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const batch = toProcess.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(e => processEmail(e.graphMessageId, e.id))
    )
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.status === 'ok') withAttachments++
        if (r.value.status === 'error') {
          failed++
          if (firstErrors.length < 3 && r.value.error) firstErrors.push(r.value.error)
        }
      } else {
        failed++
        if (firstErrors.length < 3) firstErrors.push(r.reason?.message ?? 'unknown')
      }
    }
    console.log(`[Reprocess] Progress: ${Math.min(i + CONCURRENCY, toProcess.length)}/${toProcess.length}`)
    await new Promise(r => setTimeout(r, 300)) // respect Graph rate limits

    // Stop early if first batch all failed — likely a token issue
    if (i === 0 && failed === batch.length && withAttachments === 0) {
      return NextResponse.json({
        total: toProcess.length, withAttachments: 0, failed,
        error: 'All requests failed — token may be expired. First errors:',
        firstErrors,
      }, { status: 502 })
    }
  }

  return NextResponse.json({ total: toProcess.length, withAttachments, failed, firstErrors })
}

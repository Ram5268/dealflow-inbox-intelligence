// Brief 41 (H7), tightened in Brief 41.1 (PR H): the cutoff guard and the
// record-keeping for scripts/brief41-withdraw-old-buyer-reports.ts. No DB
// client and no network here: the script passes its Prisma client in, and the
// tests pass fakes.
//
// - --before must be a full ISO time with a time zone, and not later than now
//   (a later one would also withdraw reports made after the fix).
// - The ids of the withdrawn reports and chat messages go to a private JSON
//   file (written before anything changes) and to the AuditLog entry. The old
//   content is not kept anywhere: it is what the fix withdraws.
import type { Prisma, PrismaClient } from '@prisma/client'

export const SOURCE = 'brief41-withdraw-old-buyer-reports'
export const AUDIT_ACTION = 'OLD_BUYER_REPORTS_WITHDRAWN'
export const TEMPLATE = 'buyer-match'
export const NOTE = 'This report was made before a privacy fix (Brief 41) and has been withdrawn. Ask Drift to make it again.'
export const SECTION_NOTE = 'This report section was made before a privacy fix (Brief 41) and has been withdrawn. Ask Drift to make it again.'

// The privacy fix (#18) went live at 05:51:09Z. A request already running on
// the old code could still save a report for up to 60 s after that, so the
// cutoff is rounded up past 05:52:09Z.
export const FIX_LIVE_AT = '2026-10-06T05:51:09Z'
export const RECOMMENDED_CUTOFF = '2026-10-06T05:55:00Z'
export const RECOMMENDATION =
  `Recommended cutoff: --before ${RECOMMENDED_CUTOFF} (the fix went live at ${FIX_LIVE_AT}; ` +
  'this leaves the 60 s a request already under way could still take).'

const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/

// The --before cutoff, or why it is refused.
export function parseCutoff(value: string | undefined, now: Date): { before: Date } | { error: string } {
  if (!value || value.startsWith('--')) return { error: `Usage: --before <ISO time the fix went live> [--apply]. ${RECOMMENDATION}` }
  const m = ISO_WITH_ZONE.exec(value)
  const [y, mo, d, h, mi, s, zh, zm] = (m ?? []).slice(1).map((x) => (x === undefined ? 0 : Number(x)))
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  const before = new Date(value)
  if (!m || mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || s > 59 || zh > 14 || zm > 59 || Number.isNaN(before.getTime())) {
    return { error: `Refusing --before "${value}": not a full ISO time with a time zone, such as ${RECOMMENDED_CUTOFF}. Nothing changed.` }
  }
  if (before.getTime() > now.getTime()) {
    return { error: `Refusing --before ${before.toISOString()}: it is later than now (${now.toISOString()}), so it would also withdraw reports made after the fix. Nothing changed. ${RECOMMENDATION}` }
  }
  return { before }
}

export type WithdrawalRecord = {
  what: string
  writtenAt: string
  before: string
  reportIds: string[]
  chatMessageIds: string[]
}

export function withdrawalRecord(before: Date, reportIds: string[], chatMessageIds: string[], now: Date): WithdrawalRecord {
  return {
    what: `${SOURCE}: the Buyer Match reports and chat messages --apply withdraws (ids only; their content is not kept).`,
    writtenAt: now.toISOString(),
    before: before.toISOString(),
    reportIds,
    chatMessageIds,
  }
}

export type WithdrawDb = Pick<PrismaClient, '$transaction' | 'report' | 'chatMessage' | 'auditLog'>

export interface ApplyWithdrawalOptions {
  organizationId: string
  before: Date
  reportIds: string[]
  chatMessageIds: string[]
  now: Date
  // Prisma.DbNull, passed in so this file needs no Prisma runtime import.
  dbNull: Prisma.NullTypes.DbNull
  // Writes the record to a private file and returns its path. Called before
  // any update; if it throws, nothing is changed.
  writeRecord: (record: WithdrawalRecord) => string
  // Where the "written but NOT applied" line goes if the transaction fails
  // (default console.log).
  log?: (line: string) => void
}

export async function applyWithdrawal(db: WithdrawDb, opts: ApplyWithdrawalOptions): Promise<{ recordFile: string }> {
  const { before, reportIds, chatMessageIds } = opts
  const recordFile = opts.writeRecord(withdrawalRecord(before, reportIds, chatMessageIds, opts.now))
  // One transaction: if it fails (a timeout, a dropped connection), nothing is
  // withdrawn. The record file stays, so say it wasn't applied.
  try {
    await db.$transaction([
      db.report.updateMany({
        where: { id: { in: reportIds }, templateId: TEMPLATE, createdAt: { lt: before } },
        data: {
          markdown: NOTE,
          sections: [{ key: 'withdrawn', title: 'Report withdrawn', content: { prose: NOTE }, sources: [] }],
          sources: [],
        },
      }),
      // The chat message that carried a section also restated it in prose.
      db.chatMessage.updateMany({
        where: { id: { in: chatMessageIds }, createdAt: { lt: before }, attachedFragment: { path: ['templateId'], equals: TEMPLATE } },
        data: { attachedFragment: opts.dbNull, content: SECTION_NOTE },
      }),
      db.auditLog.create({
        data: {
          organizationId: opts.organizationId,
          action: AUDIT_ACTION,
          detailsJson: {
            source: SOURCE,
            at: opts.now.toISOString(),
            before: before.toISOString(),
            reports: reportIds.length,
            chatSections: chatMessageIds.length,
            reportIds,
            chatMessageIds,
            recordFile,
          },
        },
      }),
    ])
  } catch (e) {
    (opts.log ?? console.log)(
      `Ids written but probably NOT applied: the transaction failed and was rolled back (if it failed while ` +
      `saving, it may have gone through). Re-run the dry run: the same counts mean nothing changed, 0 means it ` +
      `was applied. Record: ${recordFile}`)
    throw e
  }
  return { recordFile }
}

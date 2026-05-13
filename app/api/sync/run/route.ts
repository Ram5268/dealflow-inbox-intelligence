import { NextResponse } from 'next/server'
import { runIncrementalSync } from '@/lib/backgroundSync'
import { prisma } from '@/lib/prisma'

// Internal route — only calls Microsoft Graph GET requests externally.
export async function POST() {
  const isFirst = (await prisma.rawEmail.count()) === 0

  const result = await runIncrementalSync()

  return NextResponse.json({
    ok: !result.error,
    firstRun: isFirst,
    fetchedCount: result.fetched,
    newEmailCount: result.newEmails,
    newOpportunityCount: result.newOpps,
    skipped: result.skipped,
    error: result.error,
    readOnly: true,
    note: isFirst
      ? 'First sync — pulled last 90 days of inbox.'
      : 'Incremental sync — only fetched emails newer than your most recent stored email.',
  })
}

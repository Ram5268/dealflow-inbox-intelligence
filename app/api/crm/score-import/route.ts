export const dynamic = 'force-dynamic'
export const maxDuration = 300
import { NextRequest, NextResponse } from 'next/server'
import { scoreImport } from '@/lib/importScoring/scoreImport'

// Brief 45 (PR E): POST /api/crm/score-import, called by the CRM right after an
// upload finishes, so the upload's new people are ranked within minutes
// (brief §5.8, CONTRACT §7).
//   body  { importId, token, leadIds }: 1 to 500 lead ids per request (the CRM
//         sends bigger uploads in chunks of 500), and a 43-character one-time
//         token whose SHA-256 the CRM stored on the upload's ImportBatch row
//   200   { importId, generatedAt, includeTestBuyers, ms, scored, skipped }
//   400   invalid_request · 404 not_found · 403 bad_token / not_completed /
//         expired / already_scored: no work done, nothing written
//   500   scoring_failed: the CRM shows "scoring…" until the morning sync
// No login or cron secret: the token is the only key, and it works for one
// upload, for 60 minutes after it finished, until the CRM marks it scored
// [engineering precaution]. Nothing here contacts anyone, and DealFlow's
// nightly call list is never rewritten from here (lib/importScoring/steps.ts).
const MAX_BODY_BYTES = 64 * 1024 // 500 ids of 64 characters fit in about 34 KB

export async function POST(req: NextRequest) {
  let raw: unknown = null
  try {
    const text = await req.text()
    if (Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES) raw = JSON.parse(text)
  } catch {
    raw = null // unreadable JSON is answered like any other invalid body
  }
  const { status, body } = await scoreImport(raw)
  return NextResponse.json(body, { status })
}

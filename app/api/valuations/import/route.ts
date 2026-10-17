export const dynamic = 'force-dynamic'
export const maxDuration = 60
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { checkValuationSecret } from '@/lib/valuations/auth'
import { MAX_BODY_BYTES } from '@/lib/valuations/contract'
import { handleImport } from '@/lib/valuations/importRun'

// Brief 44: the monthly valuation job's only way in (lib/valuations/contract.ts).
// Bearer VALUATION_IMPORT_SECRET, checked before the body is read; fails closed.
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest) {
  const auth = checkValuationSecret(req.headers.get('authorization'), process.env.VALUATION_IMPORT_SECRET)
  if (auth !== 200) {
    return NextResponse.json({ ok: false, error: auth === 500 ? 'not_configured' : 'unauthorized' }, { status: auth, headers: NO_STORE })
  }
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413, headers: NO_STORE })
  }
  let payload: unknown
  try {
    const text = await req.text()
    if (text.length > MAX_BODY_BYTES) return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413, headers: NO_STORE })
    payload = JSON.parse(text)
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400, headers: NO_STORE })
  }
  const result = await handleImport(prisma, await getCurrentOrgId(), payload)
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE })
}

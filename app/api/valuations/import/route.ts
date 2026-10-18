export const dynamic = 'force-dynamic'
export const maxDuration = 60
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { checkServiceKey, refusalBody } from '@/lib/valuations/auth'
import { MAX_BODY_BYTES } from '@/lib/valuations/contract'
import { handleImport } from '@/lib/valuations/importRun'

// Brief 44: the monthly valuation job's only way in (lib/valuations/contract.ts).
// The job's key is checked against the ServiceKey fingerprint before the body is
// read, and anything missing fails closed (lib/valuations/auth.ts).
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(req: NextRequest) {
  const auth = await checkServiceKey(prisma, req.headers.get('authorization'))
  if (auth !== 200) return NextResponse.json(refusalBody(auth), { status: auth, headers: NO_STORE })
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413, headers: NO_STORE })
  }
  let payload: unknown
  try {
    const text = await req.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413, headers: NO_STORE })
    payload = JSON.parse(text)
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400, headers: NO_STORE })
  }
  const result = await handleImport(prisma, await getCurrentOrgId(), payload)
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE })
}

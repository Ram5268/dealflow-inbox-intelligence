export const dynamic = 'force-dynamic'
export const maxDuration = 60
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { checkValuationSecret } from '@/lib/valuations/auth'
import { buildTargets } from '@/lib/valuations/targets'

// Brief 44: the CRM sellers the monthly valuation job values (property address
// fields only). Bearer VALUATION_IMPORT_SECRET; fails closed.
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  const auth = checkValuationSecret(req.headers.get('authorization'), process.env.VALUATION_IMPORT_SECRET)
  if (auth !== 200) {
    return NextResponse.json({ ok: false, error: auth === 500 ? 'not_configured' : 'unauthorized' }, { status: auth, headers: NO_STORE })
  }
  return NextResponse.json(await buildTargets(prisma, await getCurrentOrgId()), { headers: NO_STORE })
}

export const dynamic = 'force-dynamic'
export const maxDuration = 60
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { checkServiceKey, refusalBody } from '@/lib/valuations/auth'
import { buildTargets } from '@/lib/valuations/targets'

// Brief 44: the CRM sellers the monthly valuation job values (property address
// fields only). The same key check as the import (lib/valuations/auth.ts); fails closed.
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  const auth = await checkServiceKey(prisma, req.headers.get('authorization'))
  if (auth !== 200) return NextResponse.json(refusalBody(auth), { status: auth, headers: NO_STORE })
  return NextResponse.json(await buildTargets(prisma, await getCurrentOrgId()), { headers: NO_STORE })
}

export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { buildStatus } from '@/lib/valuations/status'

// Brief 44: public status of the monthly valuation job: last run time, published
// yes/no, counts and gate results. No values, addresses, tax lots or contacts.
export async function GET() {
  try {
    return NextResponse.json(await buildStatus(prisma, await getCurrentOrgId()), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[valuations/status] failed:', (e as Error).message)
    return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

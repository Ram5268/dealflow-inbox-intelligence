export const dynamic = 'force-dynamic'
export const maxDuration = 300
import { NextRequest, NextResponse } from 'next/server'
import { checkCronBearer } from '@/lib/auth/cronBearer'
import { runCrmLeadSync } from '@/lib/crm-sync/runSync'

// Brief 34: nightly pipeline, run by Vercel Cron daily at 09:00 UTC (vercel.json).
// Step 1 is the CRM → DealFlow lead sync; later briefs append scoring and
// ranking steps here. Auth is Bearer CRON_SECRET only, and it fails closed.
export async function GET(req: NextRequest) {
  const auth = checkCronBearer(req.headers.get('authorization'), process.env.CRON_SECRET)
  if (auth !== 200) {
    return NextResponse.json({ error: auth === 500 ? 'CRON_SECRET not configured' : 'unauthorized' }, { status: auth })
  }
  try {
    const crmLeadSync = await runCrmLeadSync()
    return NextResponse.json({ ok: true, crmLeadSync })
  } catch (e) {
    console.error('[nightly-pipeline] crm lead sync failed:', (e as Error).message)
    return NextResponse.json({ ok: false, step: 'crmLeadSync', error: (e as Error).message }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
export const maxDuration = 300
import { NextRequest, NextResponse } from 'next/server'
import { checkCronBearer } from '@/lib/auth/cronBearer'
import { runNightlyPipeline } from '@/lib/nightlyPipeline'

// Nightly pipeline, run by Vercel Cron daily at 09:00 UTC (vercel.json):
// CRM lead sync → scoring → call list (lib/nightlyPipeline.ts). Auth is Bearer
// CRON_SECRET only, and it fails closed. 500 if any step failed.
export async function GET(req: NextRequest) {
  const auth = checkCronBearer(req.headers.get('authorization'), process.env.CRON_SECRET)
  if (auth !== 200) {
    return NextResponse.json({ error: auth === 500 ? 'CRON_SECRET not configured' : 'unauthorized' }, { status: auth })
  }
  const result = await runNightlyPipeline()
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}

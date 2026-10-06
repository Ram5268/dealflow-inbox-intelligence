export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { graphEnabled } from '@/lib/graphAccess'

// Brief 41 — tells the UI whether Outlook features are on, so Settings and the
// /matches Calendar button can hide themselves while Outlook is paused. No DB,
// no Microsoft call.
export async function GET() {
  return NextResponse.json({ enabled: graphEnabled() })
}

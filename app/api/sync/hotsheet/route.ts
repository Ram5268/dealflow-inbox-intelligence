export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { runHotsheetSync } from '@/lib/streetEasyHotsheet'
import { maintenanceEnabled, MAINTENANCE_OFF_BODY } from '@/lib/config/maintenance'

export const maxDuration = 120

// Maintenance route (Brief 41, H6): off unless MAINTENANCE_ENABLED=true.
export async function POST(req: NextRequest) {
  if (!maintenanceEnabled()) return NextResponse.json(MAINTENANCE_OFF_BODY, { status: 403 })
  try {
    const body = await req.json().catch(() => ({}))
    const result = await runHotsheetSync(body.date)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[Hotsheet] Error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

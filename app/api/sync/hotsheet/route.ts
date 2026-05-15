export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { runHotsheetSync } from '@/lib/streetEasyHotsheet'

export const maxDuration = 120

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const result = await runHotsheetSync(body.date)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[Hotsheet] Error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

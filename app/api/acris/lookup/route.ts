import { NextRequest, NextResponse } from 'next/server'
import { lookupProperty, formatForChat } from '@/lib/acris'

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')?.trim()
  if (!address) {
    return NextResponse.json({ error: 'address parameter required' }, { status: 400 })
  }

  try {
    const result = await lookupProperty(address)
    if (!result) {
      return NextResponse.json({ error: 'No ACRIS records found for that address' }, { status: 404 })
    }
    return NextResponse.json({ result, formatted: formatForChat(result) })
  } catch (err) {
    console.error('[ACRIS lookup]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

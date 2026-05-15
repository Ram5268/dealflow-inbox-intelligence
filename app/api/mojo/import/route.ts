export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Accepts a CSV text body exported from Mojo (Full Name, Property Address, Property City,
// Property State, Property Zip Code, Phone, Email, Status, Notes, List Name)
export async function POST(req: NextRequest) {
  const csv = await req.text()
  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return NextResponse.json({ error: 'Empty CSV' }, { status: 400 })

  const headers = lines[0].split(',').map(h => h.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_'))

  const col = (row: string[], name: string) => {
    const variants = [name, name.replace(/_/g, ''), name.replace(/_/g, ' ')]
    for (const v of variants) {
      const i = headers.findIndex(h => h === v || h.includes(v.split('_')[0]))
      if (i !== -1) return (row[i] ?? '').replace(/^"|"$/g, '').trim()
    }
    return ''
  }

  let upserted = 0
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',')
    const fullName = col(row, 'full_name') || col(row, 'name')
    if (!fullName) continue

    // Use a stable synthetic ID from name + phone since CSV has no Mojo ID
    const phone  = col(row, 'phone')
    const mojoId = `csv_${fullName.toLowerCase().replace(/\s+/g, '_')}_${phone.replace(/\D/g, '').slice(-4)}`
    const address = col(row, 'property_address') || col(row, 'address')
    const city    = col(row, 'property_city') || col(row, 'city')
    const state   = col(row, 'property_state') || col(row, 'state')
    const zipCode = col(row, 'property_zip_code') || col(row, 'zip')
    const email   = col(row, 'email')
    const status  = col(row, 'status')
    const notes   = col(row, 'notes')
    const mojoList = col(row, 'list_name') || col(row, 'group')

    await prisma.mojoContact.upsert({
      where:  { mojoId },
      update: { fullName, phone: phone || null, email: email || null, address: address || null, city: city || null, state: state || null, zipCode: zipCode || null, status: status || null, notes: notes || null, mojoList: mojoList || null, mojoGroup: 'NYC Leads', syncedAt: new Date() },
      create: { mojoId, fullName, phone: phone || null, email: email || null, address: address || null, city: city || null, state: state || null, zipCode: zipCode || null, status: status || null, notes: notes || null, mojoList: mojoList || null, mojoGroup: 'NYC Leads', tags: [] },
    })
    upserted++
  }

  return NextResponse.json({ ok: true, upserted })
}

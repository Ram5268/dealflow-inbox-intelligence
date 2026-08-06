export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'

// Parses a single CSV line respecting double-quoted fields (commas inside quotes OK)
function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let cur = ''
  let inQuote = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }  // escaped quote
      else inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      fields.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  fields.push(cur.trim())
  return fields
}

// Accepts a CSV body exported from Mojo CRM
// Supports both Mojo's exact column names and common variants
export async function POST(req: NextRequest) {
  if (isTestModeOnly()) return NextResponse.json({ ok: false, reason: 'TEST_MODE_ONLY is on' })
  const csv = await req.text()
  const lines = csv.split('\n').map(l => l.trimEnd()).filter(Boolean)
  if (lines.length < 2) return NextResponse.json({ error: 'Empty CSV' }, { status: 400 })

  // Normalize header: lowercase, collapse non-alphanumeric to underscore
  const rawHeaders = parseCSVLine(lines[0])
  const headers = rawHeaders.map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''))

  // Build header index map for O(1) lookup
  const idx: Record<string, number> = {}
  headers.forEach((h, i) => { idx[h] = i })

  // Returns cell value for any of the given normalized header names (first match wins)
  const get = (row: string[], ...names: string[]): string => {
    for (const name of names) {
      const i = idx[name]
      if (i !== undefined && row[i] !== undefined) {
        const v = row[i].trim()
        if (v) return v
      }
    }
    return ''
  }

  const organizationId = await getCurrentOrgId()

  let upserted = 0
  let skipped  = 0

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i])
    if (row.every(c => !c)) continue  // blank line

    const fullName = get(row, 'full_name', 'name', 'contact_name')
    if (!fullName) { skipped++; continue }

    // Prefer the real Mojo ID; fall back to synthetic only if absent
    const rawMojoId = get(row, 'lead_id_contact_id', 'lead_id', 'contact_id', 'id')
    const phone     = get(row, 'primary_phone', 'phone', 'phone_1')
    const mojoId    = rawMojoId || `csv_${fullName.toLowerCase().replace(/\s+/g, '_')}_${phone.replace(/\D/g, '').slice(-4)}`

    const address       = get(row, 'property_address', 'address')
    const city          = get(row, 'property_city', 'city')
    const state         = get(row, 'property_state', 'state')
    const zipCode       = get(row, 'property_zip_code', 'zip_code', 'zip')
    const email         = get(row, 'email_1', 'email', 'email_address')
    const mojoList      = get(row, 'list', 'list_name', 'group', 'calling_list')
    const notes         = get(row, 'notes', 'note')

    // Last Call Result is the most current status field in Mojo
    const status        = get(row, 'last_call_result', 'call_result', 'listing_status', 'status')

    // Build a richer notes blob if property detail columns are present
    const propType  = get(row, 'property_type', 'type')
    const beds      = get(row, 'bedrooms', 'beds', 'bed')
    const baths     = get(row, 'bathrooms', 'baths', 'bath')
    const sqft      = get(row, 'square_footage', 'sqft', 'sq_ft')
    const yearBuilt = get(row, 'year_built')
    const callAtts  = get(row, 'call_attempts', 'calls')

    const extraParts: string[] = []
    if (propType)  extraParts.push(`Type: ${propType}`)
    if (beds)      extraParts.push(`Beds: ${beds}`)
    if (baths)     extraParts.push(`Baths: ${baths}`)
    if (sqft)      extraParts.push(`Sqft: ${sqft}`)
    if (yearBuilt) extraParts.push(`Built: ${yearBuilt}`)
    if (callAtts)  extraParts.push(`Call attempts: ${callAtts}`)

    const fullNotes = [notes, extraParts.join(' | ')].filter(Boolean).join('\n').trim() || null

    // Parse last contacted date
    const lastCalledRaw = get(row, 'last_contacted_date', 'last_called', 'last_contact_date')
    const lastCalled    = lastCalledRaw ? new Date(lastCalledRaw) : null
    const lastCalledVal = lastCalled && !isNaN(lastCalled.getTime()) ? lastCalled : null

    try {
      await prisma.mojoContact.upsert({
        where:  { mojoId },
        update: {
          fullName,
          phone:    phone    || null,
          email:    email    || null,
          address:  address  || null,
          city:     city     || null,
          state:    state    || null,
          zipCode:  zipCode  || null,
          status:   status   || null,
          notes:    fullNotes,
          mojoList: mojoList || null,
          mojoGroup: 'NYC Leads',
          lastCalled: lastCalledVal,
          syncedAt:  new Date(),
        },
        create: {
          organizationId,
          mojoId,
          fullName,
          phone:    phone    || null,
          email:    email    || null,
          address:  address  || null,
          city:     city     || null,
          state:    state    || null,
          zipCode:  zipCode  || null,
          status:   status   || null,
          notes:    fullNotes,
          mojoList: mojoList || null,
          mojoGroup: 'NYC Leads',
          lastCalled: lastCalledVal,
          tags: [],
        },
      })
      upserted++
    } catch (e) {
      console.error(`[MojoImport] Failed row ${i} "${fullName}":`, (e as Error).message)
      skipped++
    }
  }

  return NextResponse.json({ ok: true, upserted, skipped })
}

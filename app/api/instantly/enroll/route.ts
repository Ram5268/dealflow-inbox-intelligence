export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isSuppressed } from '@/lib/suppression'

const INSTANTLY_API = 'https://api.instantly.ai/api/v2'
const BATCH_SIZE = 500

interface InstantlyLead {
  email: string
  first_name?: string
  last_name?: string
  phone?: string
  custom_variables?: Record<string, string>
}

function instantlyHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.INSTANTLY_API_KEY}`,
  }
}

async function addLeadsToInstantly(campaignId: string, leads: InstantlyLead[]) {
  const res = await fetch(`${INSTANTLY_API}/leads/add`, {
    method: 'POST',
    headers: instantlyHeaders(),
    body: JSON.stringify({ campaign_id: campaignId, leads }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Instantly API error ${res.status}: ${text}`)
  }
  return res.json()
}

// POST /api/instantly/enroll
// Body: { campaignId: string, mojoList: string }
// Bulk-enrolls eligible contacts from a Mojo calling list into an Instantly campaign.
// Contacts in NYC lead groups are marked suppressed and skipped.
export async function POST(req: NextRequest) {
  let body: { campaignId?: string; mojoList?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { campaignId, mojoList } = body
  if (!campaignId || !mojoList) {
    return NextResponse.json({ error: 'campaignId and mojoList required' }, { status: 400 })
  }

  if (!process.env.INSTANTLY_API_KEY) {
    return NextResponse.json({ error: 'INSTANTLY_API_KEY not configured' }, { status: 500 })
  }

  // Fetch all unprocessed contacts from the list that have an email
  const contacts = await prisma.mojoContact.findMany({
    where: {
      mojoList,
      email: { not: null },
      instantlyStatus: null,
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      address: true,
      city: true,
      groups: true,
      status: true,
    },
  })

  const suppressedIds: string[] = []
  const eligible: typeof contacts = []

  for (const c of contacts) {
    if (isSuppressed(c.groups, c.status)) {
      suppressedIds.push(c.id)
    } else {
      eligible.push(c)
    }
  }

  // Mark suppressed contacts — they will never be enrolled
  if (suppressedIds.length > 0) {
    await prisma.mojoContact.updateMany({
      where: { id: { in: suppressedIds } },
      data: { instantlyStatus: 'suppressed' },
    })
  }

  // Enroll eligible contacts in batches
  let enrolled = 0
  let failed = 0
  const enrolledIds: string[] = []

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE)
    const leads: InstantlyLead[] = batch.map(c => {
      const parts = c.fullName.trim().split(/\s+/)
      const firstName = parts[0] ?? ''
      const lastName  = parts.slice(1).join(' ') ?? ''
      return {
        email: c.email!,
        first_name: firstName || undefined,
        last_name:  lastName  || undefined,
        phone:      c.phone   || undefined,
        custom_variables: {
          ...(c.address ? { address: c.address } : {}),
          ...(c.city    ? { city:    c.city }    : {}),
        },
      }
    })

    try {
      await addLeadsToInstantly(campaignId, leads)
      enrolledIds.push(...batch.map(c => c.id))
      enrolled += batch.length
    } catch (e) {
      console.error(`[Instantly Enroll] Batch ${i / BATCH_SIZE + 1} failed:`, (e as Error).message)
      failed += batch.length
    }
  }

  // Mark enrolled contacts
  if (enrolledIds.length > 0) {
    await prisma.mojoContact.updateMany({
      where: { id: { in: enrolledIds } },
      data: { instantlyStatus: 'enrolled', instantlyCampaignId: campaignId },
    })
  }

  return NextResponse.json({
    ok: true,
    mojoList,
    campaignId,
    enrolled,
    suppressed: suppressedIds.length,
    failed,
    skippedNoEmail: contacts.length === 0 ? 'no unprocessed contacts found' : undefined,
  })
}

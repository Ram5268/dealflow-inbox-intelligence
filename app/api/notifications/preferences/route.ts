export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'

// Brief 7.4 — read/update notification preferences (org-scoped singleton).
const DEFAULTS = { digestEnabled: true, realtimeEnabled: true, digestTime: '08:00' }

export async function GET() {
  const organizationId = await getCurrentOrgId()
  const prefs = await prisma.notificationPreferences.findUnique({ where: { organizationId } })
  return NextResponse.json(prefs ?? { organizationId, ...DEFAULTS })
}

export async function PUT(req: NextRequest) {
  const organizationId = await getCurrentOrgId()
  let body: Partial<typeof DEFAULTS> = {}
  try { body = (await req.json()) as Partial<typeof DEFAULTS> } catch { /* empty */ }

  const data: typeof DEFAULTS = {
    digestEnabled:   typeof body.digestEnabled === 'boolean' ? body.digestEnabled : DEFAULTS.digestEnabled,
    realtimeEnabled: typeof body.realtimeEnabled === 'boolean' ? body.realtimeEnabled : DEFAULTS.realtimeEnabled,
    digestTime:      /^\d{2}:\d{2}$/.test(body.digestTime ?? '') ? body.digestTime! : DEFAULTS.digestTime,
  }

  const prefs = await prisma.notificationPreferences.upsert({
    where:  { organizationId },
    create: { organizationId, ...data },
    update: data,
  })
  return NextResponse.json(prefs)
}

export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'

// CRM lead-sync status for the Settings page (Brief 34). count = contacts
// sourced from the CRM; lastSync = when the last sync run finished (AuditLog).
export async function GET() {
  // Read endpoint — in test mode report the gated state honestly to the dashboard.
  if (isTestModeOnly()) return NextResponse.json({ enabled: false, testMode: true, contactsVisible: 0 })
  const organizationId = await getCurrentOrgId()
  const [count, lastRun] = await Promise.all([
    prisma.mojoContact.count({ where: { organizationId, metadata: { path: ['source'], equals: 'crm' } } }),
    prisma.auditLog.findFirst({
      where: { organizationId, action: 'CRM_LEAD_SYNC' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, detailsJson: true },
    }),
  ])
  return NextResponse.json({ count, lastSync: lastRun?.createdAt ?? null, lastRun: lastRun?.detailsJson ?? null })
}

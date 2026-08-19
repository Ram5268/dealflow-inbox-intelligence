export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getTemplate } from '@/lib/reports/templates'

// GET /api/reports/:id — full saved report (sections, markdown, sources, params).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const report = await prisma.report.findUnique({ where: { id } })
  if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 })

  const template = getTemplate(report.templateId)
  return NextResponse.json({
    id: report.id,
    templateId: report.templateId,
    templateName: template?.name ?? report.templateId,
    params: report.params,
    sections: report.sections,
    markdown: report.markdown,
    sources: report.sources,
    buyerId: report.buyerId,
    opportunityId: report.opportunityId,
    sessionId: report.sessionId,
    createdAt: report.createdAt,
  })
}

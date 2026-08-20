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

  // Brief 28.0 — derive the subject line the modal shows (the Report row has no
  // subject column). Matches the generator's "{buyer name} — {date}" format.
  let subject: string | null = null
  if (report.buyerId) {
    const buyer = await prisma.extractedOpportunity.findUnique({
      where: { id: report.buyerId }, select: { extractedTitle: true },
    })
    if (buyer?.extractedTitle) subject = `${buyer.extractedTitle} — ${report.createdAt.toISOString().slice(0, 10)}`
  }

  return NextResponse.json({
    id: report.id,
    templateId: report.templateId,
    templateName: template?.name ?? report.templateId,
    subject,
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

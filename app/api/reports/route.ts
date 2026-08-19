export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import Anthropic from '@anthropic-ai/sdk'
import { getTemplate } from '@/lib/reports/templates'
import { getGenerator } from '@/lib/reports/generators'

export const maxDuration = 60

// POST /api/reports — { templateId, params, sessionId } → generate + save a Report.
// Returns { id, sections, markdown, sources, createdAt }. Phase 1a: only unlocked
// templates (buyer-match) are generatable; a locked template returns 400.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const templateId: string = body.templateId
    const params: Record<string, unknown> = body.params ?? {}
    const sessionId: string | undefined = body.sessionId

    if (!templateId) return NextResponse.json({ error: 'templateId required' }, { status: 400 })
    if (!sessionId)   return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

    const template = getTemplate(templateId)
    if (!template) return NextResponse.json({ error: `Unknown template: ${templateId}` }, { status: 400 })
    if (!template.isUnlocked) {
      return NextResponse.json(
        { error: `Report "${templateId}" is not yet available — needs: ${template.dataRequirements.join(', ')}` },
        { status: 400 },
      )
    }
    const generator = getGenerator(templateId)
    if (!generator) return NextResponse.json({ error: `No generator for template: ${templateId}` }, { status: 400 })

    const session = await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { id: true } })
    if (!session) return NextResponse.json({ error: `Session ${sessionId} not found` }, { status: 404 })

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const generated = await generator.full({ ...params, prisma, anthropic })

    const buyerId = typeof params.buyerId === 'string' ? params.buyerId : null

    const report = await prisma.report.create({
      data: {
        templateId,
        params: params as object,
        sections: generated.sections as unknown as object,
        markdown: generated.markdown,
        sources: generated.sources as unknown as object,
        sessionId: session.id,
        buyerId,
      },
      select: { id: true, createdAt: true },
    })

    return NextResponse.json({
      id: report.id,
      templateId,
      templateName: template.name,
      subject: generated.subject,
      matchCount: generated.matchCount,
      sectionCount: generated.sections.length,
      sections: generated.sections,
      markdown: generated.markdown,
      sources: generated.sources,
      createdAt: report.createdAt,
    })
  } catch (err) {
    console.error('[reports] POST error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// GET /api/reports?sessionId=X — list a session's reports (for the library/history
// UI in Phase 1b). Returns lightweight rows; fetch a full report via /api/reports/:id.
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId query param required' }, { status: 400 })

  const reports = await prisma.report.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, templateId: true, buyerId: true, createdAt: true },
    take: 100,
  })
  return NextResponse.json({ reports })
}

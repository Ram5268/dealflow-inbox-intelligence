export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import Anthropic from '@anthropic-ai/sdk'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { getTemplate } from '@/lib/reports/templates'
import { getGenerator } from '@/lib/reports/generators'
import { encodeStoredReply } from '@/lib/chat/storedReply'
import { footerFromTurn, reportSummaryLines } from '@/lib/chat/shownFooter'

export const maxDuration = 60

// POST /api/reports — { templateId, params, sessionId, writeToChat? } → generate
// + save a Report. Phase 1a: only unlocked templates (buyer-match) are
// generatable; a locked template returns 400.
//
// Brief 28.0 — writeToChat: after saving the Report, also insert an assistant
// ChatMessage carrying attachedReport so the + button flow surfaces a preview
// card in the thread (same rehydration path as the natural-language flow). When
// writeToChat is set and no valid sessionId is provided (+ button on a fresh
// chat), a new ChatSession is created and its id returned.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const templateId: string = body.templateId
    const params: Record<string, unknown> = body.params ?? {}
    const sessionId: string | undefined = body.sessionId
    const writeToChat: boolean = body.writeToChat === true

    if (!templateId) return NextResponse.json({ error: 'templateId required' }, { status: 400 })

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

    // Resolve the session. writeToChat can create one on a fresh chat.
    let session = sessionId
      ? await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { id: true, organizationId: true } })
      : null
    if (!session) {
      if (writeToChat) {
        const organizationId = await getCurrentOrgId()
        session = await prisma.chatSession.create({ data: { organizationId }, select: { id: true, organizationId: true } })
      } else if (!sessionId) {
        return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
      } else {
        return NextResponse.json({ error: `Session ${sessionId} not found` }, { status: 404 })
      }
    }

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

    // Brief 28.0 — the preview-card message. attachedReport mirrors the shape the
    // chat route captures, so the client rehydrates it identically.
    const attachedReport = {
      reportId: report.id,
      templateId,
      templateName: template.name,
      subject: generated.subject,
      sectionCount: generated.sections.length,
      matchCount: generated.matchCount,
    }

    let messageId: string | undefined
    if (writeToChat) {
      const suggestions = ['Show the near-misses', 'Widen the criteria']
      const msg = await prisma.chatMessage.create({
        data: {
          organizationId: session.organizationId,
          sessionId: session.id,
          role: 'assistant',
          // Brief 43 PR 8 (Q14, N13): the one line the page shows, stored with the
          // report's buyer id, report id and a 3-line summary, so Drift's follow-ups
          // ("just the near-misses for that buyer") keep the same buyer. Stored in
          // the content JSON (lib/chat/storedReply.ts): no migration.
          content: encodeStoredReply({
            response: `Here's the ${template.name} for ${generated.subject}.`,
            suggestions,
            shown: footerFromTurn({ buyerId, reportId: report.id, summary: reportSummaryLines(generated.sections) }),
          }),
          attachedReport: attachedReport as object,
          suggestions: suggestions as object,
        },
        select: { id: true },
      })
      messageId = msg.id
      // Sort sessions by last activity, matching the chat route.
      await prisma.chatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } })
    }

    return NextResponse.json({
      id: report.id,
      reportId: report.id,
      templateId,
      templateName: template.name,
      subject: generated.subject,
      matchCount: generated.matchCount,
      sectionCount: generated.sections.length,
      sections: generated.sections,
      markdown: generated.markdown,
      sources: generated.sources,
      createdAt: report.createdAt,
      sessionId: session.id,
      messageId,
      attachedReport,
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

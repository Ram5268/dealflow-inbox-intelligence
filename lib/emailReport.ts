import { prisma } from './prisma'
import { CATEGORY_LABELS } from './utils'
import { Category } from '@prisma/client'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

async function getToken(): Promise<string | null> {
  try {
    const record = await prisma.connectedMailbox.findUnique({
      where: { id: 'runtime-token' },
      select: { accessTokenEncrypted: true },
    })
    if (record?.accessTokenEncrypted) return record.accessTokenEncrypted
  } catch {}
  return process.env.MICROSOFT_GRAPH_ACCESS_TOKEN ?? null
}

function formatPrice(p: number | null) {
  if (!p) return ''
  if (p >= 1_000_000) return ` · $${(p / 1_000_000).toFixed(2)}M`
  if (p >= 1_000) return ` · $${(p / 1_000).toFixed(0)}K`
  return ` · $${p}`
}

export async function generateAndSendDailyReport() {
  const token = await getToken()
  const to = process.env.EMAIL_REPORT_TO ?? 'rymartin@elliman.com'

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [totalOpps, newOpps, byCat, recentOpps, totalEmails, newEmails] = await Promise.all([
    prisma.extractedOpportunity.count({ where: { isDuplicate: false } }),
    prisma.extractedOpportunity.count({ where: { isDuplicate: false, createdAt: { gte: yesterday } } }),
    prisma.extractedOpportunity.groupBy({
      by: ['category'],
      _count: { category: true },
      where: { isDuplicate: false },
    }),
    prisma.extractedOpportunity.findMany({
      where: { isDuplicate: false, createdAt: { gte: yesterday } },
      orderBy: { confidenceScore: 'desc' },
      take: 10,
    }),
    prisma.rawEmail.count(),
    prisma.rawEmail.count({ where: { createdAt: { gte: yesterday } } }),
  ])

  const catRows = byCat
    .sort((a, b) => b._count.category - a._count.category)
    .map(r => `<tr>
      <td style="padding:4px 12px 4px 0;font-size:13px">${CATEGORY_LABELS[r.category as Category] ?? r.category}</td>
      <td style="padding:4px 0;font-weight:600;font-size:13px">${r._count.category}</td>
    </tr>`).join('')

  const dealRows = recentOpps.length
    ? recentOpps.map(o => `<tr>
        <td style="padding:6px 12px 6px 0;font-size:13px">
          <strong>${o.extractedTitle}</strong><br>
          <span style="color:#666;font-size:12px">${o.neighborhood ?? ''}${o.borough ? `, ${o.borough}` : ''}${formatPrice(o.price)}</span>
        </td>
        <td style="padding:6px 0;font-size:12px;color:#555">${o.sourceBrokerage ?? o.sourceAgentName ?? ''}</td>
      </tr>`).join('')
    : `<tr><td colspan="2" style="color:#888;font-size:13px;padding:8px 0">No new opportunities in the last 24 hours.</td></tr>`

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
  <div style="border-bottom:2px solid #1a1a1a;padding-bottom:12px;margin-bottom:24px">
    <h1 style="margin:0;font-size:20px">DealFlow Inbox</h1>
    <p style="margin:4px 0 0;color:#666;font-size:13px">Daily Report · ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</p>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
    <tr>
      <td style="width:33%;background:#f5f5f5;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700">${newEmails}</div>
        <div style="font-size:12px;color:#666">New emails (24h)</div>
      </td>
      <td style="width:4%"></td>
      <td style="width:33%;background:#f5f5f5;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700">${newOpps}</div>
        <div style="font-size:12px;color:#666">New deals (24h)</div>
      </td>
      <td style="width:4%"></td>
      <td style="width:33%;background:#f5f5f5;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:28px;font-weight:700">${totalOpps}</div>
        <div style="font-size:12px;color:#666">Total in database</div>
      </td>
    </tr>
  </table>

  <h2 style="font-size:15px;margin:0 0 12px">New Opportunities (Last 24h)</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px">${dealRows}</table>

  <h2 style="font-size:15px;margin:0 0 12px">All-Time by Category</h2>
  <table style="border-collapse:collapse;margin-bottom:24px">${catRows}</table>

  <p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:12px;margin:0">
    DealFlow Inbox Intelligence · Read-only · ${totalEmails} emails synced total
  </p>
</body></html>`

  if (!token) {
    console.log('[DealFlow] No token available — skipping daily report email.')
    return
  }

  const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject: `DealFlow Daily Report · ${newOpps} new ${newOpps === 1 ? 'opportunity' : 'opportunities'}`,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    console.error('[DealFlow] Failed to send daily report:', err)
    return
  }

  console.log(`[DealFlow] Daily report sent to ${to}`)
}

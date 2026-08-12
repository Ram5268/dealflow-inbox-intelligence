import 'dotenv/config'
import { prisma } from '../lib/prisma'

// Per-email: dump full chunk-type cross-section + samples of pdf_text, linked_html,
// inline_image so we can compare against V1 stripHtml(body) + attachmentsText.

const TARGETS = [
  { id: 'cmpxayoo80008h68oh3zmer89', label: "Donald Kemper — Hell's Kitchen $650K" },
  { id: 'cmpxaz04b000mh68oi5ezabc7', label: 'Monarch Realty Listings' },
  { id: 'cmpxb04go001kh68ovsgmpjr3', label: 'BLDG LISTINGS' },
]

async function main() {
  for (const t of TARGETS) {
    console.log('═══════════════════════════════════════════════════════════════════')
    console.log(`${t.id} | ${t.label}`)
    console.log('═══════════════════════════════════════════════════════════════════')

    // V1 input: stripHtml(bodyContent) and attachmentsText
    const re = await prisma.rawEmail.findUnique({
      where: { id: t.id },
      select: { bodyContent: true, attachmentsText: true },
    })
    const v1Body = re?.bodyContent || ''
    const v1Att  = re?.attachmentsText || ''
    console.log(`V1 stripHtml(body) length: ${v1Body.length}`)
    console.log(`V1 attachmentsText length: ${v1Att.length}`)
    console.log(`V1 attachmentsText first 6000 chars (the actual prompt input window):`)
    console.log(v1Att.slice(0, 6000) || '(empty)')
    console.log('')

    const chunks = await prisma.documentChunk.findMany({
      where:   { parentEmailId: t.id },
      orderBy: [{ chunkType: 'asc' }, { pageNumber: 'asc' }],
      select: {
        chunkType: true, content: true, pageNumber: true,
        sectionHeading: true, hasTable: true, tokenCount: true,
      },
    })

    const byType: Record<string, typeof chunks> = {}
    for (const c of chunks) {
      ;(byType[c.chunkType] ||= []).push(c)
    }

    console.log('\nV2 chunks by type:')
    for (const [type, list] of Object.entries(byType)) {
      console.log(`  ${type}: ${list.length} chunks`)
    }

    for (const [type, list] of Object.entries(byType)) {
      console.log(`\n── ${type.toUpperCase()} (showing up to 3 of ${list.length}) ──`)
      for (const c of list.slice(0, 3)) {
        console.log(`  ┌── page=${c.pageNumber ?? '-'} section=${c.sectionHeading ?? '-'} hasTable=${c.hasTable} tokens=${c.tokenCount}`)
        console.log(`  └── content (first 700):`)
        console.log((c.content || '').slice(0, 700).split('\n').map(l => `      ${l}`).join('\n'))
        console.log('')
      }
    }
    console.log('')
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })

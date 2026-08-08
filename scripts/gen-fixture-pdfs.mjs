// Brief 6.0 — Generate the small live-attachment PDF subset from fixture data.
//
// Scans test/fixtures/emails/**/*.json for PDF attachments tagged {live:true,file}
// and writes a minimal, real (text-extractable) PDF at test/fixtures/attachments/
// whose content IS the fixture's parsedText. This keeps the binary and its expected
// text in sync, and gives `--attachments-live` a real LlamaParse target without
// adding a PDF dependency. Re-run after adding/editing a live fixture.
//
//   node scripts/gen-fixture-pdfs.mjs
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'fs'
import { join } from 'path'

const ROOT = join(process.cwd(), 'test', 'fixtures', 'emails')
const OUT = join(process.cwd(), 'test', 'fixtures', 'attachments')
mkdirSync(OUT, { recursive: true })

// Fold non-latin1 punctuation to ASCII so latin1 byte offsets stay exact and
// Helvetica (WinAnsi) can render every glyph.
function asciiFold(s) {
  return s
    .replace(/[—–]/g, '-').replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"').replace(/…/g, '...')
    .replace(/·/g, '-').replace(/•/g, '-')
    .replace(/[^\x00-\xFF]/g, '?')
}

function makePdf(text) {
  const escPdf = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const lines = []
  for (const raw of asciiFold(text).split('\n')) {
    const line = raw.replace(/\t/g, '    ')
    if (line.length <= 95) { lines.push(line); continue }
    let s = line
    while (s.length > 95) {
      let cut = s.lastIndexOf(' ', 95); if (cut < 40) cut = 95
      lines.push(s.slice(0, cut)); s = s.slice(cut).trimStart()
    }
    lines.push(s)
  }
  let content = 'BT\n/F1 10 Tf\n50 760 Td\n12 TL\n'
  for (const l of lines) content += `(${escPdf(l)}) Tj T*\n`
  content += 'ET'

  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n'
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

let count = 0
for (const dir of readdirSync(ROOT).filter(d => statSync(join(ROOT, d)).isDirectory())) {
  for (const f of readdirSync(join(ROOT, dir)).filter(x => x.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(join(ROOT, dir, f), 'utf8'))
    for (const att of fx.input?.attachments ?? []) {
      if (att.live === true && att.file && (att.mimeType || '').toLowerCase() === 'application/pdf') {
        if (!att.parsedText) { console.warn(`  ! ${att.file}: no parsedText, skipping`); continue }
        const bytes = makePdf(att.parsedText)
        writeFileSync(join(OUT, att.file), bytes)
        console.log(`  ✓ ${att.file} (${bytes.length} bytes) <- ${dir}/${f}`)
        count++
      }
    }
  }
}
console.log(`\nGenerated ${count} live-attachment PDF(s) into test/fixtures/attachments/`)

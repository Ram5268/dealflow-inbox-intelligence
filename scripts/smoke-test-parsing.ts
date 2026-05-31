import 'dotenv/config'
import { readFileSync, existsSync } from 'fs'
import { extractLinks } from '../lib/parsing/linkExtractor'

async function testLinkExtractor() {
  console.log('1. Link extractor (no API calls)…')
  const sample = `Hey, check out the OM: https://www.dropbox.com/s/abc123/om.pdf?dl=0
Listing here: https://streeteasy.com/sale/12345
Floor plan: https://example.com/floor.jpg
Also: https://docs.google.com/document/d/foo/edit`
  const links = extractLinks(sample)
  console.log(`   Found ${links.length} links:`)
  links.forEach(l => console.log(`     ${l.type.padEnd(10)} ${l.url}`))
  if (links.length !== 4) throw new Error(`Expected 4 links, got ${links.length}`)
  console.log('   ✅ Link extractor works')
}

async function testFirecrawl() {
  console.log('\n2. Firecrawl scrape (https://example.com)…')
  const { scrapeUrl } = await import('../lib/parsing/firecrawl')
  const result = await scrapeUrl('https://example.com')
  console.log(`   Title:     ${result.title}`)
  console.log(`   Markdown:  ${result.markdown.length} chars`)
  console.log(`   File URLs: ${result.detectedFileUrls.length}`)
  if (result.markdown.length < 50) throw new Error(`Firecrawl returned suspiciously little content (${result.markdown.length} chars)`)
  console.log('   ✅ Firecrawl works')
}

async function testImageCaption() {
  console.log('\n3. Claude vision caption (1x1 transparent PNG)…')
  // 1x1 transparent PNG — proves the API call/auth/return path. Caption
  // will say "NONE — not real estate" or similar, which is the success case.
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const { captionImage } = await import('../lib/parsing/imageCaption')
  const caption = await captionImage(pngBase64, 'image/png')
  console.log(`   Caption: ${caption.slice(0, 200)}${caption.length > 200 ? '…' : ''}`)
  if (!caption) throw new Error('Caption was empty')
  console.log('   ✅ Claude vision works')
}

async function testLlamaParse() {
  console.log('\n4. LlamaParse PDF parse…')
  const candidates = ['public/test.pdf', 'test/fixtures/sample.pdf', 'test.pdf']
  const pdfPath = candidates.find(existsSync)
  if (!pdfPath) {
    console.log('   ⚠️  Skipped — no test PDF found in public/, test/fixtures/, or repo root.')
    console.log('       To run this leg later: drop any small PDF at public/test.pdf and re-execute this script.')
    console.log('       (Add public/test.pdf to .gitignore so it does not get committed.)')
    return
  }
  const buffer = readFileSync(pdfPath)
  console.log(`   Using: ${pdfPath} (${buffer.length} bytes)`)
  const { parsePdf } = await import('../lib/parsing/llamaParse')
  const result = await parsePdf(buffer, 'test.pdf')
  console.log(`   Job:        ${result.jobId}`)
  console.log(`   Pages:      ${result.totalPages}`)
  console.log(`   Page-1 md:  ${(result.pages[0]?.markdown ?? '').slice(0, 120)}${(result.pages[0]?.markdown.length ?? 0) > 120 ? '…' : ''}`)
  console.log(`   Page-1 tables/images: ${result.pages[0]?.tableCount ?? 0} / ${result.pages[0]?.imageCount ?? 0}`)
  if (result.pages.length === 0) throw new Error('LlamaParse returned no pages')
  console.log('   ✅ LlamaParse works')
}

async function main() {
  console.log('Smoke test: parsing layer\n')
  await testLinkExtractor()
  await testFirecrawl()
  await testImageCaption()
  await testLlamaParse()
  console.log('\n✅ All parsing modules verified (or LlamaParse skipped pending test PDF).')
}

main().then(() => process.exit(0)).catch(e => {
  console.error('\n❌ Smoke test failed:', (e as Error).message)
  process.exit(1)
})

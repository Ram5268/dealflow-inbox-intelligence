import {
  chunkEmailBody,
  chunkLinkedHtml,
  chunkPdfPage,
  chunkPdfTable,
  chunkImage,
  estimateTokens,
  type Chunk,
} from '../lib/ingestion/chunker'

function logChunks(chunks: Chunk[]) {
  console.log(`   ${chunks.length} chunks:`)
  chunks.forEach((c, i) => {
    const preview = c.content.slice(0, 80).replace(/\n/g, ' ')
    const tag = [c.pageNumber && `p${c.pageNumber}`, c.sectionHeading && `§${c.sectionHeading}`].filter(Boolean).join(' ')
    console.log(`     ${i + 1}. [${c.chunkType}] (${c.tokenCount}t)${tag ? ' ' + tag : ''}  ${preview}${c.content.length > 80 ? '…' : ''}`)
  })
}

function testShortEmail() {
  console.log('\n1. Short email body (single chunk expected)…')
  const body = 'Hey Ryan,\n\nGreat news — the buyer just made a $3.2M offer on the UWS condo. Let me know if you want to counter.\n\nThanks,\nMark'
  const chunks = chunkEmailBody(body)
  logChunks(chunks)
  if (chunks.length !== 1)                 throw new Error(`Expected 1 chunk, got ${chunks.length}`)
  if (chunks[0].chunkType !== 'email_body') throw new Error('Wrong chunk type')
  console.log('   ✅ Short email body works')
}

function testLongEmail() {
  console.log('\n2. Long email body (multi-chunk expected)…')
  const para = 'This is a sample paragraph about a 2-bedroom condo on the Upper West Side. The unit has southern exposure, doorman service, and is priced at $3.2M. Schools nearby include PS199 and PS87.'
  const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: ${para}`).join('\n\n')
  const chunks = chunkEmailBody(body)
  logChunks(chunks)
  if (chunks.length < 2) throw new Error(`Expected multiple chunks, got ${chunks.length}`)
  chunks.forEach((c, i) => {
    if (c.tokenCount > 800) throw new Error(`Chunk ${i + 1} exceeds 800 tokens: ${c.tokenCount}`)
  })
  console.log(`   ✅ Long email body works (${chunks.length} chunks, all under 800t)`)
}

function testPdfPage() {
  console.log('\n3. PDF page chunker (page metadata propagation)…')
  const page = {
    pageNumber: 4,
    markdown:   '# Property Overview\n\nThis is a 6-unit multifamily property in Brooklyn. Address: 247 W 38th St.\n\nThe building was renovated in 2018 with full electrical and plumbing upgrades.',
    tableCount: 2,
    imageCount: 1,
  }
  const chunks = chunkPdfPage(page)
  logChunks(chunks)
  if (chunks.length === 0)         throw new Error('No chunks produced')
  if (chunks[0].pageNumber !== 4)  throw new Error(`Page number wrong: ${chunks[0].pageNumber}`)
  if (!chunks[0].hasTable)         throw new Error('hasTable not propagated')
  if (!chunks[0].hasImage)         throw new Error('hasImage not propagated')
  console.log('   ✅ PDF page chunker works')
}

function testTable() {
  console.log('\n4. Table chunker (whole table = 1 chunk)…')
  const tableMd = '| Unit | Beds | Rent |\n|------|------|------|\n| 1A | 2 | $4500 |\n| 1B | 1 | $3200 |'
  const chunk = chunkPdfTable(tableMd, 12, 'Rent Roll')
  logChunks([chunk])
  if (chunk.chunkType !== 'pdf_table')   throw new Error('Wrong chunk type')
  if (chunk.pageNumber !== 12)           throw new Error('Page number missing')
  if (chunk.sectionHeading !== 'Rent Roll') throw new Error('Section heading missing')
  if (!chunk.hasTable)                   throw new Error('hasTable flag missing')
  console.log('   ✅ Table chunker works')
}

function testImage() {
  console.log('\n5. Image chunker (caption + base64 carry-through)…')
  const chunk = chunkImage({
    chunkType:     'pdf_image',
    caption:       'Floor plan showing a 2-bedroom apartment with kitchen, living room, and two bathrooms. Approximately 1100 square feet.',
    imageBase64:   'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAA',
    imageMimeType: 'image/png',
    pageNumber:    8,
  })
  console.log(`   1 chunk: [${chunk.chunkType}] (${chunk.tokenCount}t) hasImage=${chunk.hasImage}, imgBytes=${chunk.imageBase64?.slice(0, 12)}…`)
  if (chunk.chunkType !== 'pdf_image') throw new Error('Wrong chunk type')
  if (!chunk.hasImage)                 throw new Error('hasImage flag missing')
  if (!chunk.imageBase64)              throw new Error('imageBase64 missing')
  console.log('   ✅ Image chunker works')
}

function testLinkedHtml() {
  console.log('\n6. Linked-HTML chunker (section-aware)…')
  const scraped = {
    url:              'https://example.com/listing/123',
    title:            'Beautiful UWS 2BR',
    description:      null,
    detectedFileUrls: [],
    markdown:         '# Property Details\n\n2 bedrooms, 2 bathrooms. Built in 1924.\n\n# Pricing\n\nListed at $3.2M.\n\n# Location\n\nUpper West Side, near Central Park.',
  }
  const chunks = chunkLinkedHtml(scraped)
  logChunks(chunks)
  if (chunks.length === 0) throw new Error('No chunks produced')
  const headings = new Set(chunks.map(c => c.sectionHeading).filter(Boolean))
  if (headings.size < 2) throw new Error(`Expected multiple section headings, got: ${[...headings].join(', ')}`)
  console.log(`   ✅ Linked-HTML chunker works (${headings.size} distinct sections)`)
}

function testTokenEstimate() {
  console.log('\n7. Token estimator (sanity)…')
  const cases = [
    { text: 'Hello world',    approxExpected: 3 },
    { text: 'a'.repeat(100),  approxExpected: 25 },
    { text: '',               approxExpected: 0 },
  ]
  for (const { text, approxExpected } of cases) {
    const got = estimateTokens(text)
    if (Math.abs(got - approxExpected) > 3) {
      throw new Error(`estimateTokens("${text.slice(0,20)}…", ${text.length}c) expected ≈${approxExpected}, got ${got}`)
    }
  }
  console.log('   ✅ Token estimator works')
}

console.log('Smoke test: chunker layer')
try {
  testShortEmail()
  testLongEmail()
  testPdfPage()
  testTable()
  testImage()
  testLinkedHtml()
  testTokenEstimate()
  console.log('\n✅ All chunker primitives verified.')
} catch (e) {
  console.error('\n❌ Smoke test failed:', (e as Error).message)
  process.exit(1)
}

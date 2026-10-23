// Brief 43 PR 16 (Q30, Q42; N9, E-03): what an attached file becomes in the
// message Claude reads. A PDF goes as a Claude `document` block (it used to get a
// "not yet supported" note), and a file cut at 15,000 characters says so (it
// used to be cut silently). Pure: no network, no database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildUserBlocks, FILE_CUT_NOTE, FILE_TEXT_LIMIT, PDF_LIMIT_BASE64_CHARS, type FileData } from '../fileBlocks'

const ROOT = join(__dirname, '..', '..', '..')
const pdfBase64 = (body = 'fictional listing sheet, 88 Example Ave') => Buffer.from(`%PDF-1.4\n${body}\n%%EOF`).toString('base64')
const noBinary = async () => { throw new Error('test: parseBinary should not run for this file') }
const textOf = (blocks: Awaited<ReturnType<typeof buildUserBlocks>>) =>
  blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')

test('a PDF goes to Claude as a document block, ahead of the text', async () => {
  const data = pdfBase64()
  const files: FileData[] = [{ name: 'listing.pdf', mimeType: 'application/pdf', type: 'binary', content: data }]
  const blocks = await buildUserBlocks('What does this say?', files, noBinary)
  assert.equal(blocks[0].type, 'document')
  assert.deepEqual(blocks[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: 'listing.pdf' })
  assert.equal(blocks[1].type, 'text')
  assert.match(textOf(blocks), /^What does this say\?/)
  assert.doesNotMatch(textOf(blocks), /not yet supported/)
})

test('a file named .pdf that is not a PDF is not sent as a document', async () => {
  const files: FileData[] = [{ name: 'fake.pdf', mimeType: 'application/pdf', type: 'binary', content: Buffer.from('plain words').toString('base64') }]
  const blocks = await buildUserBlocks('', files, async (_b, name) => `(File "${name}" could not be read)`)
  assert.ok(blocks.every(b => b.type !== 'document'))
  assert.match(textOf(blocks), /could not be read/)
})

test('PDFs past the size bound are not sent; the text says so', async () => {
  const big = 'A'.repeat(PDF_LIMIT_BASE64_CHARS) // starts like no PDF; give it the header
  const files: FileData[] = [
    { name: 'one.pdf', mimeType: 'application/pdf', type: 'binary', content: pdfBase64() },
    { name: 'huge.pdf', mimeType: 'application/pdf', type: 'binary', content: 'JVBERi0' + big },
  ]
  const blocks = await buildUserBlocks('read these', files, noBinary)
  assert.equal(blocks.filter(b => b.type === 'document').length, 1)
  assert.match(textOf(blocks), /--- File: huge\.pdf ---\n\(This PDF is too big to read here\.\)/)
})

test('a text file longer than 15,000 characters is cut, and the cut is marked', async () => {
  assert.equal(FILE_TEXT_LIMIT, 15_000)
  assert.equal(FILE_CUT_NOTE, '(file cut at 15,000 characters)')
  const long = 'x'.repeat(20_000)
  const blocks = await buildUserBlocks('summarize', [{ name: 'notes.txt', mimeType: 'text/plain', type: 'text', content: long }], noBinary)
  const text = textOf(blocks)
  assert.ok(text.includes(`--- File: notes.txt ---\n${'x'.repeat(15_000)}\n${FILE_CUT_NOTE}\n---`))
  assert.ok(!text.includes('x'.repeat(15_001)))
})

test('a short text file is sent whole, with no cut note', async () => {
  const blocks = await buildUserBlocks('summarize', [{ name: 'notes.txt', mimeType: 'text/plain', type: 'text', content: 'two lines\nof notes' }], noBinary)
  assert.equal(textOf(blocks), 'summarize\n\n--- File: notes.txt ---\ntwo lines\nof notes\n---')
})

test('text pulled from a Word or Excel file is cut and marked the same way', async () => {
  const blocks = await buildUserBlocks('', [{ name: 'rent roll.xlsx', mimeType: 'application/vnd.ms-excel', type: 'binary', content: 'AAAA' }], async () => 'y'.repeat(15_001))
  assert.match(textOf(blocks), /^\(Please analyze the attached file\.\)\n\n--- File: rent roll\.xlsx ---\ny{15000}\n\(file cut at 15,000 characters\)\n---$/)
})

test('a photo still goes as an image block after the text', async () => {
  const blocks = await buildUserBlocks('what is this', [{ name: 'p.jpg', mimeType: 'image/jpeg', type: 'image', content: 'QUJD' }], noBinary)
  assert.deepEqual(blocks.map(b => b.type), ['text', 'image'])
})

test('the chat route builds its user turn with buildUserBlocks', () => {
  const route = readFileSync(join(ROOT, 'app/api/chat/route.ts'), 'utf8')
  assert.match(route, /const userBlocks = await buildUserBlocks\(userMessage, files, parseBinary\)/)
  assert.doesNotMatch(route, /\.slice\(0, 15000\)/)
})

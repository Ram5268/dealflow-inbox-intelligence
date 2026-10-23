// Brief 43 PR 16 (Q42; E-06): the chat page checks an attachment's size before
// it sends anything. Vercel refuses a request over 4.5 MB with its own 413 page;
// a file that would hit it is held back with a plain note. Pure: no browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_UPLOAD_LIMIT_BYTES, FILE_TOO_BIG_NOTE, TEXT_READ_BYTES, TEXT_SEND_CHARS, fileKind, filesTooBig, textToSend, uploadBytes } from '../fileSize'
import { FILE_TEXT_LIMIT } from '../fileBlocks'
import { TOO_BIG_PAGE_REPLY } from '../chatErrorReply'

const ROOT = join(__dirname, '..', '..', '..')
const MB = 1_000_000
const pdf = (size: number) => ({ name: 'listing.pdf', type: 'application/pdf', size })

test('the note is the plain one, and it matches the 413 reply', () => {
  assert.equal(FILE_TOO_BIG_NOTE, 'That file is too big (limit about 4 MB).')
  assert.ok(TOO_BIG_PAGE_REPLY.startsWith('That file is too big'))
  assert.ok(CHAT_UPLOAD_LIMIT_BYTES < 4.5 * MB)
})

test('a large PDF is too big; a small one is not', () => {
  assert.equal(filesTooBig([pdf(6 * MB)]), true)
  assert.equal(filesTooBig([pdf(2 * MB)]), false)
})

test('a PDF is sent as base64, so 3.5 MB on disk is already over the cap', () => {
  assert.equal(uploadBytes(pdf(3 * MB)), 4 * MB)
  assert.equal(filesTooBig([pdf(3.5 * MB)]), true)
})

test('files are added up', () => {
  assert.equal(filesTooBig([pdf(2 * MB), pdf(2 * MB)]), true)
})

test('a big photo is fine: the page shrinks it before sending', () => {
  assert.equal(fileKind({ name: 'IMG_0001.jpg', type: 'image/jpeg' }), 'image')
  assert.equal(filesTooBig([{ name: 'IMG_0001.jpg', type: 'image/jpeg', size: 12 * MB }]), false)
})

test('a text file is never too big: only its start is sent (review r1)', () => {
  assert.equal(fileKind({ name: 'rent-roll.csv', type: '' }), 'text')
  assert.equal(uploadBytes({ name: 'rent-roll.csv', type: '', size: 1234 }), 1234)
  assert.equal(filesTooBig([{ name: 'big.csv', type: 'text/csv', size: 50 * MB }]), false)
  assert.equal(uploadBytes({ name: 'big.csv', type: 'text/csv', size: 50 * MB }), TEXT_SEND_CHARS * 6)
  // one character past what Drift reads, so the route still marks the cut
  assert.equal(TEXT_SEND_CHARS, FILE_TEXT_LIMIT + 1)
  assert.equal(textToSend('z'.repeat(40_000)).length, 15_001)
  assert.equal(textToSend('short'), 'short')
  assert.ok(TEXT_READ_BYTES >= TEXT_SEND_CHARS * 4) // a UTF-8 character is at most 4 bytes
})

test('the chat page checks the size when a file is picked, and uses the same split as processFile', () => {
  const page = readFileSync(join(ROOT, 'app/chat/page.tsx'), 'utf8')
  assert.match(page, /filesTooBig\(\[\.\.\.files, \.\.\.picked\]\)/)
  assert.match(page, /setFileNote\(FILE_TOO_BIG_NOTE\)/)
  assert.match(page, /const kind = fileKind\(file\)/)
  assert.match(page, /content: textToSend\(e\.target\?\.result as string\)/)
  assert.match(page, /reader\.readAsText\(file\.slice\(0, TEXT_READ_BYTES\)\)/)
})

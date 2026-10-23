// Brief 43 PR 16 (Q42; E-06): the chat page checks an attachment's size before
// it sends anything. Vercel refuses a request over 4.5 MB with its own 413 page;
// a file that would hit it is held back with a plain note. Pure: no browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_UPLOAD_LIMIT_BYTES, FILE_TOO_BIG_NOTE, fileKind, filesTooBig, uploadBytes } from '../fileSize'
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

test('a text file counts as its own size', () => {
  assert.equal(fileKind({ name: 'rent-roll.csv', type: '' }), 'text')
  assert.equal(uploadBytes({ name: 'rent-roll.csv', type: '', size: 1234 }), 1234)
  assert.equal(filesTooBig([{ name: 'big.csv', type: 'text/csv', size: 5 * MB }]), true)
})

test('the chat page checks the size when a file is picked, and uses the same split as processFile', () => {
  const page = readFileSync(join(ROOT, 'app/chat/page.tsx'), 'utf8')
  assert.match(page, /filesTooBig\(\[\.\.\.files, \.\.\.picked\]\)/)
  assert.match(page, /setFileNote\(FILE_TOO_BIG_NOTE\)/)
  assert.match(page, /const kind = fileKind\(file\)/)
})

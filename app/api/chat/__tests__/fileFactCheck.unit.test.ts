// Brief 43 PR 16 (review r1): the fact-check sees what Drift read in an attached
// file, so a correct reply quoting it isn't swapped for a stock reply (after two
// rewrites that each send the PDF again), and a figure the file doesn't have is
// still caught. The real chat route, fake Prisma, fake AI; no database, no
// network. The file and its figures are fictional.
import { script, driftCalls, reset, postChat, ai } from './pr8ChatHarness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicTool, anthropicText, openAiChat, systemPromptOf, type AiRequest } from '../../../../lib/__tests__/fakeAiFetch'
import { fileEvidence, FILE_EVIDENCE_LIMIT } from '../../../../lib/chat/fileBlocks'

const MEMO = 'Offering memo, 88 Example Ave. Gross square feet 3,200. Annual taxes $12,400.'
// A one-page PDF whose text is MEMO.
function onePagePdf(text: string): string {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1').toString('base64')
}

// A stand-in for the fact-check that holds to its prompt: a size or tax figure
// is grounded only when it is in the evidence (everything before the reply).
const verifierCalls: AiRequest[] = []
const evidence = (req: AiRequest) => JSON.stringify(req.body).split('<assistant_response>')[0]
ai.reply(req => {
  if (req.url.includes('openai.com')) return systemPromptOf(req).includes('Generate a 4-7 word title') ? openAiChat('Test Chat') : openAiChat({})
  if (systemPromptOf(req).startsWith('You are a fact-checker')) {
    verifierCalls.push(req)
    const reply = JSON.stringify(req.body).split('<assistant_response>')[1] ?? ''
    const figure = (reply.match(/\d,\d{3}/) ?? [''])[0]
    return anthropicText(JSON.stringify(evidence(req).includes(figure)
      ? { isGrounded: true, flags: [] }
      : { isGrounded: false, flags: [{ claim: `${figure} gross square feet`, reason: 'square footage not in the evidence' }] }))
  }
  driftCalls.push(req)
  const next = script.shift()
  if (!next) throw new Error('test: no scripted Drift reply left')
  return next
})
const say = (response: string) => anthropicTool('drift_response', { response, suggestions: ['a', 'b'] })
const FILES = [
  ['PDF', { name: 'memo.pdf', mimeType: 'application/pdf', type: 'binary', content: onePagePdf(MEMO) }],
  ['text file', { name: 'memo.txt', mimeType: 'text/plain', type: 'text', content: MEMO }],
] as const

for (const [label, file] of FILES) {
  test(`a correct reply quoting a ${label} passes the fact-check the first time`, async () => {
    reset(); verifierCalls.length = 0
    const right = 'The memo lists 3,200 gross square feet and annual taxes of $12,400.'
    script.push(say(right), say(right), say(right))
    const { status, json } = await postChat({ message: 'what does the memo say about size and taxes?', files: [file] })
    assert.equal(status, 200)
    assert.equal(json.response, right)
    assert.equal(driftCalls.length, 1, 'no rewrites, so the PDF is sent once')
    assert.equal(verifierCalls.length, 1)
  })

  test(`a figure the ${label} doesn't have is still caught`, async () => {
    reset(); verifierCalls.length = 0
    const wrong = 'The memo lists 4,100 gross square feet.'
    script.push(say(wrong), say(wrong), say(wrong))
    const { json } = await postChat({ message: 'how big is it?', files: [file] })
    assert.notEqual(json.response, wrong)
    assert.ok(verifierCalls.length > 1, 'flagged and rewritten')
  })
}

// Brief 43 PR 16 (review r1): PR 15 skips the fact-check on a fact-free reply on
// a turn with no facts; an attached file counts as facts, so it still runs.
test('a fact-free reply on a file turn still gets the fact-check; without a file it is skipped', async () => {
  reset(); verifierCalls.length = 0
  script.push(say('Got it.'))
  await postChat({ message: 'here is the memo', files: [FILES[1][1]] })
  assert.equal(verifierCalls.length, 1)
  reset(); verifierCalls.length = 0
  script.push(say('Got it.'))
  await postChat({ message: 'thanks' })
  assert.equal(verifierCalls.length, 0)
})

test('fileEvidence: nothing without files; bounded; PDF text and file sections both in', async () => {
  assert.equal(await fileEvidence([{ type: 'text', text: 'just a question' }], async () => 'x'), null)
  const blocks = [
    { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: 'JVBER' }, title: 'a.pdf' },
    { type: 'text' as const, text: `q\n\n--- File: b.txt ---\n${'y'.repeat(30_000)}\n---` },
  ]
  const ev = (await fileEvidence(blocks, async () => 'pdf words'))!
  assert.match(ev, /--- File: a\.pdf ---\npdf words/)
  assert.match(ev, /--- File: b\.txt ---/)
  assert.ok(ev.length <= FILE_EVIDENCE_LIMIT + 80)
  assert.equal(await fileEvidence(blocks.slice(0, 1), async () => { throw new Error('unreadable') }), null)
})

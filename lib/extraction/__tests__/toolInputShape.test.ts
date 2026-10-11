// Brief 41.1 (Brief 41 found-not-fixed) — when the model's answer fails
// validation, the extractor logs its shape, never its text (which can carry a
// seller's personal circumstances or a name). Pure: sonnetExtractor.ts loads
// the Anthropic SDK, so it's checked by its source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toolInputShape } from '../toolInputShape'

const ROOT = join(__dirname, '..', '..', '..')

test("the log of a rejected model answer shows its shape, never its text", () => {
  const extractor = readFileSync(join(ROOT, 'lib/extraction/sonnetExtractor.ts'), 'utf8')
  assert.doesNotMatch(extractor, /JSON\.stringify\(toolUse\.input\)/)
  assert.match(extractor, /toolInput shape: \$\{toolInputShape\(toolUse\.input\)/)
})

test('the shape has keys, types and lengths only', () => {
  const answer = {
    leads: [{
      extractedSummary: 'Owner passed away; the heirs want to sell.', motivation: 'probate', clientName: 'Jane Q Owner',
      price: 1_840_000, beds: null, units: [], 'Owner died in May': true,
    }],
  }
  const shape = toolInputShape(answer)
  assert.equal(shape, '{leads: array(1)[{extractedSummary: string(42), motivation: string(7), clientName: string(12), price: number, beds: null, units: array(0), ?: boolean}]}')
  assert.doesNotMatch(shape, /passed|heirs|probate|Jane|1840000|died/i)
  assert.equal(toolInputShape('Owner died'), 'string(10)')
  assert.equal(toolInputShape(undefined), 'undefined')
  // Deep nesting stops at a few levels.
  assert.equal(toolInputShape({ a: { b: { c: { d: { e: 'x' } } } } }), '{a: {b: {c: {d: object}}}}')
})

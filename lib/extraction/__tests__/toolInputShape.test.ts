// Brief 41.1 (Brief 41 found-not-fixed) — when the model's answer fails
// validation, the extractor logs its shape, never its text (which can carry a
// seller's personal circumstances or a name). Only the tool schema's own keys
// are named; a key the model made up is its text too (PR G review). Pure:
// sonnetExtractor.ts loads the Anthropic SDK, so it's checked by its source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toolInputShape } from '../toolInputShape'
import { EXTRACTION_SPEC_BY_CATEGORY } from '../schemas'

const ROOT = join(__dirname, '..', '..', '..')

test('the log of a rejected model answer shows its shape, never its text', () => {
  const extractor = readFileSync(join(ROOT, 'lib/extraction/sonnetExtractor.ts'), 'utf8')
  assert.doesNotMatch(extractor, /JSON\.stringify\(toolUse\.input\)/)
  assert.match(extractor, /toolInput shape: \$\{toolInputShape\(toolUse\.input, opts\.inputSchema\)/)
})

test('the shape has the schema keys, types and lengths only; any other key shows as "?"', () => {
  const schema = EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!.inputSchema
  const answer = {
    leads: [{
      extractedSummary: 'Owner passed away; the heirs want to sell.', motivation: 'probate', price: 1_840_000, beds: null,
      clientName: 'Jane Q Owner', probate: 'yes', 'Owner died in May': true, units: 3,
    }],
    probateNotes: ['heirs'],
  }
  const shape = toolInputShape(answer, schema)
  assert.equal(shape, '{leads: array(1)[{extractedSummary: string(42), motivation: string(7), price: number, beds: null, ?: string(12), ?: string(3), ?: boolean, units: number}], ?: array(1)[string(5)]}')
  assert.doesNotMatch(shape, /passed|heirs|probate|Jane|clientName|1840000|died/i)
  // With no schema at all, no key is named.
  assert.equal(toolInputShape({ motivation: 'probate', n: 1 }), '{?: string(7), ?: number}')
  assert.equal(toolInputShape('Owner died'), 'string(10)')
  assert.equal(toolInputShape(undefined), 'undefined')
  // Deep nesting stops at a few levels.
  assert.equal(toolInputShape({ a: { b: { c: { d: { e: 'x' } } } } }), '{?: {?: {?: {?: object}}}}')
})

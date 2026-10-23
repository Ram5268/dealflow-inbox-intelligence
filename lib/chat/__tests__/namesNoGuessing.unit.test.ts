// Brief 43 PR 9 (Q15, Q41): Drift never guesses a buyer. Pure text tests on
// SYSTEM_PROMPT, RYAN_MD and the tool schemas (all sent on every chat turn).
// No network, no database, no AI calls.
//
// Rule sources: no example names that prime a guess, find a named buyer with
// search_parties and ask when nothing matches exactly, and no report without a
// buyer id from this turn's search are engineering precautions from Brief 46's
// findings Q15 and Q41 (TEST_PLAN B-06, R-07, T-07, B-08; DRIFT_SCRIPT #15).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SYSTEM_PROMPT } from '../systemPrompt'
import { RYAN_MD } from '../../prompts/ryanMd'
import { GENERATE_REPORT_TOOL, GENERATE_REPORT_SECTION_TOOL, SEARCH_PARTIES_TOOL } from '../tools/schemas'
import { searchPartiesInputSchema } from '../tools/searchParties'

const TOOLS = JSON.stringify([GENERATE_REPORT_TOOL, GENERATE_REPORT_SECTION_TOOL, SEARCH_PARTIES_TOOL])
const ALL = `${SYSTEM_PROMPT}\n\n${RYAN_MD}\n\n${TOOLS}`

test('no example client names that prime a guess (B-06)', () => {
  for (const s of ['Sarah', 'Sarahs', 'McCoy', 'Franklin']) assert.ok(!ALL.includes(s), `"${s}" should be gone`)
})

test('"resolve it yourself" is gone: Drift asks when nothing matches (R-07)', () => {
  assert.ok(!RYAN_MD.includes('resolve it yourself'))
  assert.ok(!RYAN_MD.includes('Do NOT ask Ryan for the id'))
  // "Only ask when you truly cannot tell" pushed Drift to pick a near match.
  assert.ok(!SYSTEM_PROMPT.includes('Only ask when you truly cannot tell'))
  for (const [name, text] of [['SYSTEM_PROMPT', SYSTEM_PROMPT], ['RYAN_MD', RYAN_MD]]) {
    assert.ok(text.includes('No buyer by that name on file.'), `${name}: the one-line answer`)
    assert.match(text, /ask which buyer Ryan means/, `${name}: then ask`)
    assert.match(text, /never pick the closest one or guess/i, `${name}: no near match`)
  }
})

test('a named buyer is found with search_parties, and a report needs an id from this turn', () => {
  for (const [name, text] of [['SYSTEM_PROMPT', SYSTEM_PROMPT], ['RYAN_MD', RYAN_MD]]) {
    assert.match(text, /search_parties FIRST/, name)
    assert.match(text, /buyer id that search_parties returned in this same turn/, name)
  }
  // A buyer from an earlier turn: the id in its Shown note (PR 8), else a new search.
  assert.match(SYSTEM_PROMPT, /search for them again this turn/)
  for (const tool of [GENERATE_REPORT_TOOL, GENERATE_REPORT_SECTION_TOOL]) {
    assert.match(tool.description ?? '', /search_parties returned in this turn/, tool.name)
  }
})

test('search_parties takes a name or description and a buyer type (Q15, Q41)', () => {
  const props = (SEARCH_PARTIES_TOOL.input_schema as { properties: Record<string, { enum?: string[]; description?: string }> }).properties
  assert.ok(props.query, 'query')
  assert.match(props.query.description ?? '', /agent/)
  assert.ok(props.archetype, 'archetype')
  assert.ok(props.archetype.enum?.includes('EXCHANGE_1031'))
  // The model-facing enum and the runtime (zod) enum are the same list.
  const zodArchetypes = (searchPartiesInputSchema.shape.archetype.unwrap() as unknown as { options: string[] }).options
  assert.deepEqual([...(props.archetype.enum ?? [])].sort(), [...zodArchetypes].sort())
  assert.equal(searchPartiesInputSchema.parse({ query: 'Jordan Sample', archetype: 'EXCHANGE_1031' }).query, 'Jordan Sample')
})

// Reviewer (Brief 43 PR 9 r1): an area in query must match the title's spelling
// ("Bedford-Stuyvesant" is not "Bed-Stuy"), so areas, beds and budgets go in
// their own fields, where search_parties already reads every spelling.
test('a name goes in query; an area, beds or budget go in their own fields', () => {
  const props = (SEARCH_PARTIES_TOOL.input_schema as { properties: Record<string, { description?: string }> }).properties
  assert.match(props.query.description ?? '', /never in query/)
  for (const [name, text] of [['SYSTEM_PROMPT', SYSTEM_PROMPT], ['RYAN_MD', RYAN_MD]]) {
    assert.match(text, /an area, beds or budget (go )?in their own fields[^.]*never in query/, name)
  }
})

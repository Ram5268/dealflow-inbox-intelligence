// Brief 43 PR 4 (M20, Q4): "coming soon" means coming-soon sales unless the
// message has rental words, so "any coming soon in bedstuy?" no longer sets off
// the live StreetEasy rentals search; and the gpt-4o-mini parse fallback can't
// hold up a turn. The model is a stand-in (lib/__tests__/fakeAiFetch.ts) and
// time is a fake clock; nothing leaves this process. [engineering precaution]
import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { installFakeAiFetch, openAiChat } from '../../__tests__/fakeAiFetch'
import { parseQuery } from '../queryParser'

const ai = installFakeAiFetch()
afterEach(() => mock.timers.reset())

const cats = async (q: string) => (await parseQuery(q)).categories

test('"any coming soon in bedstuy?" means coming-soon sales only', async () => {
  const p = await parseQuery('any coming soon in bedstuy?')
  assert.ok(p.categories.includes('COMING_SOON_SALE'))
  assert.ok(!p.categories.includes('COMING_SOON_RENTAL'))
  assert.deepEqual(p.neighborhoods, ['Bedford-Stuyvesant'])
})

test('"coming soon rentals in astoria" keeps coming-soon rentals', async () => {
  assert.ok((await cats('coming soon rentals in astoria')).includes('COMING_SOON_RENTAL'))
  assert.ok((await cats('anything coming soon for rent in bushwick?')).includes('COMING_SOON_RENTAL'))
  assert.ok((await cats('coming soon in park slope for my tenant')).includes('COMING_SOON_RENTAL'))
})

test('other coming-soon asks stay on sales', async () => {
  for (const q of ['anything coming soon in tribeca?', 'coming soon in bed-stuy', 'anything coming soon in clinton hill, currently?']) {
    const c = await cats(q)
    assert.ok(c.includes('COMING_SOON_SALE'), q)
    assert.ok(!c.includes('COMING_SOON_RENTAL'), `${q}: "currently" is not a rental word`)
  }
})

test('"coming-soon" and "comingsoon" count as coming soon too', async () => {
  for (const q of ['any coming-soon in bedstuy?', 'comingsoon 3 family in bed-stuy']) {
    const c = await cats(q)
    assert.ok(c.includes('COMING_SOON_SALE'), q)
    assert.ok(!c.includes('COMING_SOON_RENTAL'), q)
  }
  assert.ok((await cats('coming-soon rentals in astoria')).includes('COMING_SOON_RENTAL'))
})

test('the model fallback cannot add coming-soon rentals without rental words', async () => {
  ai.reply(() => openAiChat({ neighborhoods: ['Park Slope'], categories: ['COMING_SOON_SALE', 'COMING_SOON_RENTAL'] }))
  const before = ai.requests.length
  const p = await parseQuery('anything coming soon around the big park?')
  assert.equal(ai.requests.length, before + 1, 'this one goes to the model')
  assert.ok(p.categories.includes('COMING_SOON_SALE'))
  assert.ok(!p.categories.includes('COMING_SOON_RENTAL'))
})

test('a model parse that never answers gives up after 6 s and keeps the plain parse', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch
  try {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-19T15:00:00Z') })
    let out: Awaited<ReturnType<typeof parseQuery>> | null = null
    parseQuery('anything coming soon around the big park?').then(p => { out = p })
    for (let t = 0; t < 10_000 && !out; t += 500) {
      mock.timers.tick(500)
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    }
    assert.ok(out, 'parseQuery returned')
    assert.ok(Date.now() - Date.parse('2026-10-19T15:00:00Z') <= 6_500)
    assert.ok((out as unknown as { categories: string[] }).categories.includes('COMING_SOON_SALE'))
  } finally {
    globalThis.fetch = realFetch
  }
})

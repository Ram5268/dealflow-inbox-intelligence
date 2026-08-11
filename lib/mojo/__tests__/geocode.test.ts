import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geocodeAddress, type SonnetClient } from '../geocode'

// Run: `npm test` (ts-node via node:test). No real network / API calls — global
// fetch is stubbed for Nominatim and a fake client is injected for the Sonnet
// fallback, so this suite is free and deterministic.

// Keep the in-process Nominatim throttle short so the suite runs fast.
process.env.NOMINATIM_MIN_INTERVAL_MS = '20'

const realFetch = globalThis.fetch

function stubFetch(payload: unknown, ok = true) {
  globalThis.fetch = (async () => ({
    ok,
    json: async () => payload,
  })) as unknown as typeof fetch
}

function fakeSonnet(text: string): SonnetClient {
  return { messages: { create: async () => ({ content: [{ type: 'text', text }] }) } }
}

// ── Nominatim happy path ─────────────────────────────────────────────────────
test('Nominatim returns neighborhood + coords', async () => {
  stubFetch([
    { lat: '40.7439', lon: '-74.0060', address: { neighbourhood: 'Chelsea', city_district: 'Manhattan' } },
  ])
  const r = await geocodeAddress('150 W 22nd St, New York, NY')
  assert.equal(r.source, 'nominatim')
  assert.equal(r.neighborhood, 'Chelsea')
  assert.equal(r.borough, 'Manhattan')
  assert.equal(r.lat, 40.7439)
  assert.equal(r.lng, -74.006)
  globalThis.fetch = realFetch
})

test('Nominatim strips " District" suffix', async () => {
  stubFetch([{ lat: '40.7', lon: '-74.0', address: { neighbourhood: 'Chelsea District' } }])
  const r = await geocodeAddress('somewhere')
  assert.equal(r.neighborhood, 'Chelsea')
  globalThis.fetch = realFetch
})

test('Nominatim prefers neighbourhood > suburb > quarter', async () => {
  stubFetch([{ lat: '40.7', lon: '-74.0', address: { suburb: 'Williamsburg' } }])
  const r = await geocodeAddress('somewhere in bk')
  assert.equal(r.neighborhood, 'Williamsburg')
  assert.equal(r.source, 'nominatim')
  globalThis.fetch = realFetch
})

// ── Sonnet fallback ──────────────────────────────────────────────────────────
test('null Nominatim → Sonnet fallback fills neighborhood', async () => {
  stubFetch([]) // no results from Nominatim
  const r = await geocodeAddress('123 Bedford Ave', { sonnetClient: fakeSonnet('Williamsburg') })
  assert.equal(r.source, 'sonnet')
  assert.equal(r.neighborhood, 'Williamsburg')
  globalThis.fetch = realFetch
})

test('Nominatim result without a neighborhood → Sonnet fallback', async () => {
  stubFetch([{ lat: '40.7', lon: '-74.0', address: { city: 'New York' } }]) // no hood fields
  const r = await geocodeAddress('123 Nowhere', { sonnetClient: fakeSonnet('Tribeca') })
  assert.equal(r.source, 'sonnet')
  assert.equal(r.neighborhood, 'Tribeca')
  globalThis.fetch = realFetch
})

test('Sonnet "unknown" becomes null (hallucination-safe)', async () => {
  stubFetch([])
  const r = await geocodeAddress('gibberish address', { sonnetClient: fakeSonnet('unknown') })
  assert.equal(r.source, 'none')
  assert.equal(r.neighborhood, null)
  globalThis.fetch = realFetch
})

test('empty address short-circuits to none', async () => {
  const r = await geocodeAddress('   ')
  assert.equal(r.source, 'none')
  assert.equal(r.neighborhood, null)
})

// ── Rate limiter ─────────────────────────────────────────────────────────────
test('throttle spaces consecutive Nominatim calls', async () => {
  process.env.NOMINATIM_MIN_INTERVAL_MS = '200'
  const times: number[] = []
  globalThis.fetch = (async () => {
    times.push(Date.now())
    return { ok: true, json: async () => [] }
  }) as unknown as typeof fetch

  await geocodeAddress('a')
  await geocodeAddress('b')

  assert.equal(times.length, 2)
  const gap = times[1] - times[0]
  assert.ok(gap >= 180, `expected >=180ms between calls, got ${gap}ms`)

  process.env.NOMINATIM_MIN_INTERVAL_MS = '20'
  globalThis.fetch = realFetch
})

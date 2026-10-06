// Brief 41 (H8) — PLUTO owner names are used in memory for the co-op check and
// never stored: not in NycParcelCache.ownername, not in any reason text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COOP_OWNER_REASON, withoutOwnerName } from '../ownerName'

const ROOT = join(__dirname, '..', '..', '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')

test('old reasons lose the owner name; others are untouched', () => {
  assert.equal(withoutOwnerName('pluto_class=D4+ownername_corp:123 MAIN ST OWNERS CORP'), 'pluto_class=D4+ownername_corp')
  assert.equal(withoutOwnerName('cached:pluto_class=C6+ownername_corp:ACME TENANTS CORP+x'), 'cached:pluto_class=C6+ownername_corp+x')
  assert.equal(withoutOwnerName('pluto_class=A1:one_family'), 'pluto_class=A1:one_family')
  assert.equal(COOP_OWNER_REASON, 'ownername_corp')
})

test('the enrichment code never writes or reads the stored owner name', () => {
  const resolve = src('lib/enrichment/nyc/resolvePropertyType.ts')
  assert.doesNotMatch(resolve, /ownername:\s*pluto/)
  assert.doesNotMatch(resolve, /ownername_corp:\$\{/)
  assert.match(resolve, /cached:\$\{withoutOwnerName\(cached\.propertyTypeReason\)\}/)
  const cache = src('lib/enrichment/nyc/cache.ts')
  assert.doesNotMatch(cache, /^\s*ownername\??:/m)
  assert.match(cache, /readCache[\s\S]*select: \{/)
  assert.doesNotMatch(cache.slice(cache.indexOf('export async function readCache')), /ownername: true/)
})

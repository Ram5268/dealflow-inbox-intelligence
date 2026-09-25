import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { POST } from '../route'

// Brief 34: POST /api/instantly/enroll is refused unless INSTANTLY_ENROLL_ENABLED
// is exactly 'true'. Runs under tsx (the route imports @/ aliases). No case here
// reaches the database or Instantly.
const saved = { enabled: process.env.INSTANTLY_ENROLL_ENABLED, testMode: process.env.TEST_MODE_ONLY }
after(() => {
  for (const [k, v] of [['INSTANTLY_ENROLL_ENABLED', saved.enabled], ['TEST_MODE_ONLY', saved.testMode]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const enroll = () => POST(new NextRequest('http://localhost/api/instantly/enroll', {
  method: 'POST',
  body: JSON.stringify({ campaignId: 'campaign', mojoList: 'Brooklyn Brownstones' }),
}))

test('403 unless INSTANTLY_ENROLL_ENABLED is exactly "true"', async () => {
  process.env.TEST_MODE_ONLY = 'false' // the kill switch must hold even with test mode off
  for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
    if (v === undefined) delete process.env.INSTANTLY_ENROLL_ENABLED
    else process.env.INSTANTLY_ENROLL_ENABLED = v
    const res = await enroll()
    assert.equal(res.status, 403, `INSTANTLY_ENROLL_ENABLED=${v}`)
    assert.equal((await res.json()).ok, false)
  }
})

test('"true" passes the kill switch; the TEST_MODE_ONLY gate still applies after it', async () => {
  process.env.INSTANTLY_ENROLL_ENABLED = 'true'
  process.env.TEST_MODE_ONLY = 'true'
  const res = await enroll()
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: false, reason: 'TEST_MODE_ONLY is on' })
})

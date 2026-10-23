// Brief 48 PR 13 (L2; TEST_PLAN P-06): the weekly change in the 30-year rate
// was a percentage-point difference labelled "bps", so Drift was told "down
// 0.10bps" for a 10-basis-point move, and could repeat it. It now says
// "down 10 basis points", with no em-dash for Drift to copy. Pure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatRateContext } from '../mortgageRates'

const at = (rate: number, prevRate: number) => formatRateContext({
  rate, prevRate, weekOf: '2026-10-15', fetchedAt: 0,
  trend: rate > prevRate ? 'up' : rate < prevRate ? 'down' : 'flat',
})

test('a 10-basis-point drop reads "down 10 basis points"', () => {
  const line = at(6.3, 6.4)
  assert.equal(line, '30-year fixed mortgage rate: 6.30% (week of 2026-10-15), down 10 basis points from 6.40% the week before')
  assert.doesNotMatch(line, /bps|0\.10|—/)
})

test('rises, one basis point, and no change', () => {
  assert.match(at(6.45, 6.2), /, up 25 basis points from 6\.20% the week before$/)
  assert.match(at(6.31, 6.3), /, up 1 basis point from 6\.30% the week before$/)
  assert.match(at(6.3, 6.3), /, unchanged from the week before$/)
})

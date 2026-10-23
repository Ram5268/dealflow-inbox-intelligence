// Brief 48 (PR 15, item 4.13): two StreetEasy leftovers, pinned by reading the source
// (as lib/__tests__/maintenanceSwitch.test.ts does). No database, no network.
// - The StreetEasy page check (lib/streetEasyStatus.ts) is removed. It picked
//   listings whose email's webLink contained "streeteasy.com", but webLink is the
//   Outlook link Microsoft Graph gives every email, so it never picked any. Making
//   it work would mean fetching StreetEasy's pages with Ryan's StreetEasy login
//   cookies and a browser's identity; the RapidAPI status check
//   (lib/streetEasySync.ts) already does that job through a data feed.
// - The comments give RapidAPI's current limit: a hard stop at 9,500 of the
//   10,000 calls a month, not the old 4,900 of 5,000.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === '_archive' || name === '__tests__') continue
    const rel = join(dir, name)
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
  }
  return out
}
const CODE = ['app', 'lib', 'scripts', 'components'].flatMap(d => walk(d))

test('the StreetEasy page check is gone, and nothing calls it', () => {
  assert.equal(existsSync(join(ROOT, 'lib/streetEasyStatus.ts')), false, 'lib/streetEasyStatus.ts is removed')
  // An import of the module (not the streetEasyStatus column, nor lib/streetEasyStatusUpdate.ts).
  const callers = CODE.filter(f => /['"][^'"]*\/streetEasyStatus['"]|checkStreetEasyStatuses/.test(src(f)))
  assert.deepEqual(callers, [])
})

test("only the kept hotsheet tool reads Ryan's StreetEasy login cookies", () => {
  // scripts/inspect-hotsheet.ts is the hotsheet tool Ryan keeps switched off (1.9).
  const readers = CODE.filter(f => /SE_USER_AUTH_TOKEN|SE_REMEMBER_USER_TOKEN/.test(src(f)))
  assert.deepEqual(readers, ['scripts/inspect-hotsheet.ts'])
})

test("comments give RapidAPI's current limit (9,500 of 10,000 a month)", () => {
  const sync = src('lib/streetEasySync.ts')
  assert.match(sync, /row\.callsConsumed >= 9500\)/, 'the hard stop is 9,500')
  assert.match(src('prisma/schema.prisma'), /monthlyBudget\s+Int\s+@default\(10000\)/, 'the monthly budget is 10,000')
  assert.match(sync, /hard stop at 9,500 of the 10,000/, 'the quota comment says so')
  const OLD = /4,?900\s*\/\s*5,?000|PRO tier \(~5000|~5000 calls|5,?000 calls\/month/
  const stale = CODE.filter(f => OLD.test(src(f)))
  assert.deepEqual(stale, [], `old RapidAPI limit in: ${stale.join(', ')}`)
})

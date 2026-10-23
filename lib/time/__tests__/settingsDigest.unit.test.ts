// Brief 48 (PR 4): Settings no longer offers a digest-time picker, which did nothing (the digest runs
// at a fixed 12:00 UTC from vercel.json, and never reads the saved time), and it says when the digest
// really arrives, in words that stay true across daylight saving [planner; Brief 46 S7]. A source
// check, as in lib/__tests__/maintenanceSwitch.test.ts, because the Notifications section only renders
// in a browser after the preferences load; the executor checks the page itself. The wording is
// covered in newYork.unit.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(__dirname, '..', '..', '..', 'app', 'settings', 'page.tsx'), 'utf8')
const start = page.indexOf('<Section title="Notifications">')
const notifications = page.slice(start, page.indexOf('</Section>', start))

test('Settings: the Notifications section is where it was', () => {
  assert.ok(start > 0 && notifications.length > 0)
  assert.ok(notifications.includes('Morning digest') && notifications.includes('Send Test Push'))
})

test('Settings: no digest-time picker', () => {
  assert.ok(!/type=["']time["']/.test(notifications), 'no time input')
  assert.ok(!/Digest time/.test(notifications), 'no "Digest time" row')
  assert.ok(!/digestTime:\s*e\.target/.test(page), 'nothing saves a picked time')
})

test('Settings: the digest line comes from the real schedule, not a fixed "8:00 AM ET"', () => {
  assert.ok(!/8:00 AM ET/.test(page), 'the fixed line is gone')
  assert.ok(/digestScheduleLabel\(new Date\(\)\)/.test(notifications), 'the label is computed from the schedule')
  assert.ok(/^import \{ digestScheduleLabel \} from '@\/lib\/time\/newYork'$/m.test(page), 'imported from lib/time/newYork')
  assert.ok(notifications.includes("notifSaving ? 'Saving…' : ''"), 'still says Saving…')
})

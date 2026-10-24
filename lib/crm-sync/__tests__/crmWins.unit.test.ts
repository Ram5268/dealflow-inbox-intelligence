import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CRM_WINS, CRM_WINS_INSERT_SQL, CRM_WINS_RAN_LAST_SQL, CRM_WINS_UPDATE_SQL, DO_NOT_CALL_STATUS, NOTES_KEPT_HEADING, countFieldChanges, crmOwnName,
  crmWinsAfter, crmWinsIsOn, crmWinsKeepStatus, crmWinsNotes, crmWinsPreview, crmWinsRunCounts, identityLosses, isDoNotCallStatus,
  keepOldAfter, massChangeLimit, overMassChangeLimit, parseCrmWinsArgs, readCrmWinsSwitch, runCrmWinsSwitch, toCrmWinsRow,
  type CurrentRow, type Snapshot,
} from '../crmWins'
import { COLUMNS, UPSERT_SQL, toUpsertRow } from '../upsert'
import { mapLead, type CrmContact } from '../mapLead'
import type { CrmLeadRow } from '../crmReader'
import type { ExistingRow, SyncPlan } from '../plan'
import { applyHardFilters } from '../../ranking/hardFilters'
import { isOptOutWording } from '../../chat/sellerCard'

// Brief 48 (PR 7, item 1.5): the CRM_WINS switch and the "CRM wins" rules [Ryan,
// 2026-10-19]. Pure: the database is faked; the SQL's behaviour on real Postgres is in
// crmWins.integration.test.ts and crmSyncGolden.integration.test.ts.
const flat = (s: string) => s.replace(/\s+/g, ' ')

// ── The switch ──────────────────────────────────────────────────────────────

const flagDb = (row: unknown, opts: { throws?: boolean } = {}) => {
  const writes: unknown[] = []
  return {
    writes,
    featureFlag: {
      findUnique: async (args: { where: { id: string } }) => {
        assert.equal(args.where.id, CRM_WINS)
        if (opts.throws) throw new TypeError('relation "FeatureFlag" does not exist (select …)')
        return row
      },
      upsert: async (args: unknown) => { writes.push(args); return {} },
    },
  } as never as Parameters<typeof runCrmWinsSwitch>[0] & { writes: unknown[] }
}

test('the switch is on only for a row with enabled === true; no row, off, junk or a failed read is off', async () => {
  for (const [row, on] of [[{ enabled: true }, true], [{ enabled: false }, false], [null, false], [{ enabled: 'true' }, false], [{}, false]] as const) {
    assert.equal(crmWinsIsOn(row), on)
    assert.equal(await readCrmWinsSwitch(flagDb(row)), on)
  }
  const warn = console.warn
  const logged: string[] = []
  console.warn = (m: string) => { logged.push(m) }
  try {
    assert.equal(await readCrmWinsSwitch(flagDb(null, { throws: true })), false)
  } finally {
    console.warn = warn
  }
  assert.equal(logged.length, 1)
  assert.match(logged[0], /CRM_WINS switch couldn't be read \(TypeError\): copying with the keep-old rule/)
  assert.doesNotMatch(logged[0], /select|relation/, 'only the class name, never the message')
})

test('the switch script: arguments, state, dry run, apply on and off', async () => {
  assert.equal(parseCrmWinsArgs([]), null)
  assert.equal(parseCrmWinsArgs(['--on']), 'on')
  assert.equal(parseCrmWinsArgs(['--off']), 'off')
  for (const bad of [['--on', '--off'], ['on'], ['--yes']]) assert.equal(parseCrmWinsArgs(bad), 'usage')

  assert.deepEqual(await runCrmWinsSwitch(flagDb(null), null, false), ['CRM_WINS: off (no row)'])
  const dry = flagDb(null)
  assert.deepEqual(await runCrmWinsSwitch(dry, 'on', false), ['CRM_WINS: off (no row)', 'Dry run: nothing changed. Add --apply to turn it on.'])
  assert.equal(dry.writes.length, 0)
  const on = flagDb(null)
  const [line] = await runCrmWinsSwitch(on, 'on', true)
  assert.match(line, /^CRM_WINS: off \(no row\) -> on\. The next CRM copy/)
  assert.deepEqual(on.writes, [{ where: { id: CRM_WINS }, update: { enabled: true }, create: { id: CRM_WINS, enabled: true } }])
  const off = flagDb({ enabled: true })
  await runCrmWinsSwitch(off, 'off', true)
  assert.deepEqual(off.writes, [{ where: { id: CRM_WINS }, update: { enabled: false }, create: { id: CRM_WINS, enabled: false } }])
  const same = flagDb({ enabled: true })
  assert.deepEqual(await runCrmWinsSwitch(same, 'on', true), ['CRM_WINS: on, unchanged'])
  assert.equal(same.writes.length, 0)
})

test('the copy reads the switch once and, off, runs exactly the keep-old statements and self-check it always ran', () => {
  const src = readFileSync(join(__dirname, '../runSync.ts'), 'utf8')
  // Brief 48 (PR 7 review r2): read once before planning, and again (locked) inside the transaction.
  assert.match(src, /const switchState = await readCrmWinsSwitchState\(prisma\)\n  const crmWins = switchState === true/)
  assert.equal(src.match(/readCrmWinsSwitchState\(/g)?.length, 1)
  assert.ok(src.indexOf('SWITCH_IN_TRANSACTION_SQL)') < src.indexOf('REKEY_SQL, JSON.stringify'), 'the locked read comes first in the transaction')
  assert.match(src, /: plan\.upserts\.map\(toUpsertRow\)/)
  assert.match(src, /if \(!crmWins\) returned\.push\(\.\.\.await tx\.\$queryRawUnsafe<UpsertReturn\[\]>\(UPSERT_SQL, chunk, org\.id\)\)/)
  assert.ok(src.includes('throw new Error(`keep-old rule violated on ${changed.length} values (rolled back): ${changed.slice(0, 10).join(\', \')}`)'))
  // The result gets its CRM-wins keys only on a run with the switch on.
  assert.match(src, /\.\.\.\(wins && \{ crmWins: true as const, changed: wins\.changed, notesKeptBelow: wins\.notesKeptBelow \}\)/)
})

// ── The rules ───────────────────────────────────────────────────────────────

test('the do-not-call words are exactly the ones the call list\'s hard filter excludes', () => {
  const excluded = (status: string) => applyHardFilters({
    status, tags: [], groups: [], phones: ['7185550142'], phoneDncFlags: [false], matchCount: 1, allMatchesRental: false,
  }).reason === 'status_do_not_call'
  for (const w of DO_NOT_CALL_STATUS) {
    assert.ok(excluded(w) && isDoNotCallStatus(w), w)
    assert.ok(excluded(`Lead marked ${w.toUpperCase()}`) && isDoNotCallStatus(`Lead marked ${w.toUpperCase()}`), w)
  }
  for (const s of ['No Answer', 'Contact', 'Left Voicemail', '']) assert.ok(!excluded(s) && !isDoNotCallStatus(s), s)
  assert.equal(isDoNotCallStatus(null), false)
})

test('notes: blanks keep the other side; containment needs no heading; DealFlow\'s own text stays under the heading, run after run', () => {
  assert.equal(crmWinsNotes(null, 'CRM note'), 'CRM note')
  assert.equal(crmWinsNotes('DealFlow note', null), 'DealFlow note')
  assert.equal(crmWinsNotes(null, null), null)
  assert.equal(crmWinsNotes('Left a voicemail.', 'Left a voicemail. Called back 10/15.'), 'Left a voicemail. Called back 10/15.')
  assert.equal(crmWinsNotes('Left a voicemail.\nBeds: 3 | Baths: 2', 'Left a voicemail.'), 'Left a voicemail.\nBeds: 3 | Baths: 2')
  const first = crmWinsNotes('Beds: 3 (old upload)', 'Asked for a valuation.')
  assert.equal(first, `Asked for a valuation.\n\n${NOTES_KEPT_HEADING}\nBeds: 3 (old upload)`)
  assert.equal(crmWinsNotes(first, 'Asked for a valuation.'), first, 'the same CRM notes change nothing')
  assert.equal(crmWinsNotes(first, 'Valuation sent 10/20.'), `Valuation sent 10/20.\n\n${NOTES_KEPT_HEADING}\nBeds: 3 (old upload)`)
  const again = crmWinsNotes(crmWinsNotes(first, 'Valuation sent 10/20.'), 'Valuation sent 10/20.') ?? ''
  assert.equal(again.match(new RegExp(NOTES_KEPT_HEADING, 'g'))?.length, 1)
})

test('the CRM lead\'s own name, or null', () => {
  assert.equal(crmOwnName({ name: '  Pat   Example ' }), 'Pat Example')
  for (const name of [null, '', '   ']) assert.equal(crmOwnName({ name }), null)
})

const lead: CrmLeadRow = {
  id: 'lead_1', mojoId: '90001', name: 'Pat Example', displayName: 'Pat Example', primaryAddressFull: '88 Example Ave, Brooklyn, NY 11221',
  updatedAt: '2026-10-18 09:00:00', contactName: null, phones: ['+17185550142', '+17185550143'], emails: ['pat@example.com'],
  fields: {
    'Last Contacted Date': { t: null, n: null, d: '2026-10-15 10:30:00' }, 'Last Call Result': { t: 'Contact', n: null, d: null },
    Notes: { t: 'Asked for a valuation.', n: null, d: null }, Bedrooms: { t: null, n: null, d: null },
  },
}
const keeper: ExistingRow = {
  id: 'mc_1', mojoId: '90001', fullName: 'Pat Exampel', address: '88 Example Ave', state: 'NY', zipCode: '11221',
  phone: '7185550199', additionalPhones: [], email: 'old@example.com', additionalEmails: [],
}
const before: Snapshot = {
  fullName: 'Pat Exampel', phone: '7185550199', additionalPhones: [], email: 'old@example.com', additionalEmails: [],
  address: '88 Example Ave', propertyBeds: 4, yearBuilt: 1920, lastCalled: '2026-08-01T09:00:00', status: 'No Answer', notes: 'Beds: 4 (old upload)',
  metadata: { source: 'crm', crmLeadId: 'lead_1', crmOptOut: true },
}
const upsert = (c: CrmContact = mapLead(lead)) => ({ contact: c, keeper })

test('crmWinsAfter: CRM values win, blanks keep DealFlow\'s, notes kept under the heading, metadata merged', () => {
  const after = crmWinsAfter(before, toCrmWinsRow(upsert(), 'Pat Example'), false)
  assert.equal(after.fullName, 'Pat Example')
  assert.deepEqual([after.phone, after.additionalPhones], ['7185550142', ['7185550143']])
  assert.deepEqual([after.email, after.additionalEmails], ['pat@example.com', []])
  assert.equal(after.lastCalled, '2026-10-15T10:30:00') // the date that never arrived under keep-old
  assert.equal(after.status, 'Contact')
  assert.deepEqual([after.propertyBeds, after.yearBuilt], [4, 1920], 'the CRM has none: DealFlow\'s stay')
  assert.equal(after.notes, `Asked for a valuation.\n\n${NOTES_KEPT_HEADING}\nBeds: 4 (old upload)`)
  assert.equal((after.metadata as Record<string, unknown>).crmOptOut, true, 'a do-not-contact mark is never wiped')
  assert.equal('neighborhood' in after, false, 'written only when a seller is first copied')
})

test('crmWinsAfter: no CRM name, a do-not-call status, stored per-phone flags, and empty CRM lists keep DealFlow\'s', () => {
  const quiet = mapLead({ ...lead, name: null, phones: [], emails: [], fields: { 'Last Call Result': { t: 'No Answer', n: null, d: null } } })
  const after = crmWinsAfter({ ...before, status: 'Do Not Call' }, toCrmWinsRow(upsert(quiet), null), false)
  assert.equal(after.fullName, 'Pat Exampel')
  assert.equal(after.status, 'Do Not Call')
  assert.deepEqual([after.phone, after.email], ['7185550199', 'old@example.com'])
  const flagged = crmWinsAfter(before, toCrmWinsRow(upsert(), 'Pat Example'), true)
  assert.deepEqual([flagged.phone, flagged.additionalPhones], ['7185550199', []])
  // A do-not-call status from the CRM still lands.
  const dnc = mapLead({ ...lead, fields: { 'Last Call Result': { t: 'DNC', n: null, d: null } } })
  assert.equal(crmWinsAfter(before, toCrmWinsRow(upsert(dnc), 'Pat Example'), false).status, 'DNC')
})

test('keepOldAfter: the keep-old rule only fills blanks and appends to the phone list', () => {
  const after = keepOldAfter(before, toUpsertRow(upsert()))
  assert.deepEqual([after.fullName, after.lastCalled, after.status, after.notes], ['Pat Exampel', '2026-08-01T09:00:00', 'No Answer', 'Beds: 4 (old upload)'])
  assert.deepEqual([after.phone, after.additionalPhones], ['7185550199', ['7185550142', '7185550143']])
})

test('a new seller gets the same row either way (only the id and the name hint differ)', () => {
  const contact = mapLead(lead)
  const { id: a, ...keepOld } = toUpsertRow({ contact, keeper: null })
  const { id: b, crmOwnName: name, keepStatus, ...wins } = toCrmWinsRow({ contact, keeper: null }, 'Pat Example')
  assert.deepEqual(wins, keepOld)
  assert.ok(a && b && name)
  assert.equal(keepStatus, false)
})

test('counts: fills, changes, and a value that went blank (which rolls the copy back); a shorter phone list is no erase', () => {
  const b: Snapshot = { phone: '1', additionalPhones: ['2'], status: 'N/A', notes: null, unitCount: 2, metadata: null }
  const a: Snapshot = { phone: '3', additionalPhones: [], status: 'Contact', notes: 'x', unitCount: null, metadata: { source: 'crm' } }
  assert.deepEqual(countFieldChanges([{ mojoId: '9', before: b, after: a }]), {
    filled: { notes: 1 }, changed: { phone: 1, additionalPhones: 1, status: 1 }, erased: ['9.unitCount'],
  })
  const run = crmWinsRunCounts([
    { mojoId: '1', inserted: true, before: {}, after: { notes: 'x' } },
    { mojoId: '2', inserted: false, before: { notes: 'own' }, after: { notes: `crm\n\n${NOTES_KEPT_HEADING}\nown` } },
  ])
  assert.deepEqual([run.changed, run.filled, run.erased, run.notesKeptBelow], [{ notes: 1 }, {}, [], 1])
})

test('the CRM-wins statements: same guards as the keep-old upsert, neighborhood never updated, one jsonb parameter', () => {
  const upd = flat(CRM_WINS_UPDATE_SQL)
  assert.match(upd, /UPDATE "MojoContact" AS m SET "updatedAt" = now\(\), /)
  assert.match(upd, /FROM src AS s WHERE m\."mojoId" = s\."mojoId" AND NOT m\."isTestData" AND m\."organizationId" = \$2 AND \(/)
  assert.match(upd, /\) IS DISTINCT FROM \(m\."fullName", /)
  assert.ok(!upd.slice(upd.indexOf(' SET '), upd.indexOf(' FROM src')).includes('"neighborhood" ='))
  assert.ok(upd.includes(`"lastCalled" = COALESCE(s."lastCalled", m."lastCalled")`))
  assert.ok(upd.includes(`"fullName" = COALESCE(s."crmOwnName", m."fullName")`))
  assert.ok(upd.includes(`"metadata" = COALESCE(m."metadata", '{}'::jsonb) || s."metadata"`))
  const ins = flat(CRM_WINS_INSERT_SQL)
  assert.ok(ins.includes('ON CONFLICT ("mojoId") DO NOTHING'))
  // The insert half is the keep-old upsert's insert, word for word.
  const insertPart = (s: string) => flat(s).slice(flat(s).indexOf('INSERT INTO'), flat(s).indexOf(' ON CONFLICT'))
  assert.equal(insertPart(CRM_WINS_INSERT_SQL), insertPart(UPSERT_SQL))
  for (const s of [CRM_WINS_UPDATE_SQL, CRM_WINS_INSERT_SQL]) {
    assert.match(s, /jsonb_to_recordset\(\$1::jsonb\)/)
    assert.deepEqual([...new Set(s.match(/\$\d+/g))].sort(), ['$1', '$2'])
    for (const [c] of COLUMNS) assert.ok(s.includes(`"${c}"`), c)
  }
})

test('the preview: counts per field both ways, new sellers, kept notes, kept do-not-call statuses and kept phone lists; no values', () => {
  const contacts = [mapLead(lead), mapLead({ ...lead, id: 'lead_2', mojoId: '90002', name: 'Robin Sample' })]
  const plan: SyncPlan = { upserts: [{ contact: contacts[0], keeper }, { contact: contacts[1], keeper: null }], rekeys: [], duplicates: [], skipped: [] }
  const current = new Map<string, CurrentRow>([['mc_1', { before: { ...before, status: 'Do Not Call' }, flagged: true }]])
  const p = crmWinsPreview(plan, current, new Map([['90001', 'Pat Example']]))
  assert.deepEqual([p.sellersCompared, p.newSellers, p.heldElsewhere, p.skipped], [1, 1, 0, 0])
  assert.deepEqual([crmWinsPreview(plan, current, new Map(), new Set(['90002'])).heldElsewhere], [1])
  assert.deepEqual(p.withCrmWins.changed, { fullName: 1, email: 1, lastCalled: 1, notes: 1 })
  // Brief 48 (PR 8 review r1): the lead has no ZIP field, so its blank ZIP is filled from its address line.
  assert.deepEqual(p.withCrmWins.filled, { zipCode: 1 })
  assert.deepEqual([p.withCrmWins.notesKeptBelow, p.withCrmWins.doNotCallKept, p.withCrmWins.phoneListsKept, p.withCrmWins.wentBlank], [1, 1, 1, 0])
  assert.deepEqual(p.keepOldToday.filled, { additionalPhones: 1, additionalEmails: 1, zipCode: 1 })
  assert.deepEqual(p.keepOldToday.changed, {})
  assert.doesNotMatch(JSON.stringify(p), /Pat|Example|555|@|Ave|valuation/)
})

test('the preview script only reads: a read-only connection, checked before the first read, and no --apply', () => {
  const src = readFileSync(join(__dirname, '../../../scripts/brief48-crm-wins-preview.ts'), 'utf8')
  assert.ok(src.includes(`options: '-c default_transaction_read_only=on'`))
  assert.ok(src.indexOf(`SHOW transaction_read_only`) < src.indexOf('readCrmLeads(ORG_SLUG)'))
  assert.match(src, /if \(APPLY\) \{\s+console\.error\('This script only reads: it has no --apply\.'\)/)
  assert.doesNotMatch(src, /runCrmLeadSync|dryRun/, 'not the copy\'s rollback dry run')
})

// ── Brief 48 (PR 7 review r1) ───────────────────────────────────────────────

test('review r1: a status with Drift\'s opt-out wording is kept, so the "do not contact" badge stays', async () => {
  // Drift's badge itself; lib/prisma is never used here (a stand-in, so nothing connects).
  ;(globalThis as unknown as { prisma?: unknown }).prisma ??= {}
  const { doNotContact } = await import('../../chat/crmSellers')
  for (const old of ['Remove me from your list', 'Stop calling', 'Do-Not-Call', "Don't call", 'STOP', 'Do Not Call']) {
    assert.equal(crmWinsKeepStatus(old, 'No Answer'), true, old)
    const row = toCrmWinsRow(upsert(mapLead({ ...lead, fields: { 'Last Call Result': { t: 'No Answer', n: null, d: null } } })), 'Pat Example', crmWinsKeepStatus(old, 'No Answer'))
    const after = crmWinsAfter({ ...before, status: old, metadata: {} }, row, false)
    assert.equal(after.status, old, old)
    // Drift's badge (lastCallResult in metadata is the CRM's latest, "No Answer").
    assert.equal(doNotContact({ phoneDncFlags: [], metadata: { lastCallResult: 'No Answer' }, status: after.status as string }), true, old)
  }
  assert.equal(crmWinsKeepStatus('No Answer', 'Contact'), false)
  assert.equal(crmWinsKeepStatus('Remove me from your list', 'Do Not Call'), false, 'an opt-out from the CRM still lands')
  assert.equal(crmWinsKeepStatus(null, 'Contact'), false)
  assert.ok(flat(CRM_WINS_UPDATE_SQL).includes(`"status" = CASE WHEN s."keepStatus" OR (`))
  assert.ok(flat(CRM_WINS_UPDATE_SQL).includes(`"keepStatus" boolean`))
})

test('review r1: a CRM 0 in a number field never replaces DealFlow\'s number', () => {
  const zeros = mapLead({ ...lead, fields: { 'Square Footage': { t: null, n: 0, d: null }, 'Year Built': { t: null, n: 0, d: null } } })
  const after = crmWinsAfter({ ...before, buildingSqft: 2400, yearBuilt: 1920 }, toCrmWinsRow(upsert(zeros), 'Pat Example'), false)
  assert.deepEqual([after.buildingSqft, after.yearBuilt], [2400, 1920])
  const real = mapLead({ ...lead, fields: { 'Square Footage': { t: null, n: 2600, d: null } } })
  assert.equal(crmWinsAfter({ ...before, buildingSqft: 2400 }, toCrmWinsRow(upsert(real), 'Pat Example'), false).buildingSqft, 2600)
  const upd = flat(CRM_WINS_UPDATE_SQL)
  for (const c of ['unitCount', 'propertyBeds', 'propertyBaths', 'buildingSqft', 'yearBuilt']) {
    assert.ok(upd.includes(`"${c}" = COALESCE(NULLIF(s."${c}", 0), m."${c}")`), c)
  }
})

test('review r1: the mass-change limit counts dropped numbers and emails and replaced names and streets', () => {
  assert.equal(massChangeLimit(0), 50)
  assert.equal(massChangeLimit(1498), 150)
  const b: Snapshot = { fullName: 'Pat Example', phone: '(718) 555-0101', additionalPhones: ['7185550102'], email: 'pat@example.com', additionalEmails: [], address: '12 Sample St' }
  const same = { ...b, phone: '7185550101', fullName: 'PAT  EXAMPLE', address: '12 Sample Street', additionalPhones: ['7185550102', '7185550103'] }
  assert.deepEqual(identityLosses([{ before: b, after: same }]), { phonesDropped: 0, emailsDropped: 0, namesReplaced: 0, streetsReplaced: 0 })
  const other = { ...b, phone: '7185550109', additionalPhones: [], email: 'jordan@example.com', fullName: 'Jordan Sample', address: '14 Sample St' }
  assert.deepEqual(identityLosses([{ before: b, after: other }]), { phonesDropped: 1, emailsDropped: 1, namesReplaced: 1, streetsReplaced: 1 })
  assert.deepEqual(identityLosses([{ before: { ...b, fullName: null, address: null }, after: other }]).namesReplaced, 0, 'a fill is no loss')
  assert.equal(identityLosses([{ before: { ...b, fullName: '陈 例' }, after: { ...b, fullName: '李 例' } }]).namesReplaced, 1, 'any script')
  assert.deepEqual(overMassChangeLimit({ phonesDropped: 51, emailsDropped: 50, namesReplaced: 0, streetsReplaced: 0 }, 50), ['phonesDropped 51'])
  const src = readFileSync(join(__dirname, '../runSync.ts'), 'utf8')
  assert.match(src, /if \(ranLast\) throw new Error\(`CRM-wins mass change \(rolled back\): \$\{over\.join\(', '\)\} sellers, over the limit of \$\{limit\}`\)/)
})

// ── Brief 48 (PR 7 review r2) ───────────────────────────────────────────────

test('review r2: a status keeps every do-not-contact mark it has: the call list\'s words and Drift\'s wording, each on its own', () => {
  const callList = (s: string | null) => applyHardFilters({ status: s, tags: [], groups: [], phones: [], phoneDncFlags: [], matchCount: 1, allMatchesRental: false }).excluded
  const badge = (s: string | null) => s != null && isOptOutWording(s)
  // "Non-DNC" and "DNC scrub passed" are do-not-call to the call list's substring match but not to Drift's wording.
  const optOut = ['Do Not Call', 'DNC', 'do_not_call', 'Opted Out', 'Remove me from your list', 'Stop calling', 'STOP', 'Unsubscribe', "Don't call", 'Non-DNC', 'DNC scrub passed']
  const other = [null, 'Contact', 'No Answer', 'Not interested', 'May stop by Tuesday']
  for (const cur of [...optOut, ...other]) for (const crm of [...optOut, ...other]) {
    const row = toCrmWinsRow(upsert(mapLead({ ...lead, fields: crm == null ? {} : { 'Last Call Result': { t: crm, n: null, d: null } } })), 'Pat Example', crmWinsKeepStatus(cur, crm))
    const after = crmWinsAfter({ ...before, status: cur, metadata: {} }, row, false).status as string | null
    const pair = `${cur} <- ${crm} = ${after}`
    if (callList(cur)) assert.ok(callList(after), `the call list still leaves them out: ${pair}`)
    if (badge(cur)) assert.ok(badge(after), `Drift's badge stays: ${pair}`)
    if (!callList(cur) && !badge(cur) && (callList(crm) || badge(crm))) assert.equal(after, crm, `an opt-out from the CRM lands: ${pair}`)
  }
})

test('review r2: the first-copy pass belongs to the switch (its last change), not to the newest copy', () => {
  const sql = flat(CRM_WINS_RAN_LAST_SQL)
  assert.ok(sql.includes(`JOIN "FeatureFlag" f ON f.id = 'CRM_WINS'`), sql)
  assert.ok(sql.includes(`a."detailsJson"->>'crmWins' = 'true' AND a."createdAt" >= f."updatedAt"`), sql)
})

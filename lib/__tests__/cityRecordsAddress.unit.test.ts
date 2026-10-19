// Brief 43 PR 11 (Q16, Q24): how the city-records lookups read an address
// out of a chat message. The borough, zip or neighborhood Ryan types is kept
// (it used to be dropped, so every borough was searched), and the common
// street forms are recognised (Rd, Ln, Ct, Ter, Parkway, Plaza, Circle, Sq,
// "1500 Broadway", "St. Marks Pl", ...). Pure: no network, no database.
// Addresses are made up ("Marigold Street", "Example Ave") or public
// buildings (offices, a museum); none is a CRM homeowner's.
// [engineering precaution]
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as acris from '../acris'
import { extractAddressFromText, parseAddress } from '../acris'

const borough = (address: string | null) => (address ? parseAddress(address)?.boroughCode ?? null : null)
const street = (address: string | null) => (address ? parseAddress(address)?.streetName ?? null : null)

test('the borough and zip typed with the address are kept (drift-2 P-05)', () => {
  const full = extractAddressFromText('who owns 418 Marigold Street, Brooklyn, NY 11221?')
  assert.ok(full?.startsWith('418 Marigold Street'), String(full))
  assert.match(full ?? '', /Brooklyn/)
  assert.match(full ?? '', /11221/)
  assert.equal(borough(full), '3')
  assert.equal(street(full), 'MARIGOLD STREET')

  assert.equal(borough(extractAddressFromText('who owns 418 marigold st bk?')), '3')
  assert.equal(borough(extractAddressFromText('who owns 418 Marigold St, Bedford-Stuyvesant')), '3')
  assert.equal(borough(extractAddressFromText('any permits at 1201 Larchmont Avenue Bushwick')), '3')
  assert.equal(borough(extractAddressFromText('any permits or violations at 11 West 53rd Street, Manhattan?')), '1')
  assert.equal(borough(extractAddressFromText('who owns 36-01 35th Avenue, Astoria, Queens')), '4')
  assert.equal(street(extractAddressFromText('who owns 36-01 35th Avenue, Astoria, Queens')), '35 AVENUE')
})

test('a zip alone picks the borough', () => {
  assert.equal(borough(extractAddressFromText('who owns 418 Marigold Street 11221?')), '3')
  assert.equal(borough(extractAddressFromText('who owns 418 Marigold Street, 11101')), '4')
  assert.equal(borough(extractAddressFromText('who owns 1500 Broadway, New York, NY 10036?')), '1')
})

test('no borough typed: none is made up', () => {
  assert.equal(extractAddressFromText('who owns 418 Marigold Street?'), '418 Marigold Street')
  assert.equal(borough(extractAddressFromText('who owns 418 Marigold Street?')), null)
})

test('the common street forms extract (drift-2 p1b; Q24)', () => {
  const cases: Array<[string, string, string]> = [
    // [message, extracted street starts with, normalised street name]
    ['who owns 200 Eastern Parkway?', '200 Eastern Parkway', 'EASTERN PARKWAY'],
    ['who owns 200 Eastern Pkwy', '200 Eastern Pkwy', 'EASTERN PARKWAY'],
    ['who owns 45 Example Rd', '45 Example Rd', 'EXAMPLE ROAD'],
    ['who owns 12 Sample Ln', '12 Sample Ln', 'SAMPLE LANE'],
    ['who owns 33 Maiden Ln?', '33 Maiden Ln', 'MAIDEN LANE'],
    ['who owns 9 Roosevelt Ct?', '9 Roosevelt Ct', 'ROOSEVELT COURT'],
    ['who owns 9 Roosevelt Court', '9 Roosevelt Court', 'ROOSEVELT COURT'],
    ['who owns 3 Marigold Ter', '3 Marigold Ter', 'MARIGOLD TERRACE'],
    ['who owns 1000 Richmond Terrace', '1000 Richmond Terrace', 'RICHMOND TERRACE'],
    ['who owns 1 Broadway', '1 Broadway', 'BROADWAY'],
    ['who owns 1500 Broadway', '1500 Broadway', 'BROADWAY'],
    ['who owns 1500 Broadway?', '1500 Broadway', 'BROADWAY'],
    ['who owns 12 Example Park West', '12 Example Park West', 'EXAMPLE PARK WEST'],
    ['who owns 7 Example Pl', '7 Example Pl', 'EXAMPLE PLACE'],
    ['what did 4 St. Marks Pl sell for?', '4 St. Marks Pl', 'ST MARKS PLACE'],
    ['who owns 4 St Marks Place', '4 St Marks Place', 'ST MARKS PLACE'],
    ['who owns 12 St. Example Ave', '12 St. Example Ave', 'ST EXAMPLE AVENUE'],
    ['who owns 12 Saint Example Avenue', '12 Saint Example Avenue', 'SAINT EXAMPLE AVENUE'],
    ['who owns 12 Example X Blvd', '12 Example X Blvd', 'EXAMPLE X BOULEVARD'],
    ['who owns 50 Dr Example Sample Jr Blvd', '50 Dr Example Sample Jr Blvd', 'DR EXAMPLE SAMPLE JR BOULEVARD'],
    ['who owns 70 Washington Sq S', '70 Washington Sq S', 'WASHINGTON SQUARE SOUTH'],
    ['who owns 10 Grand Army Plaza', '10 Grand Army Plaza', 'GRAND ARMY PLAZA'],
    ['who owns 10 Columbus Circle', '10 Columbus Circle', 'COLUMBUS CIRCLE'],
    ['who owns 2900 Southern Blvd', '2900 Southern Blvd', 'SOUTHERN BOULEVARD'],
    ['who owns 12 Example Hwy', '12 Example Hwy', 'EXAMPLE HIGHWAY'],
    ['who owns 350 Fifth Avenue', '350 Fifth Avenue', 'FIFTH AVENUE'],
    ['who owns 11 W 53rd St', '11 W 53rd St', 'WEST 53 STREET'],
    ['who owns 250 Park Ave S', '250 Park Ave S', 'PARK AVENUE SOUTH'],
    ['who owns 250 Park Avenue South, Manhattan', '250 Park Avenue South', 'PARK AVENUE SOUTH'],
    ['who owns 1600 Avenue L?', '1600 Avenue L', 'AVENUE L'],
  ]
  for (const [msg, starts, normalised] of cases) {
    const got = extractAddressFromText(msg)
    assert.ok(got?.startsWith(starts), `${msg} → ${got}`)
    assert.equal(street(got), normalised, msg)
  }
})

test('the street forms that already worked still do', () => {
  assert.equal(extractAddressFromText('who owns 45 Example Road'), '45 Example Road')
  assert.equal(extractAddressFromText('who owns 12 Sample St'), '12 Sample St')
  assert.equal(extractAddressFromText("'; DROP TABLE listings; -- 12 Main Street"), '12 Main Street')
  assert.equal(extractAddressFromText('any permits at 512 Example St and 600 Sample Ave?'), '512 Example St')
  assert.equal(extractAddressFromText('who owned it before that?'), null)
  assert.equal(extractAddressFromText("anything on St. Mark's Ave #3A or O'Neil Pl?"), null)
})

test('words after the street are not taken as part of it', () => {
  assert.equal(extractAddressFromText('who owns 418 Marigold St w/ 3 units'), '418 Marigold St')
  assert.equal(extractAddressFromText('when did 418 Marigold St last sell?'), '418 Marigold St')
  assert.equal(extractAddressFromText('my 2 sellers on Example Street'), null)
})

test('a borough or neighborhood word inside the street name is not the borough', () => {
  const find = (acris as unknown as { findAddressInText?: (t: string, h?: { boroughs?: string[] }) => { street: string; boroughCode: string | null; boroughFrom: string | null } | null }).findAddressInText
  assert.equal(typeof find, 'function', 'findAddressInText is exported')
  if (!find) return
  assert.equal(find('who owns 12 Brooklyn Example Ave?')?.boroughCode, null)
  assert.equal(find('who owns 12 Queens Example Blvd?')?.boroughCode, null)
  assert.equal(find('who owns 12 Flatbush Example Ave?')?.boroughCode, null)
  // "Manhattan Beach" is in Brooklyn.
  assert.equal(find('who owns 12 Example St, Manhattan Beach')?.boroughCode, '3')
})

test('the borough can come from elsewhere in the message, or from the parsed query', () => {
  const find = (acris as unknown as { findAddressInText?: (t: string, h?: { boroughs?: string[] }) => { street: string; boroughCode: string | null; boroughFrom: string | null } | null }).findAddressInText
  if (!find) return assert.fail('findAddressInText is exported')
  // Typed right after the address wins over the rest of the message.
  const a = find('my Queens buyer asked: who owns 418 Marigold Street, Brooklyn?')
  assert.deepEqual([a?.street, a?.boroughCode, a?.boroughFrom], ['418 Marigold Street', '3', 'address'])
  const b = find("who owns 418 Marigold Street? It's in Queens.")
  assert.deepEqual([b?.boroughCode, b?.boroughFrom], ['4', 'message'])
  // Two boroughs named, next to the address or elsewhere: unknown, not a guess.
  assert.equal(find('who owns 418 Marigold Street, Brooklyn or Queens?')?.boroughCode, null)
  assert.equal(find('who owns 418 Marigold Street? My buyer looked in Brooklyn and Queens.')?.boroughCode, null)
  // A neighborhood that is also a first name counts only next to the address.
  assert.equal(find('Travis asked who owns 418 Marigold Street?')?.boroughCode, null)
  assert.equal(find('who owns 418 Example St, Chelsea')?.boroughCode, '1')
  // Brief 43 PR 11 review: only the place words right after the street are
  // typed with it; a first name later in the sentence, or after "St.", is not.
  assert.equal(find('who owns 418 Example St for Travis')?.boroughCode, null)
  assert.equal(find('who owns 418 Example St. Travis wants to know')?.boroughCode, null)
  assert.equal(find('who owns 418 Example St, my buyer Jamaica is asking')?.boroughCode, null)
  assert.equal(find('Who owns 418 Example St. Chelsea asked me.')?.boroughCode, null)
  assert.deepEqual([find('who owns 418 Example St. My Queens buyer is asking.')?.boroughCode, find('who owns 418 Example St. My Queens buyer is asking.')?.boroughFrom], ['4', 'message'])
  assert.deepEqual([find('who owns 418 Example St Apt 3B, Brooklyn')?.boroughCode, find('who owns 418 Example St Apt 3B, Brooklyn')?.boroughFrom], ['3', 'address'])
  assert.deepEqual([find('who owns 418 Example St. Brooklyn')?.boroughCode, find('who owns 418 Example St. Brooklyn')?.boroughFrom], ['3', 'address'])
  // Typed with the address beats a borough later in the sentence, but not
  // one offered as an alternative.
  assert.equal(find('who owns 418 Example St, Queens/Brooklyn?')?.boroughFrom, 'conflict')
  assert.equal(find('who owns 418 Example St in Brooklyn or the Bronx?')?.boroughFrom, 'conflict')
  assert.deepEqual([find('who owns 418 Example St, Brooklyn or is it a condo?')?.boroughCode], ['3'])
  assert.deepEqual([find('who owns 418 Example St, Queens, for my Brooklyn buyer')?.boroughCode, find('who owns 418 Example St, Queens, for my Brooklyn buyer')?.boroughFrom], ['4', 'address'])
  assert.deepEqual([find('who owns 418 Example St, Brooklyn for my Queens buyer')?.boroughCode, find('who owns 418 Example St, Brooklyn for my Queens buyer')?.boroughFrom], ['3', 'address'])
  // parsed.boroughs is the last resort, unless the borough word is the street's own.
  const c = find('who owns 12 Example Park West', { boroughs: ['Manhattan'] })
  assert.deepEqual([c?.boroughCode, c?.boroughFrom], ['1', 'hint'])
  assert.equal(find('who owns 12 Brooklyn Example Ave', { boroughs: ['Brooklyn'] })?.boroughCode, null)
})

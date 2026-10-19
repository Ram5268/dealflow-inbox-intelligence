// Brief 48 (PR 5): the words of the morning digest and the realtime HOT alert.
// Counts only: push text never names a buyer or a homeowner and never shows an
// address [planner, Brief 48 §3 PR 5; Brief 46 P4]. It shows on a lock screen, and
// the old text put a party's name and a home's address there. A quiet morning says
// nothing about the inbox: email reading is paused [Ryan], so the old
// "Inbox synced Xd ago" wasn't true. Pure, so it is unit-tested.
//
// "Overnight" is true for the digest: it runs at 12:00 UTC (vercel.json) and counts
// matches made since 00:00 UTC, which is 8 PM (7 PM in winter) in New York.

export interface PushText {
  title: string
  body: string
}

// Grouped ("1,200"), so a count can never read as a phone number.
const n = (x: number) => x.toLocaleString('en-US')

export function digestText(counts: { hot: number; warm: number; possible: number }): PushText {
  const total = counts.hot + counts.warm + counts.possible
  if (total === 0) return { title: 'Quiet morning', body: 'No new matches overnight. Open DealFlow.' }
  const parts = ([['Hot', counts.hot], ['Warm', counts.warm], ['Possible', counts.possible]] as const)
    .filter(([, c]) => c > 0)
    .map(([label, c]) => `${n(c)} ${label}`)
  return {
    title: 'Morning matches',
    body: `${n(total)} new ${total === 1 ? 'match' : 'matches'} overnight: ${parts.join(', ')}. Open DealFlow.`,
  }
}

// The realtime alert (lib/push/hotAlert.ts) fires for the best of the HOT matches one
// sync made, so it doesn't claim a count.
export function hotAlertText(): PushText {
  return { title: 'New Hot match', body: 'A new Hot match. Open DealFlow.' }
}

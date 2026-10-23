// Brief 43 PR 14: today's date and time in New York, for Drift's per-turn
// context (lib/chat/context/calendar.ts). Drift wasn't told the date, so
// "today", "this week" (search's createdAfter) and "Thursday at 3" had nothing
// to go on, and the greeting ("Good morning, Ryan.", DRIFT_SCRIPT #1) needs
// the part of the day [engineering precaution]. Pure.

import { NEW_YORK_TIME_ZONE as NY } from '../../time/newYork'

function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  return 'evening'
}

export function todayLine(now: Date): string {
  const date = now.toLocaleDateString('en-US', { timeZone: NY, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  // Newer ICU puts a narrow no-break space before AM/PM; plain spaces read the same.
  const time = now.toLocaleTimeString('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s/g, ' ')
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', hourCycle: 'h23' }).format(now))
  return `\n\nTODAY: ${date}, ${time} in New York (${partOfDay(hour)}).`
}

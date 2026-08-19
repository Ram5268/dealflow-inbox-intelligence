// Brief 27.0 — "Showing schedule" section. Deterministic. There is no per-buyer
// calendar model in the schema (calendar is write-only Graph POST /me/events, not
// queried back per party), so confirmed/proposed showings are not on file. Per
// the anti-hallucination rule we say so plainly rather than inventing a schedule.
// When a showings data source lands, this section reads it; the shape is stable.
import type { GenContext, SectionResult } from '../../types'
import { nowISO } from '../../types'

export async function showingScheduleSection(ctx: GenContext): Promise<SectionResult> {
  const prose =
    `No confirmed or proposed showings on file for ${ctx.buyer.name}. ` +
    `Showings are booked through the calendar and are not tracked back to a buyer record yet, ` +
    `so schedule anything relevant directly and it will appear once showing tracking is wired in.`

  return {
    key: 'showing-schedule',
    title: 'Showing schedule',
    content: {
      prose,
      items: [],
      metrics: [{ label: 'Showings on file', value: '0', source: 'inbox' }],
    },
    sources: [{ type: 'inbox', id: ctx.buyer.id, at: nowISO() }],
  }
}

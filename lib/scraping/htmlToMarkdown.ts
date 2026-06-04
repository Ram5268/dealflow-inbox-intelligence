// Shared HTML→Markdown conversion (Tier 1 article content + Tier 3 HTML fallback).
import TurndownService from 'turndown'

const td = new TurndownService({
  headingStyle:   'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
})
// Strip non-content elements that occasionally survive Readability / raw HTML.
td.remove(['script', 'style', 'noscript'])

export function htmlToMarkdown(html: string): string {
  try {
    return td.turndown(html)
  } catch {
    return ''
  }
}

// Brief 43 PR 14 (Q38): the last clean-up of Drift's reply text before it is
// shown, stored and spoken. It was inline in app/api/chat/route.ts as
// `cleanResponse` (markdown and stray deal tags only); it moved here so tests
// can read it, and now also follows the feel standard (Brief 42 TEST_PLAN §3:
// calm, no exclamation marks, no em-dashes) whatever the model wrote:
// - an em-dash becomes a comma, or goes away at the start or end of a line and
//   next to other punctuation;
// - "!" becomes a period ("?!" a question mark).
// En-dashes in ranges ("2–5", "$1.2M–$1.5M") and hyphens stay. Links are left
// exactly as they are. Drafts (drift_response.draft) are not touched here.

const URL = /(https?:\/\/\S+)/
const BLANK = new Set([' ', '\t'])
const STOPS_AFTER = new Set([',', '.', ';', ':', '?'])
const STOPS_BEFORE = new Set(['.', ',', ';', ':', '?', '!', ')'])

// Plain loops, not regexes, around the dash: a long run of spaces can't slow them.
function trimBlankEnd(s: string): string {
  let i = s.length
  while (i > 0 && BLANK.has(s[i - 1])) i--
  return s.slice(0, i)
}
function trimBlankStart(s: string): string {
  let i = 0
  while (i < s.length && BLANK.has(s[i])) i++
  return s.slice(i)
}

function noEmDashes(text: string): string {
  if (!text.includes('—')) return text
  const parts = text.split('—')
  let out = parts[0]
  for (const part of parts.slice(1)) {
    const left = trimBlankEnd(out)
    const right = trimBlankStart(part)
    const lineStart = left === '' || left.endsWith('\n')
    const lineEnd = right === '' || right.startsWith('\n') || STOPS_BEFORE.has(right[0])
    if (lineStart || lineEnd) out = left + right
    else if (STOPS_AFTER.has(left[left.length - 1])) out = `${left} ${right}`
    else out = `${left}, ${right}`
  }
  return out
}

// Stray deal tags, with the space before them. Split on the tag rather than a
// leading \s*, which slows down on a long run of spaces.
function stripDealTags(text: string): string {
  if (!text.includes('[DEAL:')) return text
  const parts = text.split(/\[DEAL:[^\]]+\]/)
  return parts.map((part, i) => {
    if (i === parts.length - 1) return part
    let end = part.length
    while (end > 0 && /\s/.test(part[end - 1])) end--
    return part.slice(0, end)
  }).join('')
}

function calm(text: string): string {
  // "!" (and "!!!", "!.") becomes a period; "?!" keeps its question mark.
  return noEmDashes(text).replace(/([?.])?!+\.?/g, (_m, p: string | undefined) => p ?? '.')
}

export function cleanReplyText(text: string): string {
  const stripped = stripDealTags(text
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // strip **bold**
    .replace(/\*([^*]+)\*/g, '$1'))       // strip *italic*
  // Odd pieces of the split are links; only the text between them changes.
  return stripped.split(URL).map((part, i) => (i % 2 === 1 ? part : calm(part))).join('')
}

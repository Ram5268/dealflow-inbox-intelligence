// Brief 36 — pure text + audio helpers for voice mode (unit-tested).

export interface Paragraph {
  lead: string | null // "Day One:" style opener, rendered semibold
  sentences: number[] // indices into Reply.sentences
}
export interface Reply {
  paragraphs: Paragraph[]
  sentences: string[]
}

// Abbreviations and initials that end in "." without ending the sentence
// ("W. 96th St. has…"), so the TTS chunks don't break mid-sentence.
const ABBREVIATION = /(?:\b(?:St|Ave|Blvd|Rd|Pl|Mr|Mrs|Ms|Dr|Jr|Sr|No|Apt|vs|approx)|\b[A-Z])\.$/

export function splitSentences(paragraph: string): string[] {
  const out: string[] = []
  for (const part of paragraph.split(/(?<=[.!?]["”’)]?)\s+/)) {
    const s = part.trim()
    if (!s) continue
    if (out.length && ABBREVIATION.test(out[out.length - 1])) out[out.length - 1] += ' ' + s
    else out.push(s)
  }
  return out
}

// A paragraph-opening lead-in: up to 4 words ending in ':' ("Day One:").
export function leadIn(paragraph: string): string | null {
  const m = /^([^:.!?\n]{1,40}):\s/.exec(paragraph)
  return m && m[1].trim().split(/\s+/).length <= 4 ? `${m[1]}:` : null
}

export function buildReply(text: string): Reply {
  const sentences: string[] = []
  const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(Boolean).map(p => {
    const start = sentences.length
    sentences.push(...splitSentences(p))
    return { lead: leadIn(p), sentences: sentences.map((_, i) => i).slice(start) }
  })
  return { paragraphs, sentences }
}

// What the TTS should say: no markdown markers, list bullets or URLs.
export function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|[-•>]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Sample range [start, end) that holds sound, keeping `padS` of air either side.
// TTS clips carry ~0.25s of leading and up to ~0.7s of trailing silence.
export function silenceBounds(data: Float32Array, sampleRate: number, threshold = 0.01, padS = 0.02): [number, number] {
  const first = data.findIndex(v => Math.abs(v) > threshold)
  if (first < 0) return [0, data.length]
  const last = data.findLastIndex(v => Math.abs(v) > threshold)
  const pad = Math.round(padS * sampleRate)
  return [Math.max(0, first - pad), Math.min(data.length, last + 1 + pad)]
}

// How many sentences have started playing by audio-clock time `now`.
export function spokenCount(starts: readonly number[], now: number): number {
  return starts.filter(t => t <= now).length
}

// RMS level (0–1, boosted) of an analyser's time-domain bytes, for the glow.
export function levelOf(bytes: Uint8Array): number {
  let sum = 0
  for (const b of bytes) sum += ((b - 128) / 128) ** 2
  return Math.min(1, Math.sqrt(sum / Math.max(1, bytes.length)) * 4)
}

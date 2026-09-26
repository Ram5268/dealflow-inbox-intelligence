import { silenceBounds, stripMarkdown } from './text'

// Brief 36 — speaks a reply sentence by sentence. Every /api/tts request starts
// at once; each clip is decoded, trimmed of its leading/trailing silence and
// scheduled back to back on the audio clock. `starts` holds each sentence's
// start time (audio-clock seconds) for the dark-text highlight.

// done → true once everything played, false if stopped. stop() is tap to
// interrupt: it silences the current clip immediately.
export interface Speech { starts: number[]; done: Promise<boolean>; stop(): void }
export interface VoiceChoice { voice: string; speed: number }

function trim(ctx: AudioContext, buf: AudioBuffer): AudioBuffer {
  const [start, end] = silenceBounds(buf.getChannelData(0), buf.sampleRate)
  const out = ctx.createBuffer(buf.numberOfChannels, Math.max(1, end - start), buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(start, end), c)
  return out
}

// One sentence of speech: /api/tts → decoded, silence-trimmed AudioBuffer.
export async function loadClip(ctx: AudioContext, text: string, choice: VoiceChoice): Promise<AudioBuffer> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: stripMarkdown(text), ...choice }),
  })
  if (!res.ok) throw new Error(`tts ${res.status}`)
  return trim(ctx, await ctx.decodeAudioData(await res.arrayBuffer()))
}

// Settings-sheet voice previews, cached in memory for the page session.
const PREVIEW_LINE = 'Hi Ryan. This is how I’ll sound when we talk.'
const previews = new Map<string, Promise<AudioBuffer>>()
export function previewClip(ctx: AudioContext, choice: VoiceChoice): Promise<AudioBuffer> {
  const key = `${choice.voice}@${choice.speed}`
  let clip = previews.get(key)
  if (!clip) {
    clip = loadClip(ctx, PREVIEW_LINE, choice)
    clip.catch(() => previews.delete(key)) // retry next time
    previews.set(key, clip)
  }
  return clip
}

export function speakSentences(ctx: AudioContext, out: AudioNode, sentences: string[], choice: VoiceChoice, gapS: number): Speech {
  let stopped = false
  let wake: () => void = () => {}
  const sources: AudioBufferSourceNode[] = []
  const starts: number[] = []
  const clips = sentences.map(text => loadClip(ctx, text, choice))
  clips.forEach(p => p.catch(() => {})) // a failed sentence is skipped, not fatal

  const done = (async () => {
    let at = 0
    for (const clip of clips) {
      const buf = await clip.catch(() => null)
      if (stopped) return false
      const start = Math.max(at, ctx.currentTime + 0.03)
      starts.push(start)
      if (!buf) { at = start; continue }
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(out)
      src.start(start)
      sources.push(src)
      at = start + buf.duration + gapS
    }
    await new Promise<void>(resolve => {
      wake = resolve
      setTimeout(resolve, Math.max(0, (at - gapS - ctx.currentTime) * 1000))
    })
    return !stopped
  })()

  return {
    starts,
    done,
    stop() {
      stopped = true
      for (const s of sources) { try { s.stop() } catch { /* already ended */ } }
      wake()
    },
  }
}

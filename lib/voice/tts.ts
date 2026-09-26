import OpenAI from 'openai'
import { DEFAULT_VOICE, SPEEDS } from './voices'

// Brief 36 — Drift's "mouth". The only module that knows which TTS provider
// speaks: /api/tts and the client just see audio bytes + a mime type, so moving
// to another provider (e.g. ElevenLabs) is a change here, nowhere else.
// gpt-4o-mini-tts beat tts-1 to first audio in the Phase 0 bench (~1.0s vs
// ~1.5–1.9s median) and honors `speed` (instructions-based pacing did not).
const MODEL = 'gpt-4o-mini-tts'

export interface SpeechAudio {
  audio: Buffer<ArrayBuffer>
  mimeType: string
}

export async function synthesize(
  text: string,
  { voice = DEFAULT_VOICE, speed = SPEEDS.normal }: { voice?: string; speed?: number } = {},
): Promise<SpeechAudio> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const speech = await openai.audio.speech.create({
    model: MODEL,
    voice,
    speed,
    input: text.slice(0, 4000), // provider cap
    response_format: 'mp3',
  })
  return { audio: Buffer.from(await speech.arrayBuffer()), mimeType: 'audio/mpeg' }
}

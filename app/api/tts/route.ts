export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

export const maxDuration = 30

// OpenAI TTS pricing: tts-1 at $15 / 1M chars. Typical Drift response ~200
// chars = ~$0.003 per response. Onyx is the deepest male voice OpenAI ships —
// closest to Jarvis in the current lineup. Can swap the voice constant if the
// vibe doesn't land.
const TTS_MODEL = 'tts-1'
const TTS_VOICE = 'onyx'

export async function POST(req: NextRequest) {
  // Gate on the same flag as /api/transcribe — voice mode is one surface.
  if (process.env.NEXT_PUBLIC_VOICE_ENABLED !== 'true') {
    return new NextResponse('Not Found', { status: 404 })
  }
  try {
    const { text } = await req.json()
    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'text required' }, { status: 400 })
    }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const speech = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text.slice(0, 4000), // OpenAI cap
      response_format: 'mp3',
    })
    const buf = Buffer.from(await speech.arrayBuffer())
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('[DealFlow] TTS API error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

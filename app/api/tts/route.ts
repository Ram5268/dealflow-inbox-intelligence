export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { synthesize } from '@/lib/voice/tts'
import { DEFAULT_VOICE, clampSpeed, isVoiceId } from '@/lib/voice/voices'
import { guardTts } from '@/lib/spendGuard'

export const maxDuration = 30

// Brief 36 — all of Drift's speech goes through here. The provider/model live
// in lib/voice/tts.ts; this route only validates and returns audio bytes.
export async function POST(req: NextRequest) {
  // Gate on the same flag as /api/transcribe — voice mode is one surface.
  if (process.env.NEXT_PUBLIC_VOICE_ENABLED !== 'true') {
    return new NextResponse('Not Found', { status: 404 })
  }
  try {
    const { text, voice, speed } = await req.json()
    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'text required' }, { status: 400 })
    }
    // Brief 43 PR 17 [engineering precaution]: no login [Ryan, 2026-09-24], so
    // clips an hour per address and a daily character budget, before OpenAI.
    const spendRefusal = await guardTts(req, text)
    if (spendRefusal) return spendRefusal
    const { audio, mimeType } = await synthesize(text, {
      voice: isVoiceId(voice) ? voice : DEFAULT_VOICE,
      speed: clampSpeed(speed),
    })
    return new NextResponse(audio, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(audio.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('[DealFlow] TTS API error:', err)
    return NextResponse.json({ error: 'Speech failed' }, { status: 500 })
  }
}

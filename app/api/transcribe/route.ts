export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import OpenAI, { toFile } from 'openai'
import { NYC_RE_BIAS_PROMPT } from '@/lib/transcription/prompt'
import {
  guardTranscribe, limit, logSpendRefusal, readBodyCapped, tooLargeResponse, DICTATION_TOO_LARGE_MESSAGE,
} from '@/lib/spendGuard'

export const maxDuration = 30

export async function POST(req: NextRequest) {
  if (process.env.NEXT_PUBLIC_VOICE_ENABLED !== 'true') {
    return new NextResponse('Not Found', { status: 404 })
  }

  // Brief 43 PR 17 [engineering precaution]: no login [Ryan, 2026-09-24], so a
  // body over TRANSCRIBE_MAX_BYTES (default 2 MB) is refused before it's read
  // in full or anything reaches OpenAI.
  const raw = await readBodyCapped(req, limit('TRANSCRIBE_MAX_BYTES'))
  if (raw === null) {
    await logSpendRefusal('transcribe', 'body_too_large')
    return tooLargeResponse(DICTATION_TOO_LARGE_MESSAGE)
  }

  let body: { audio?: { mimeType?: string; content?: string } } | null
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const audio = body?.audio
  if (!audio?.content || !audio?.mimeType) {
    return NextResponse.json({ error: 'Missing audio data' }, { status: 400 })
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(audio.content, 'base64')
  } catch {
    return NextResponse.json({ error: 'Failed to decode audio' }, { status: 400 })
  }
  if (buffer.length === 0) {
    return NextResponse.json({ error: 'Empty audio payload' }, { status: 400 })
  }

  // Brief 43 PR 17: 30 an hour per address and a daily count, before OpenAI.
  const spendRefusal = await guardTranscribe(req)
  if (spendRefusal) return spendRefusal

  const ext = audio.mimeType.includes('mp4') ? 'mp4' : audio.mimeType.includes('webm') ? 'webm' : 'audio'
  const filename = `recording.${ext}`

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const file = await toFile(buffer, filename, { type: audio.mimeType })
    const result = await client.audio.transcriptions.create({
      file,
      model: 'gpt-4o-mini-transcribe',
      language: 'en',
      prompt: NYC_RE_BIAS_PROMPT,
    })
    return NextResponse.json({ transcript: result.text ?? '' })
  } catch (e) {
    console.error('[DealFlow] /api/transcribe error:', e)
    return NextResponse.json({ error: 'Transcription failed' }, { status: 500 })
  }
}

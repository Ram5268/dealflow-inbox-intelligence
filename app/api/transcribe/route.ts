export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import OpenAI, { toFile } from 'openai'
import { NYC_RE_BIAS_PROMPT } from '@/lib/transcription/prompt'

export const maxDuration = 30

export async function POST(req: NextRequest) {
  if (process.env.NEXT_PUBLIC_VOICE_ENABLED !== 'true') {
    return new NextResponse('Not Found', { status: 404 })
  }

  let body: { audio?: { mimeType?: string; content?: string } }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const audio = body.audio
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

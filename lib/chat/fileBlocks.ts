// Brief 43 PR 16 (Q30, Q42; N9, E-03): what the files Ryan attaches become in
// the message Claude reads. A PDF goes as a Claude `document` block, so Drift
// reads it (it used to get a "not yet supported" note). A text, Word or Excel
// file goes as its text, the first 15,000 characters, and now says when it was
// cut. A photo goes as an image block, as before. Pure (the route passes its
// Word/Excel parser in), so it's unit-tested (fileBlocks.unit.test.ts).
import type Anthropic from '@anthropic-ai/sdk'

export interface FileData {
  name: string
  mimeType: string
  type: 'image' | 'text' | 'binary'
  content: string // base64 for image/binary, plain text for text
}

export const FILE_TEXT_LIMIT = 15_000
export const FILE_CUT_NOTE = '(file cut at 15,000 characters)'

// PDFs sent in one message, in base64 characters: Vercel's 4.5 MB request cap
// already holds them under this; the bound keeps it so anywhere else
// [engineering precaution]. Claude takes up to 32 MB and 600 pages.
export const PDF_LIMIT_BASE64_CHARS = 4_500_000

// Brief 43 PR 16 (review r1): Drift's reply when the AI refuses a message with
// a PDF (a locked or damaged file) [engineering precaution].
export const PDF_UNREADABLE_REPLY = "I couldn't read that PDF. It may be locked or damaged. Try another copy, or paste the part you need."

type UserBlock = Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam | Anthropic.Messages.DocumentBlockParam
type ImageMediaType = Anthropic.Messages.Base64ImageSource['media_type']

function fileSection(name: string, text: string): string {
  const cut = text.length > FILE_TEXT_LIMIT ? `\n${FILE_CUT_NOTE}` : ''
  return `\n\n--- File: ${name} ---\n${text.slice(0, FILE_TEXT_LIMIT)}${cut}\n---`
}

// A real PDF starts with "%PDF" ("JVBER" in base64); anything else named .pdf
// would make Claude refuse the whole message, so it goes to the parser instead.
function isPdf(file: FileData): boolean {
  return (file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name)) && file.content.startsWith('JVBER')
}

export async function buildUserBlocks(
  userMessage: string,
  files: readonly FileData[],
  parseBinary: (buffer: Buffer, filename: string, mimeType: string) => Promise<string>,
): Promise<UserBlock[]> {
  const documents: Anthropic.Messages.DocumentBlockParam[] = []
  // Anthropic image source is raw base64 (NOT a data: URL) and requires
  // media_type ∈ {image/jpeg, image/png, image/gif, image/webp}.
  const images: Anthropic.Messages.ImageBlockParam[] = []
  let text = userMessage || '(Please analyze the attached file.)'
  let pdfChars = 0

  for (const file of files) {
    if (file.type === 'image') {
      const mt = file.mimeType as ImageMediaType
      const media_type: ImageMediaType = mt === 'image/jpeg' || mt === 'image/png' || mt === 'image/gif' || mt === 'image/webp' ? mt : 'image/png'
      images.push({ type: 'image', source: { type: 'base64', media_type, data: file.content } })
    } else if (file.type === 'text') {
      text += fileSection(file.name, file.content)
    } else if (file.type === 'binary' && isPdf(file)) {
      if (pdfChars + file.content.length > PDF_LIMIT_BASE64_CHARS) {
        text += `\n\n--- File: ${file.name} ---\n(This PDF is too big to read here.)\n---`
        continue
      }
      pdfChars += file.content.length
      documents.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.content }, title: file.name })
    } else if (file.type === 'binary') {
      const extracted = await parseBinary(Buffer.from(file.content, 'base64'), file.name, file.mimeType)
      text += fileSection(file.name, extracted)
    }
  }

  // Claude reads a document best when it comes before the question.
  return [...documents, { type: 'text', text }, ...images]
}

// Brief 43 PR 16 (review r1): what Drift read in this turn's files, as evidence
// for the fact-check and the regex guard's grounding corpus. Without it a
// correct reply quoting a file ("3,200 square feet", an LLC on the deed) is
// flagged as made up and swapped for a stock reply, after two rewrites that
// each send the PDF again. Text, Word and Excel files: the sections already in
// the user turn. PDFs: their text, pulled locally (pdfText). Bounded
// [engineering precaution]; null when no file was attached.
export const FILE_EVIDENCE_LIMIT = 20_000
export async function fileEvidence(
  blocks: readonly UserBlock[],
  pdfText: (base64: string) => Promise<string>,
): Promise<string | null> {
  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === 'document' && b.source.type === 'base64') {
      const text = await pdfText(b.source.data).catch(() => '')
      if (text.trim()) parts.push(fileSection(b.title ?? 'PDF', text).trim())
    } else if (b.type === 'text') {
      const at = b.text.indexOf('\n\n--- File: ')
      if (at >= 0) parts.push(b.text.slice(at).trim())
    }
  }
  const text = parts.join('\n\n').slice(0, FILE_EVIDENCE_LIMIT)
  return text ? `FILES RYAN ATTACHED THIS TURN (what Drift read in them):\n${text}` : null
}

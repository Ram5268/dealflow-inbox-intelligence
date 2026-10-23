// Brief 43 PR 16 (Q42; E-06): the chat page checks an attachment's size when
// it's picked, before anything is sent. Vercel refuses a request over 4.5 MB
// with its own 413 page before the chat route runs (PR 4 shows that as "That
// file is too big. Try a smaller one."); a file that would hit it is held back
// here with FILE_TOO_BIG_NOTE instead. No imports, so the page can use it; pure,
// so it's unit-tested without a browser (fileSize.unit.test.ts).
export const FILE_TOO_BIG_NOTE = 'That file is too big (limit about 4 MB).'

// A little under Vercel's 4.5 MB request cap, leaving room for the message
// itself [engineering precaution].
export const CHAT_UPLOAD_LIMIT_BYTES = 4_400_000

// Photos are shrunk to 1200 px JPEG in the page before sending (processFile),
// so one stays well under this however big the original is.
const PHOTO_UPLOAD_BYTES = 700_000

export type FileKind = 'image' | 'text' | 'binary'

// How the page sends a file (app/chat/page.tsx processFile): a photo as a
// shrunk JPEG, text as itself, anything else (PDF, Word, Excel) as base64.
export function fileKind(f: { name: string; type: string }): FileKind {
  if (f.type.startsWith('image/')) return 'image'
  if (f.type.startsWith('text/') || /\.(txt|csv|md|json|xml|yaml|yml)$/i.test(f.name)) return 'text'
  return 'binary'
}

// About how many bytes a file adds to the chat request (base64 is 4 bytes for every 3).
export function uploadBytes(f: { name: string; type: string; size: number }): number {
  const kind = fileKind(f)
  if (kind === 'text') return f.size
  const base64 = Math.ceil(f.size / 3) * 4
  return kind === 'image' ? Math.min(base64, PHOTO_UPLOAD_BYTES) : base64
}

export function filesTooBig(files: ReadonlyArray<{ name: string; type: string; size: number }>): boolean {
  return files.reduce((n, f) => n + uploadBytes(f), 0) > CHAT_UPLOAD_LIMIT_BYTES
}

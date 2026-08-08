import { setTimeout as sleep } from 'timers/promises'

// LlamaParse Cloud wrapper — page-aware PDF parsing for OMs, rent rolls,
// availability sheets. Uses the `agentic` tier for table + layout fidelity (the
// legacy `parse_mode=parse_page_with_lvm` premium mode was retired by LlamaParse
// and now 410s; tiers replaced it — Brief 6.1 live smoke test).
// Async API: upload → poll → fetch JSON result. Returns per-page Markdown
// + table/image counts for the chunker.

export interface ParsedPdfPage {
  pageNumber:  number
  markdown:    string
  tableCount:  number
  imageCount:  number
}

export interface ParsedPdf {
  jobId:      string
  pages:      ParsedPdfPage[]
  totalPages: number
}

const LLAMAPARSE_BASE   = 'https://api.cloud.llamaindex.ai/api/v1/parsing'
const POLL_INTERVAL_MS  = 3000
const POLL_TIMEOUT_MS   = 5 * 60 * 1000 // 5 minutes per document

function getApiKey(): string {
  const key = process.env.LLAMAPARSE_API_KEY
  if (!key) throw new Error('LLAMAPARSE_API_KEY must be set in env.')
  return key
}

async function uploadPdf(buffer: Buffer, fileName: string): Promise<string> {
  const apiKey = getApiKey()
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), fileName)
  // LlamaParse v2 requires BOTH a tier and a version. 'latest' tracks the newest
  // parser; pin to a dated version (e.g. '2025-11-18') for reproducibility once
  // the agentic-vs-agentic_plus benchmark on real broker PDFs is done (see
  // KNOWN_ISSUES.md tripwire).
  form.append('tier', 'agentic')
  form.append('version', 'latest')
  form.append('result_type', 'json')

  const res = await fetch(`${LLAMAPARSE_BASE}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    throw new Error(`LlamaParse upload failed (${res.status}): ${await res.text()}`)
  }
  const json = await res.json() as { id?: string }
  if (!json.id) throw new Error(`LlamaParse upload returned no id: ${JSON.stringify(json)}`)
  return json.id
}

async function pollJob(jobId: string): Promise<void> {
  const apiKey = getApiKey()
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    const res = await fetch(`${LLAMAPARSE_BASE}/job/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) throw new Error(`LlamaParse poll failed (${res.status})`)
    const job = await res.json() as { status?: string; error_message?: string }
    if (job.status === 'SUCCESS') return
    if (job.status === 'ERROR' || job.status === 'CANCELLED') {
      throw new Error(`LlamaParse job failed: ${job.status} ${job.error_message ?? ''}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`LlamaParse job ${jobId} timed out after ${POLL_TIMEOUT_MS}ms`)
}

async function fetchJsonResult(jobId: string): Promise<Record<string, unknown>> {
  const apiKey = getApiKey()
  const res = await fetch(`${LLAMAPARSE_BASE}/job/${jobId}/result/json`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`LlamaParse result fetch failed (${res.status})`)
  return res.json() as Promise<Record<string, unknown>>
}

export async function parsePdf(buffer: Buffer, fileName: string): Promise<ParsedPdf> {
  const jobId  = await uploadPdf(buffer, fileName)
  await pollJob(jobId)
  const result = await fetchJsonResult(jobId)

  // Defensive against LlamaParse shape variations. Expected:
  //   { pages: [{ page: N, md: "...", items: [{ type: "table"|"image"|... }] }] }
  const rawPages = (result.pages as Array<Record<string, unknown>> | undefined) ?? []
  const pages: ParsedPdfPage[] = rawPages.map((p, i) => {
    const items = (p.items as Array<Record<string, unknown>> | undefined) ?? []
    const images = (p.images as Array<unknown> | undefined) ?? []
    return {
      pageNumber: (p.page as number | undefined) ?? i + 1,
      markdown:   (p.md   as string | undefined) ?? '',
      tableCount: items.filter(it => it.type === 'table').length,
      imageCount: images.length,
    }
  })

  return { jobId, pages, totalPages: pages.length }
}

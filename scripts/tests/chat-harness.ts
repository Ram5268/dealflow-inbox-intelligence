import 'dotenv/config'
// Integration test #8 — Chat framework
// POSTs prompts to /api/chat on the local dev server. Requires the dev server
// to already be running at http://localhost:3000 (see README below for how the
// runner script starts it). This harness verifies each prompt's ACRIS / DOB /
// FRED / search_listings / search_parties tool routing.
// Run: npx tsx scripts/tests/chat-harness.ts

interface ChatResponse {
  sessionId?: string
  response?: string
  deals?: unknown[]
  suggestions?: string[]
  pendingEvent?: unknown
  error?: string
  // Brief 27.0 — report attachments (server-captured).
  attachedReport?: { reportId?: string; templateId?: string; templateName?: string; subject?: string; sectionCount?: number; matchCount?: number } | null
  attachedFragment?: { templateId?: string; sectionKey?: string; title?: string; content?: unknown } | null
}

const BASE = process.env.CHAT_TEST_BASE_URL ?? 'http://localhost:3000'

async function waitForServer(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE)
      if (res.ok || res.status === 404) return true
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, 1500))
  }
  return false
}

async function ask(sessionId: string | undefined, message: string) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/api/chat`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ message, sessionId }),
  })
  const ms = Date.now() - t0
  const contentType = res.headers.get('content-type') ?? ''
  let body: ChatResponse | { raw: string; status: number }
  if (contentType.includes('json')) body = await res.json() as ChatResponse
  else body = { raw: await res.text(), status: res.status }
  return { status: res.status, ms, body }
}

type Prompt = {
  label: string
  msg: string
  expect: string[]
  expectReport?: boolean     // response must attach a saved full report
  expectFragment?: boolean   // response must attach an inline section fragment (NOT saved)
}

const PROMPTS: Prompt[] = [
  { label: 'ACRIS: owner lookup',      msg: 'who owns 220 Central Park South?',                        expect: ['owner', 'sale', 'acris', 'central park'] },
  { label: 'DOB: permits',             msg: 'any permits at 111 West 57th Street?',                    expect: ['permit', '111'] },
  { label: 'search_listings tool',     msg: 'coming soon 2BR sales in west village under $3M',        expect: ['west village', 'listing', '2'] },
  { label: 'search_parties tool',      msg: 'any buyers looking for 2BR west village under $3M?',     expect: ['buyer', 'iso', 'west village'] },
  { label: 'FRED mortgage rate',       msg: 'what are current mortgage rates?',                        expect: ['rate', '%', 'mortgage'] },
  // Brief 27.0 — report engine. Sonnet resolves the buyer via search_parties, then
  // generates. The Soho 2BR ~$4.5M buyer is a seed [TEST_10] BUYER_ISO with matches.
  { label: 'generate_report full',     msg: 'draft me a buyer match report for the Soho 2BR buyer with a budget around $4.5M', expect: ['report generated', 'buyer match', 'saved as'], expectReport: true },
  { label: 'generate_report_section',  msg: 'now give me just the near-misses for that Soho buyer',    expect: ['near', '$'], expectFragment: true },
]

async function main() {
  console.log('=== Chat framework harness ===')
  console.log(`Base URL: ${BASE}`)
  console.log('Waiting for server up to 60s...')
  const up = await waitForServer(60_000)
  if (!up) {
    console.error('❌ dev server did not come up at ' + BASE)
    process.exit(2)
  }
  console.log('✓ server reachable')

  let sessionId: string | undefined
  const results: Array<{ label: string; status: number; ms: number; pass: boolean; note: string }> = []

  for (const p of PROMPTS) {
    console.log(`\n[${p.label}] ⇒ "${p.msg}"`)
    try {
      const r = await ask(sessionId, p.msg)
      const b = r.body as ChatResponse
      sessionId = sessionId ?? b.sessionId
      const text = (b.response ?? JSON.stringify(b)).toString()
      const short = text.length > 500 ? text.slice(0, 500) + '…' : text
      console.log(`  status=${r.status} ${r.ms}ms`)
      console.log(`  response: ${short}`)
      const matched = p.expect.filter(k => text.toLowerCase().includes(k.toLowerCase()))
      console.log(`  expected substrings matched: ${matched.length}/${p.expect.length} (${matched.join(',')})`)
      if (b.attachedReport) console.log(`  attachedReport: ${JSON.stringify(b.attachedReport)}`)
      if (b.attachedFragment) console.log(`  attachedFragment: ${JSON.stringify({ ...b.attachedFragment, content: '…' })}`)
      if (b.suggestions?.length) console.log(`  suggestions: ${JSON.stringify(b.suggestions)}`)

      // Pass criteria. Report/fragment prompts have hard attachment checks.
      let pass = r.status === 200
      let note = ''
      if (p.expectReport) {
        const ok = !!b.attachedReport?.reportId && matched.length >= 2
        pass = pass && ok
        note = ok ? `report ${b.attachedReport?.reportId}` : 'MISSING attachedReport.reportId or substrings'
      } else if (p.expectFragment) {
        const ok = !!b.attachedFragment?.sectionKey && !b.attachedReport && matched.length >= 1
        pass = pass && ok
        note = ok ? `fragment ${b.attachedFragment?.sectionKey} (not saved)` : 'MISSING attachedFragment or unexpectedly saved a report'
      } else {
        note = `${matched.length}/${p.expect.length} substrings`
      }
      results.push({ label: p.label, status: r.status, ms: r.ms, pass, note })
    } catch (e) {
      console.error('  THREW:', (e as Error).message)
      results.push({ label: p.label, status: -1, ms: 0, pass: false, note: (e as Error).message })
    }
  }

  console.log('\n=== SUMMARY ===')
  let failures = 0
  for (const r of results) {
    if (!r.pass) failures++
    console.log(`  [${r.pass ? '✓' : '✗'}] ${r.label} — ${r.ms}ms — ${r.note}`)
  }
  console.log(`\n${failures === 0 ? '✓ ALL PASS' : `✗ ${failures} FAILED`}`)
  return failures
}

main().then((failures) => process.exit(failures > 0 ? 1 : 0)).catch(e => { console.error(e); process.exit(1) })

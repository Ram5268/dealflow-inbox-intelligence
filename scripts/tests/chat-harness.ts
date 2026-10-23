import 'dotenv/config'
import { refuseLiveDatabase, refuseRemoteServer } from '../../lib/dbGuard'
// Integration test #8 — Chat framework
// POSTs prompts to /api/chat on the local dev server. Requires the dev server
// to already be running at http://localhost:3000 (see README below for how the
// runner script starts it). This harness verifies each prompt's ACRIS / DOB /
// FRED / search_listings / search_parties tool routing.
// Run: npx tsx scripts/tests/chat-harness.ts
//
// Brief 29.0 — added a "real-Ryan" section seeded from actual ChatMessage rows
// (NOT synthetic phrasings; see project_ryan_md_pattern). The /api/chat response
// carries no tool-call telemetry, so tool routing is asserted indirectly via
// response substrings + report/fragment attachments — the same idiom the
// original prompts use. Multi-turn prompts run in their own isolated session so
// ordinal ("the first one") / continuation ("yes do that") references resolve
// against the intended prior turn, not an unrelated earlier prompt.

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

// Brief 41.2 (engineering precaution): the dev server saves the chat rows (and
// a report) to its own database, which can't be checked from here. So it only
// talks to a server on this machine, and refuses unless this checkout's .env
// DATABASE_URL (which a dev server started here also reads, unless .env.local
// overrides it) is a *_perf or *_test database, with no override.
refuseRemoteServer(BASE, 'scripts/tests/chat-harness.ts (CHAT_TEST_BASE_URL)')
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/tests/chat-harness.ts (DATABASE_URL)')

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
  // Single-turn prompts use `msg`; multi-turn use `turns` (run in one fresh
  // session). Checks below apply to the LAST turn's response.
  msg?: string
  turns?: string[]
  expect: string[]
  // Session sharing: prompts with the same sessionKey share one sessionId across
  // the run. Default 'main' preserves the original sequential flow (the report
  // fragment prompt references "that Soho buyer" from the prior report prompt).
  // A unique key gives a prompt its own isolated session.
  sessionKey?: string
  notExpect?: string[]           // final response must NOT contain any of these substrings (case-insensitive)
  expectReport?: boolean         // response must attach a saved full report
  expectFragment?: boolean       // response must attach an inline section fragment (NOT saved)
  expectClarification?: boolean  // if false, the final response must NOT be a bare clarifying question
}

const PROMPTS: Prompt[] = [
  // ── Original tool-routing coverage (shared 'main' session, sequential) ──
  { label: 'ACRIS: owner lookup',      msg: 'who owns 220 Central Park South?',                        expect: ['owner', 'sale', 'acris', 'central park'] },
  { label: 'DOB: permits',             msg: 'any permits at 111 West 57th Street?',                    expect: ['permit', '111'] },
  { label: 'search_listings tool',     msg: 'coming soon 2BR sales in west village under $3M',        expect: ['west village', 'listing', '2'] },
  { label: 'search_parties tool',      msg: 'any buyers looking for 2BR west village under $3M?',     expect: ['buyer', 'iso', 'west village'] },
  { label: 'FRED mortgage rate',       msg: 'what are current mortgage rates?',                        expect: ['rate', '%', 'mortgage'] },
  // Brief 27.0 — report engine. Sonnet resolves the buyer via search_parties, then
  // generates. The Soho 2BR ~$4.5M buyer is a seed [TEST_10] BUYER_ISO with matches.
  { label: 'generate_report full',     msg: 'draft me a buyer match report for the Soho 2BR buyer with a budget around $4.5M', expect: ['report generated', 'buyer match', 'saved as'], expectReport: true },
  { label: 'generate_report_section',  msg: 'now give me just the near-misses for that Soho buyer',    expect: ['near', '$'], expectFragment: true },

  // ── Brief 29.0 — real-Ryan phrasings from the 30-day chat log (isolated sessions) ──
  // Neighborhood shorthand: "WV" must resolve to West Village via RYAN_MD.
  { label: 'real: neighborhood shorthand (WV)', sessionKey: 'r-wv',
    msg: 'show me my WV inventory', expect: ['west village'] },
  // Client-name lookup routes to search_parties; response should echo the name
  // (whether or not a match exists in seed data).
  { label: 'real: client name lookup', sessionKey: 'r-client',
    msg: 'sarah chen — got anything for her?', expect: ['sarah'] },
  // Address-first prompt; response should reference the address.
  { label: 'real: address-first', sessionKey: 'r-addr',
    msg: "what's the sale price on 30 Park Pl PH?", expect: ['30 park'] },
  // Ordinal follow-up over two turns. Brief 30.1 fixed the search_parties beds-recall
  // bug, so turn-1 now returns the SoHo buyer and "the first one" RESOLVES (rather
  // than the Brief 30.0 clarification when the search returned zero). We assert
  // "resolved, not a bare clarification" — robust to Sonnet occasionally answering
  // the section in prose vs the fragment tool. Deterministic fragment-tool routing is
  // covered by the fragment matrix D-category (56/56).
  { label: 'real: ordinal follow-up (multi-turn)', sessionKey: 'r-ordinal',
    turns: ['find buyers looking for a 2BR in Soho', 'give me the near-misses for the first one'],
    expect: [], expectClarification: false },
  // Casual affirmative continuation must EXECUTE, not ask a clarifying question.
  { label: 'real: casual continuation (multi-turn)', sessionKey: 'r-cont',
    turns: ['find sellers in bedstuy', 'yes do that'],
    expect: [], expectClarification: false },

  // ── Brief 30.0 — RYAN.md v2 routing proof (isolated sessions) ──
  // Block A — the 8 previously-failing prompts from the 56-prompt fragment matrix.
  // Question-shape phrasings that Rules A+B (Section 2) should now route to a fragment.
  { label: 'B30/C21 whats out there', sessionKey: 'b30-c21',
    msg: "what's out there for them for buyer cmsp7l5he001qloo89haui4u2", expect: ['matching', 'listings'] },
  // Routing proof is the matching-inventory fragment attachment (RULE B), not the
  // prose — Sonnet often summarizes tiers without echoing "matching"/"inventory".
  { label: 'B30/C22 market look like', sessionKey: 'b30-c22',
    msg: "what's the market look like for buyer cmsp7l5he001qloo89haui4u2", expect: ['listing', 'tier', 'fit', 'match'], expectFragment: true },
  { label: 'B30/C29 pocket listings', sessionKey: 'b30-c29',
    msg: 'any pocket listings for buyer cmsp7l5he001qloo89haui4u2', expect: ['off-market', 'pocket'] },
  { label: 'B30/B9 criteria for buyer looking for', sessionKey: 'b30-b9',
    msg: 'give me the criteria for the buyer looking for 2BR Soho around $4.5M', expect: ['criteria', 'soho'] },
  // Ordinal resolution — Section 3. Turn-1 "find buyers looking for 2BR Soho ~$4.5M"
  // now returns BUYER_A (Brief 30.1 fixed the beds-recall bug that made it return zero
  // during Brief 30.0). Turn-2 resolves "the first one" and answers substantively
  // (fragment or prose) rather than clarifying. We assert "resolved, not a bare
  // clarification" — robust to fragment-vs-prose tool-choice non-determinism; the
  // deterministic fragment-tool routing is covered by the fragment matrix D-category.
  { label: 'B30/D42 first one near-misses', sessionKey: 'b30-d42',
    turns: ['find buyers looking for 2BR Soho around $4.5M', 'give me the near misses for the first one'],
    expect: [], expectClarification: false },
  { label: 'B30/D44 first one budget', sessionKey: 'b30-d44',
    turns: ['find buyers looking for 2BR Soho around $4.5M', 'give me the budget reality for the first one'],
    expect: [], expectClarification: false },
  { label: 'B30/D46 first one curated', sessionKey: 'b30-d46',
    turns: ['find buyers looking for 2BR Soho around $4.5M', 'give me the curated matches for the first one'],
    expect: [], expectClarification: false },
  // Clarification fallback — Section 3 STEP 3: fresh session, no prior turn.
  { label: 'B30/F53 that buyer we were talking about (fresh)', sessionKey: 'b30-f53',
    msg: 'what about that buyer we were talking about', expect: ['which buyer', '?'] },

  // Block B — another report (RYAN_MD Section 6b must respond, not fabricate).
  // Brief 48 PR 19 [Ryan 1.11]: the 20 locked templates are gone. A request for
  // another report gets "DealFlow makes one report, the Buyer Match report";
  // a plain question ("how's the market in tribeca") is answered from the tools.
  { label: 'B30/P01 CMA: one report', sessionKey: 'b30-p01',
    msg: 'run a CMA on 30 Park Place', expect: ['one report', 'buyer match'] },
  { label: 'B30/M01 seller update: one report', sessionKey: 'b30-m01',
    msg: 'seller update for 30 Park Place', expect: ['one report', 'buyer match'] },

  // Block C — non-report workflow patterns (Section 7 + 8).
  { label: 'B30/inbox review recent', sessionKey: 'b30-inbox',
    msg: 'anything hot in the inbox from the last 24 hours', expect: ['listings', 'buyers', 'coming soon'] },
  { label: 'B30/ACRIS prior sale (multi-turn)', sessionKey: 'b30-acris',
    turns: ['pull 30 Park Place', 'who owned it before that'], expect: ['prior', 'acris'] },
  { label: 'B30/compare two properties', sessionKey: 'b30-compare',
    msg: 'stack 30 Park Place against 40 Bond', expect: ['30 park', '40 bond'] },
  // notExpect targets false CLAIMS of sending (there is no send tool), not the bare
  // word "send" — a legitimate draft routinely says things like "ready to send".
  { label: 'B30/draft outreach — no send', sessionKey: 'b30-draft',
    msg: 'draft a follow-up note to the McCoy family about the 3BR Chelsea',
    expect: ['dear', 'mccoy', 'draft'], notExpect: ['has been sent', "i've sent", 'email sent', 'sent it', 'sent the email'] },
  // Deferral vocabulary varies ("coming soon" / "not yet implemented" / "roadmap"); accept any.
  { label: 'B30/farm add — deferred', sessionKey: 'b30-farm',
    msg: 'add 123 5th ave to my farm list', expect: ['coming', 'soon', 'not yet', 'roadmap', 'implemented', 'noted'] },
  { label: 'B30/correction — no I meant (multi-turn)', sessionKey: 'b30-correction',
    turns: ['coming soon in chelsea', 'no I meant soho not chelsea'], expect: ['soho'] },
]

// Heuristic: a bare clarifying question is short and ends with '?'. Good enough
// to catch "Which buyer did you mean?" style non-execution without flaking on
// substantive answers that happen to include a trailing question.
function looksLikeClarification(text: string): boolean {
  const t = text.trim()
  return /\?\s*$/.test(t) && t.length < 160
}

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

  const sessions: Record<string, string | undefined> = {}
  const results: Array<{ label: string; status: number; ms: number; pass: boolean; note: string }> = []

  for (const p of PROMPTS) {
    const turns = p.turns ?? [p.msg as string]
    const sessionKey = p.sessionKey ?? 'main'
    console.log(`\n[${p.label}] (session: ${sessionKey})`)
    try {
      let r!: Awaited<ReturnType<typeof ask>>
      for (const [i, msg] of turns.entries()) {
        console.log(`  turn ${i + 1} ⇒ "${msg}"`)
        r = await ask(sessions[sessionKey], msg)
        const tb = r.body as ChatResponse
        sessions[sessionKey] = sessions[sessionKey] ?? tb.sessionId
      }
      const b = r.body as ChatResponse
      const text = (b.response ?? JSON.stringify(b)).toString()
      const short = text.length > 500 ? text.slice(0, 500) + '…' : text
      console.log(`  status=${r.status} ${r.ms}ms`)
      console.log(`  response: ${short}`)
      const matched = p.expect.filter(k => text.toLowerCase().includes(k.toLowerCase()))
      if (p.expect.length) console.log(`  expected substrings matched: ${matched.length}/${p.expect.length} (${matched.join(',')})`)
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
      } else if (p.expectClarification === false) {
        const clarified = looksLikeClarification(text)
        pass = pass && !clarified
        note = clarified ? 'UNEXPECTED clarifying question (should have executed)' : 'executed (no bare clarification)'
      } else if (p.expectClarification === true) {
        // Section 3 STEP 3 — when the referent can't be resolved, v2 must NOT
        // fabricate a fragment/report; it clarifies. Assert no fabrication.
        const ok = !b.attachedFragment && !b.attachedReport
        pass = pass && ok
        note = ok ? 'clarified (no fabricated fragment/report)' : 'FABRICATED a fragment/report instead of clarifying'
      } else {
        const ok = p.expect.length === 0 || matched.length >= 1
        pass = pass && ok
        note = `${matched.length}/${p.expect.length} substrings`
      }
      // Brief 30.0 — universal negative gate (e.g. a draft must never mention "send"/"sent").
      if (p.notExpect?.length) {
        const violated = p.notExpect.filter(k => text.toLowerCase().includes(k.toLowerCase()))
        if (violated.length) {
          pass = false
          note += ` | FORBIDDEN substrings present: ${violated.join(',')}`
        }
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

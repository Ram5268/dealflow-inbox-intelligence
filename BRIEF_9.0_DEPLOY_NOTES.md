# Brief 9.0 — Prod Deploy Notes (Vercel + PWA + smokes)

Branch: `brief-9.0-prod-deploy` · executor pre-flight complete, holding for Ryan's manual steps then Phase 3 smokes.

---

## 1. Code changes made this session (committed on branch)

| Change | File | Why |
|---|---|---|
| PWA icons generated (192/512/180) | `public/icon-192.png`, `icon-512.png`, `icon-180.png` | Manifest + `sw.js` referenced them but they didn't exist — PWA install + push icon would 404. |
| Complete `.env.example` | `.env.example` | Was 3 keys; rebuilt from a full `process.env.*` grep. Doubles as the Vercel env checklist (§4). |
| Prisma `binaryTargets` added | `prisma/schema.prisma` | Per brief. NOTE: project uses the **pg driver adapter** (`lib/prisma.ts`), so Prisma 7 runs queries through the JS `pg` driver, not the native Rust engine — the "engine not found" failure mode doesn't apply here. Added as harmless insurance; `prisma generate` verified clean. |
| Secured GET entrypoint on sync tick | `app/api/sync/run/route.ts` | Route was POST-only + unauthenticated. Added a `GET` handler gated by `CRON_SECRET` (Bearer header only since Brief 41; `?secret=` is no longer accepted), mirroring `/api/push/digest`. QStash/Vercel cron use GET. Existing client-triggered POST left open (same-origin app-load call). |

Typecheck: `npx tsc --noEmit` → **0 errors**.

### Brief-vs-code discrepancies found (resolved)
- Brief's cron path `/api/sync?secret=...` **does not exist**. Real sync tick is `POST/GET /api/sync/run`. All smoke steps below use the correct path.
- **Graph token is DB-backed, not env.** OAuth callback/device-code store the live token in `connectedMailbox` id `runtime-token`; `getToken()` reads DB first. So the manual ~1hr re-auth works fine on Vercel (shared Railway DB). `MICROSOFT_GRAPH_ACCESS_TOKEN` env is only a dormant fallback — **do not set it in Vercel**.
- **Calendar smoke scope is covered.** Settings "Connect Outlook" uses the **device-code flow**, which requests `Calendars.ReadWrite` (as does the authorize-redirect flow). No scope change needed.

### Cron decision (per Ryan): **Upstash QStash (free)**
Vercel Hobby is confirmed **daily-only** (every-10-min cron fails deployment). So:
- `vercel.json` keeps ONLY the daily digest cron (`/api/push/digest` @ `0 12 * * *`) — Hobby-compatible, unchanged.
- The 10-min sync tick runs on QStash (free) hitting the new secured GET. Setup in §5.

---

## 2. Ryan-required actions, in order (batched to minimize context-switching)

**Batch A — Vercel bring-up**
1. Create/confirm Vercel account.
2. New Project → Import `Ram5268/dealflow-inbox-intelligence` (auto-detects Next.js, root `./`, default build). Note the assigned URL → this is `<vercel-url>`.
3. Set env vars for **Production + Preview** (checklist §4). Deploy.

**Batch B — Azure creds (NO portal changes needed)**
4. ~~Add redirect URI in Azure Portal~~ — **NOT required.** Settings → Connect Outlook uses the **device-code flow** (`app/api/microsoft/device-code`), which needs no redirect URI and no portal edit. Just source the cred *values* for Vercel: `AZURE_CLIENT_ID` + `AZURE_TENANT` (required), `AZURE_CLIENT_SECRET` (optional — only the Elliman-blocked refresh path uses it). Check local `.env` first; if truly missing, ping executor before deploying.

**Batch C — external wiring**
5. Upstash QStash schedule (§5) — the 10-min sync tick.
6. Zapier: point the Mojo webhook POST at `https://<vercel-url>/api/mojo/webhook`, keep the `x-mojo-webhook-secret` header. Fire a test.

**Batch D — phone**
7. Safari on iPhone → open `https://<vercel-url>/` → Share → Add to Home Screen. Open from home screen (standalone).
8. In the installed PWA → grant push permission.

**Batch E — smokes (Phase 3) — HELD pending Outlook restore**
9. (When Outlook access is back) Open the deployed app → Settings → Connect Outlook (device-code) → authenticate. Then tell the executor "go".

---

## 3. Blockers to watch
- **Outlook access (Ryan locked out).** Phase 3 Graph smokes + Connect Outlook are HELD until access is restored. Everything else (Vercel deploy, QStash, Zapier ingest, PWA install/push) is Outlook-independent and proceeds now.
- ~~Azure tenant / portal access~~ — no longer a blocker: device-code flow needs no portal changes (Correction 1).
- **Source the `AZURE_*` cred values.** `AZURE_CLIENT_ID` + `AZURE_TENANT` must be set in Vercel for Connect Outlook to work later. Check local `.env` first; if missing, resolve before deploying the auth-dependent path (but the rest of the deploy can proceed).

---

## 4. Vercel env-var checklist (Production + Preview)

**Required — must set:**
| Key | Source / value |
|---|---|
| `DATABASE_URL` | Railway **POOLED (PgBouncer)** URL + `?pgbouncer=true&connect_timeout=15`. Get pooled string from Railway dashboard — NOT the direct URL. |
| `ANTHROPIC_API_KEY` | copy from local `.env` |
| `OPENAI_API_KEY` | copy from local `.env` |
| `AI_PROVIDER` | `openai` |
| `AZURE_CLIENT_ID` | Azure app registration — **required** for device-code Connect Outlook (check local `.env`) |
| `AZURE_TENANT` | Azure app registration (Elliman tenant id) — **required** |
| `AZURE_CLIENT_SECRET` | Optional — only the Elliman-blocked refresh path uses it; set if you have it |
| `VAPID_PUBLIC_KEY` | **new pair** (executor generated — see chat) |
| `VAPID_PRIVATE_KEY` | **new pair** (executor generated — see chat) |
| `VAPID_EMAIL` | copy from local `.env` (mailto: address) |
| `MOJO_WEBHOOK_SECRET` | must MATCH the Zapier `x-mojo-webhook-secret` header (NOT in local `.env` — set/confirm both sides) |
| `CRON_SECRET` | copy from local `.env` (reuse). Also used by QStash header. |
| `BASE_URL` | `https://<vercel-url>` |

**Prod overrides (flip OFF vs local guardrails):**
| Key | Prod value |
|---|---|
| `TEST_MODE_ONLY` | `false` |
| `INGESTION_TEST_MODE_ONLY` | `false` |
| `MATCHING_TEST_MODE_ONLY` | `false` |

**Optional (copy from local `.env` if present; features degrade if unset):**
`GOOGLE_MAPS_API_KEY`, `NYC_SOCRATA_KEY_ID`, `NYC_SOCRATA_KEY_SECRET`, `RAPIDAPI_KEY`, `JINA_API_KEY`, `LLAMAPARSE_API_KEY`, `BRIGHTDATA_API_KEY`, `BRIGHTDATA_ZONE`, `STREETEASY_SYNC_ENABLED`, `INGEST_V2`, `NEXT_PUBLIC_VOICE_ENABLED`.

**Not needed in Vercel:** `AZURE_REDIRECT_URI` (device-code flow uses none; only the dormant redirect flow references it), `MICROSOFT_GRAPH_ACCESS_TOKEN` (DB-backed), `SHADOW_DATABASE_URL` (migrate-only), `NODE_ENV` (auto), `CONFIRM_WIPE` (destructive).

---

## 5. Upstash QStash setup (10-min sync tick)
1. Create free Upstash account → QStash.
2. Create Schedule:
   - Destination (GET): `https://<vercel-url>/api/sync/run`
   - Header: `Authorization: Bearer <CRON_SECRET>`  (same value as the Vercel env var)
   - Schedule (cron): `*/10 * * * *`
3. Save. Verify a `BACKGROUND_SYNC` AuditLog row appears within ~10 min (requires a fresh Graph token to do real work; no-ops harmlessly when the token is stale).

Free tier = 500 msgs/day; every 10 min = 144/day. Comfortable.

---

## 6. Phase 3 smoke plan (corrected paths — HELD until Outlook access restored)
> Carried to a follow-up: chat calendar smoke + `graphToken.status==='fresh'` require Graph auth. Merge on the Outlook-independent gate items now; these merge when they pass later. Ryan pings "Outlook is back, ready for smokes".
Handoff line to Ryan: *"Ready for deferred smokes. Refresh the Outlook token via the deployed app → Settings → Connect Outlook, then reply 'go'. ~20-30 min, within the token window."*

On "go":
1. **Token freshness** — `GET <vercel-url>/api/microsoft/token-status` → fresh? else pause.
2. **Health** — `GET <vercel-url>/api/debug/health` → `graphToken.status==='fresh'`, all three flags `false`, `subsystemLastSuccess.matcher` recent.
3. **Chat calendar smoke** — `POST <vercel-url>/api/chat` "Schedule a showing for 123 Main St at 3pm tomorrow" → note `pendingEvent`; POST "confirm" → verify event on real calendar; check `AuditLog` `CALENDAR_WRITE` `source:'chat-confirm'`; then `DELETE /me/events/{id}` via Graph (own probe event — deletion allowed).
4. **Zapier smoke** — fire test POST to `/api/mojo/webhook` (SE Buyers shape) → verify `ZapierIngestLog resultStatus='upserted'`, `MojoContact intent='BUYER'`, notes-parsed criteria, geocoded neighborhood, embedding. Trigger sync (`GET /api/sync/run` with `-H "Authorization: Bearer <CRON_SECRET>"`, or wait for QStash tick) → verify BUYER matched against inbox listings, `Match` rows `counterpartType='mojo'`, `/matches/parties` renders.
5. **Push smoke** — trigger test push → Ryan confirms on phone; `PushSubscription` row for new origin exists.

Cleanup: delete smoke calendar event; note/keep-or-delete the test Mojo contact.

---

## 7. Not gating this brief (log to BUGS.md ITERATE if hit)
- `/api/sync/run` POST remains open (unauthenticated) for the client app-load trigger. Low risk (read-only Graph + matching, needs a valid token to act). Securing it would require threading a token through the client — out of scope for deploy.
- Custom domain, Sentry/monitoring, edge caching — separate briefs.

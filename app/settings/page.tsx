'use client'

import { useState, useEffect } from 'react'
import TopNav from '@/components/TopNav'

interface ConnectionResult {
  ok: boolean; displayName?: string; mail?: string; error?: string
}
interface PreviewResult {
  ok: boolean
  messages?: Array<{ id: string; subject: string; from: { name?: string }; receivedDateTime: string }>
  error?: string
}
interface TokenStatus {
  status: 'ok' | 'expiring' | 'expired' | 'unknown'
  expiresAt: string | null
  minutesLeft: number | null
}


function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="df-card" style={{ padding: '20px', marginBottom: 12 }}>
      <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 14 }}>{title}</p>
      {children}
    </div>
  )
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
      <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.8)' }}>{label}</span>
      <button
        onClick={() => onChange(!on)}
        aria-pressed={on}
        style={{
          width: 44, height: 26, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 2,
          background: on ? 'var(--sr-cream, #f5e9d4)' : 'rgba(255,255,255,0.15)',
          transition: 'background 160ms', display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start',
        }}
      >
        <span style={{ width: 22, height: 22, borderRadius: '50%', background: on ? '#0a1f2a' : '#fff', transition: 'all 160ms' }} />
      </button>
    </div>
  )
}

function Btn({ onClick, disabled, children, variant = 'primary' }: { onClick?: () => void; disabled?: boolean; children: React.ReactNode; variant?: 'primary' | 'ghost' }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={variant === 'primary' ? 'df-btn' : 'df-btn-ghost'}
      style={{ width: '100%', padding: '13px', fontSize: 14, fontWeight: 600 }}>
      {children}
    </button>
  )
}

export default function SettingsPage() {
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null)
  const [testLoading, setTestLoading] = useState(false)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [token, setToken] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenResult, setTokenResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null)
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null)
  const [deviceCode, setDeviceCode] = useState<{ userCode: string; verificationUri: string; message: string } | null>(null)
  const [devicePolling, setDevicePolling] = useState(false)
  const [mojoCount, setMojoCount] = useState<number | null>(null)
  const [mojoLastSync, setMojoLastSync] = useState<string | null>(null)
  const [mojoImporting, setMojoImporting] = useState(false)
  const [mojoImportResult, setMojoImportResult] = useState<{ ok: boolean; upserted?: number; error?: string } | null>(null)
  const [mojoWebhookUrl, setMojoWebhookUrl] = useState<string>('/api/mojo/webhook')
  // Brief 7.4 — notification preferences
  const [notif, setNotif] = useState<{ digestEnabled: boolean; realtimeEnabled: boolean; digestTime: string } | null>(null)
  const [notifSaving, setNotifSaving] = useState(false)
  const [testResult2, setTestResult2] = useState<string | null>(null)

  async function saveNotif(patch: Partial<{ digestEnabled: boolean; realtimeEnabled: boolean; digestTime: string }>) {
    if (!notif) return
    const next = { ...notif, ...patch }
    setNotif(next)
    setNotifSaving(true)
    try {
      await fetch('/api/notifications/preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      })
    } finally { setNotifSaving(false) }
  }

  async function sendTestPush() {
    setTestResult2('Sending…')
    try {
      const r = await fetch('/api/push/test', { method: 'POST' })
      const j = await r.json()
      setTestResult2(j.ok ? `✅ Delivered to ${j.delivered} device${j.delivered === 1 ? '' : 's'}` : `⚠️ ${j.error}`)
    } catch {
      setTestResult2('⚠️ Test failed')
    }
  }

  useEffect(() => {
    fetch('/api/notifications/preferences').then(r => r.json()).then(setNotif).catch(() => {})
    fetch('/api/microsoft/token-status').then(r => r.json()).then(setTokenStatus).catch(() => {})
    fetch('/api/mojo/status').then(r => r.json()).then((d: { count: number; lastSync: string | null }) => {
      setMojoCount(d.count ?? 0)
      setMojoLastSync(d.lastSync)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setMojoWebhookUrl(`${window.location.origin}/api/mojo/webhook`)
    }
  }, [])

  async function testConn() {
    setTestLoading(true); setTestResult(null)
    const r = await fetch('/api/microsoft/test')
    setTestResult(await r.json())
    setTestLoading(false)
  }

  async function previewMsgs() {
    setPreviewLoading(true); setPreview(null)
    const r = await fetch('/api/microsoft/messages-preview')
    setPreview(await r.json())
    setPreviewLoading(false)
  }

  async function saveToken() {
    if (!token.trim()) return
    setTokenSaving(true)
    const r = await fetch('/api/microsoft/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.trim(), refreshToken: refreshToken.trim() }),
    })
    const result = await r.json()
    setTokenResult(result)
    if (result.ok) {
      setToken('')
      setRefreshToken('')
      fetch('/api/microsoft/token-status').then(r => r.json()).then(setTokenStatus).catch(() => {})
    }
    setTokenSaving(false)
  }

  async function startDeviceFlow() {
    setDevicePolling(true)
    setDeviceCode(null)
    try {
      const r = await fetch('/api/microsoft/device-code', { method: 'POST' })
      const data = await r.json()
      if (data.userCode) {
        setDeviceCode(data)
        // Poll for completion
        const poll = setInterval(async () => {
          const pr = await fetch('/api/microsoft/device-code/poll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceCode: data.deviceCode }),
          })
          const pd = await pr.json()
          if (pd.ok) {
            clearInterval(poll)
            setDeviceCode(null)
            setDevicePolling(false)
            setTokenResult({ ok: true, message: 'Connected! Token auto-refreshes every hour.' })
            fetch('/api/microsoft/token-status').then(r => r.json()).then(setTokenStatus).catch(() => {})
          } else if (pd.error === 'expired') {
            clearInterval(poll)
            setDevicePolling(false)
            setDeviceCode(null)
          }
        }, 5000)
      }
    } catch {
      setDevicePolling(false)
    }
  }

  const statusColor = tokenStatus?.status === 'ok' ? 'rgba(150,255,180,0.85)'
    : tokenStatus?.status === 'expiring' ? 'rgba(255,210,100,0.9)'
    : tokenStatus?.status === 'expired' ? 'rgba(255,130,130,0.9)'
    : 'rgba(255,255,255,0.35)'

  const statusLabel = tokenStatus?.status === 'ok'
    ? `Active — expires in ${tokenStatus.minutesLeft} min`
    : tokenStatus?.status === 'expiring'
    ? `Expiring soon — ${tokenStatus.minutesLeft} min left`
    : tokenStatus?.status === 'expired'
    ? 'Expired — refresh needed'
    : 'Unknown — paste a token to check'

  return (
    <div className="df-bg min-h-screen" style={{ minHeight: '100dvh' }}>
      <TopNav />

      <div style={{ padding: '4px 16px 48px' }}>

        {/* Token status pill */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', marginBottom: 12,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: statusColor }}>{statusLabel}</span>
        </div>


        {/* Brief 7.4 — Notifications */}
        <Section title="Notifications">
          {notif ? (
            <>
              <Toggle label="Morning digest" on={notif.digestEnabled} onChange={v => saveNotif({ digestEnabled: v })} />
              <Toggle label="Realtime HOT alerts" on={notif.realtimeEnabled} onChange={v => saveNotif({ realtimeEnabled: v })} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.8)' }}>Digest time</span>
                <input
                  type="time"
                  value={notif.digestTime}
                  onChange={e => saveNotif({ digestTime: e.target.value })}
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '6px 10px', color: '#fff', fontSize: 13, colorScheme: 'dark' }}
                />
              </div>
              <div style={{ marginTop: 10 }}>
                <Btn onClick={sendTestPush} variant="ghost">Send Test Push</Btn>
                {testResult2 && <p style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{testResult2}</p>}
              </div>
              <p style={{ marginTop: 10, fontSize: 11, color: 'rgba(255,255,255,0.25)', lineHeight: 1.5 }}>
                Digest currently runs daily at 8:00 AM ET. {notifSaving ? 'Saving…' : ''}
              </p>
            </>
          ) : (
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>Loading…</p>
          )}
        </Section>

        {/* Test */}
        <Section title="Connection Status">
          <Btn onClick={testConn} disabled={testLoading} variant="ghost">
            {testLoading ? 'Testing...' : 'Test Connection'}
          </Btn>
          {testResult && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: testResult.ok ? 'rgba(100,200,150,0.08)' : 'rgba(220,80,80,0.08)', border: `1px solid ${testResult.ok ? 'rgba(100,200,150,0.2)' : 'rgba(220,80,80,0.2)'}`, borderRadius: 10, fontSize: 13 }}>
              {testResult.ok ? (
                <div style={{ color: 'rgba(200,255,220,0.9)' }}>
                  <div style={{ fontWeight: 600 }}>✅ Connected</div>
                  <div style={{ color: 'rgba(200,255,220,0.65)', marginTop: 2 }}>{testResult.displayName} · {testResult.mail}</div>
                </div>
              ) : (
                <div style={{ color: 'rgba(255,180,180,0.9)' }}>❌ {testResult.error}</div>
              )}
            </div>
          )}
        </Section>

        {/* Preview */}
        <Section title="Email Preview">
          <Btn onClick={previewMsgs} disabled={previewLoading} variant="ghost">
            {previewLoading ? 'Loading...' : 'Preview Latest 5 Emails'}
          </Btn>
          {preview?.ok && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {preview.messages?.map(m => (
                <div key={m.id} style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 10 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject}</p>
                  <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>{m.from?.name} · {new Date(m.receivedDateTime).toLocaleDateString()}</p>
                </div>
              ))}
            </div>
          )}
          {preview && !preview.ok && (
            <p style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,150,150,0.8)' }}>{preview.error}</p>
          )}
        </Section>

        {/* Device code flow — preferred method */}
        <Section title="Auto-Connect (Recommended)">
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginBottom: 12, lineHeight: 1.5 }}>
            One-time sign-in that stores a refresh token. After this, the app auto-renews access without you needing to paste tokens.
          </p>
          {!deviceCode ? (
            <Btn onClick={startDeviceFlow} disabled={devicePolling} variant="ghost">
              {devicePolling ? 'Starting...' : 'Start Device Sign-In'}
            </Btn>
          ) : (
            <div style={{ padding: '12px 14px', background: 'rgba(255,255,255,0.05)', borderRadius: 10 }}>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>1. Go to <span style={{ color: 'rgba(150,220,255,0.9)', fontFamily: 'monospace' }}>{deviceCode.verificationUri}</span></p>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>2. Enter code: <span style={{ fontFamily: 'monospace', fontSize: 18, color: '#fff', letterSpacing: 4 }}>{deviceCode.userCode}</span></p>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>Waiting for sign-in…</p>
            </div>
          )}
        </Section>

        {/* Manual token fallback */}
        <Section title="Manual Token (Fallback)">
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginBottom: 12, lineHeight: 1.5 }}>
            Paste access token from Graph Explorer. Optionally add a refresh token to enable auto-renewal.
          </p>
          <textarea value={token} onChange={e => setToken(e.target.value)}
            placeholder="Access token..." rows={2}
            style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '10px 12px', fontSize: 12, color: 'rgba(255,255,255,0.8)', outline: 'none', resize: 'none', fontFamily: 'monospace', marginBottom: 8 }}
          />
          <textarea value={refreshToken} onChange={e => setRefreshToken(e.target.value)}
            placeholder="Refresh token (optional — enables auto-renewal)..." rows={2}
            style={{ width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '10px 12px', fontSize: 12, color: 'rgba(255,255,255,0.8)', outline: 'none', resize: 'none', fontFamily: 'monospace', marginBottom: 10 }}
          />
          <Btn onClick={saveToken} disabled={tokenSaving || !token.trim()} variant="ghost">
            {tokenSaving ? 'Saving...' : 'Save Token'}
          </Btn>
          {tokenResult && (
            <p style={{ marginTop: 8, fontSize: 12, color: tokenResult.ok ? 'rgba(150,255,180,0.8)' : 'rgba(255,150,150,0.8)' }}>
              {tokenResult.ok ? `✅ ${tokenResult.message}` : `❌ ${tokenResult.error}`}
            </p>
          )}
        </Section>

        {/* Mojo CRM */}
        <Section title="Mojo Seller Leads">
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginBottom: 12, lineHeight: 1.5 }}>
            Import your NYC Leads contacts from Mojo. Export as CSV from Mojo → Groups → NYC Leads → Export, then upload here.
          </p>
          {mojoCount !== null && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 10, fontSize: 12, color: 'rgba(255,255,255,0.55)', display: 'flex', justifyContent: 'space-between' }}>
              <span>{mojoCount.toLocaleString()} contacts synced</span>
              {mojoLastSync && <span>{new Date(mojoLastSync).toLocaleDateString()}</span>}
            </div>
          )}
          <label style={{ display: 'block', cursor: 'pointer' }}>
            <input type="file" accept=".csv" style={{ display: 'none' }} onChange={async e => {
              const file = e.target.files?.[0]
              if (!file) return
              setMojoImporting(true); setMojoImportResult(null)
              const text = await file.text()
              const r = await fetch('/api/mojo/import', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text })
              const result = await r.json()
              setMojoImportResult(result)
              if (result.ok) {
                fetch('/api/mojo/status').then(r => r.json()).then((d: { count: number; lastSync: string | null }) => {
                  setMojoCount(d.count); setMojoLastSync(d.lastSync)
                }).catch(() => {})
              }
              setMojoImporting(false)
            }} />
            <div className="df-btn-ghost" style={{ width: '100%', padding: '13px', fontSize: 14, fontWeight: 600, textAlign: 'center', cursor: 'pointer' }}>
              {mojoImporting ? 'Importing...' : 'Upload Mojo CSV'}
            </div>
          </label>
          {mojoImportResult && (
            <p style={{ marginTop: 8, fontSize: 12, color: mojoImportResult.ok ? 'rgba(150,255,180,0.8)' : 'rgba(255,150,150,0.8)' }}>
              {mojoImportResult.ok ? `✅ ${mojoImportResult.upserted} contacts imported` : `❌ ${mojoImportResult.error}`}
            </p>
          )}
          <p style={{ marginTop: 10, fontSize: 11, color: 'rgba(255,255,255,0.2)', lineHeight: 1.5 }}>
            For real-time sync: set up API Nation → Mojo → Webhook to {mojoWebhookUrl}
          </p>
        </Section>

        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', textAlign: 'center', paddingTop: 8 }}>
          🔒 Read-only · No emails are sent, deleted, or modified
        </p>
      </div>
    </div>
  )
}

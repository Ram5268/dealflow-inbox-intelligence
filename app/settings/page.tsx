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
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenResult, setTokenResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null)
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null)

  useEffect(() => {
    fetch('/api/microsoft/token-status').then(r => r.json()).then(setTokenStatus).catch(() => {})
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
    const r = await fetch('/api/microsoft/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token.trim() }) })
    const result = await r.json()
    setTokenResult(result)
    if (result.ok) {
      setToken('')
      fetch('/api/microsoft/token-status').then(r => r.json()).then(setTokenStatus).catch(() => {})
    }
    setTokenSaving(false)
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

        {/* Manual token fallback */}
        <Section title="Manual Token (Fallback)">
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', marginBottom: 12, lineHeight: 1.5 }}>
            Paste directly from Graph Explorer if the bookmarklet isn't working.
          </p>
          <textarea value={token} onChange={e => setToken(e.target.value)}
            placeholder="Paste token here..." rows={2}
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

        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', textAlign: 'center', paddingTop: 8 }}>
          🔒 Read-only · No emails are sent, deleted, or modified
        </p>
      </div>
    </div>
  )
}

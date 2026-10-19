'use client'

import { useEffect, useState } from 'react'
import { deviceRows, devicesNote, endpointFingerprint, type DeviceRow, type PushDevice } from '@/lib/push/devices'

// Brief 48 (PR 5): Settings' list of the devices that get notifications, each with
// "Remove" [planner, Brief 48 §3 PR 5]. The server never sends a device's push
// address. "This device" is the row whose fingerprint matches this browser's own
// sign-up, hashed here; with no sign-up or no push support, no row is marked.
// Removing this browser also cancels its sign-up, so Check In on the Home page can
// turn it back on. The wording and the marking are in lib/push/devices.ts (tested).

// This browser's push sign-up, if it has one. Never signs anything up.
async function browserSubscription(): Promise<PushSubscription | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return reg ? reg.pushManager.getSubscription() : null
}

async function fetchDevices(): Promise<PushDevice[]> {
  const r = await fetch('/api/push/subscribe', { cache: 'no-store' })
  if (!r.ok) throw new Error(`devices ${r.status}`)
  const j = await r.json() as { devices?: PushDevice[] }
  return Array.isArray(j.devices) ? j.devices : []
}

const LOAD_PROBLEM = "Couldn't load your devices."
const note = { fontSize: 12, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 } as const

export default function PushDevices() {
  const [devices, setDevices] = useState<PushDevice[] | null>(null)
  const [thisFingerprint, setThisFingerprint] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    fetchDevices().then(setDevices).catch(() => setProblem(LOAD_PROBLEM))
    browserSubscription()
      .then(sub => (sub ? endpointFingerprint(sub.endpoint) : null))
      .then(setThisFingerprint)
      .catch(() => {})
  }, [])

  async function remove(row: DeviceRow) {
    setRemovingId(row.id)
    setProblem(null)
    try {
      const r = await fetch('/api/push/subscribe', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id }),
      })
      const j = await r.json().catch(() => null) as { ok?: boolean } | null
      if (!r.ok || !j?.ok) throw new Error(`remove ${r.status}`)
    } catch {
      setProblem("Couldn't remove that device. Try again.")
      setRemovingId(null)
      return
    }
    if (row.isThisDevice) {
      await browserSubscription().then(sub => sub?.unsubscribe()).catch(() => {})
      setThisFingerprint(null)
    }
    await fetchDevices().then(setDevices).catch(() => setProblem(LOAD_PROBLEM))
    setRemovingId(null)
  }

  if (devices === null) return <p style={note}>{problem ?? 'Loading…'}</p>

  const rows = deviceRows(devices, thisFingerprint)
  return (
    <>
      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          {rows.map(row => (
            <div key={row.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 10 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.85)' }}>
                  {row.label}
                  {row.isThisDevice && (
                    <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 999, fontSize: 11, background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.75)', whiteSpace: 'nowrap' }}>
                      This device
                    </span>
                  )}
                </p>
                {row.added && <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>{row.added}</p>}
              </div>
              <button
                type="button"
                className="df-btn-ghost"
                onClick={() => remove(row)}
                disabled={removingId !== null}
                aria-label={`Remove ${row.label}${row.isThisDevice ? ', this device' : ''}`}
                style={{ padding: '7px 14px', fontSize: 13, fontWeight: 600, flexShrink: 0 }}
              >
                {removingId === row.id ? 'Removing…' : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}
      <p style={note}>{devicesNote(rows.length)}</p>
      {problem && <p style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,150,150,0.8)' }}>{problem}</p>}
    </>
  )
}

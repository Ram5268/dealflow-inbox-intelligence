import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crmLeadUrl } from '../crmLink'

// Brief 35: "Open in CRM →" for contact supply; no link when crmLeadId is missing.

test('links to the CRM lead page', () => {
  delete process.env.NEXT_PUBLIC_CRM_BASE_URL
  assert.equal(crmLeadUrl({ source: 'crm', crmLeadId: 'lead_1' }), 'https://dealflow-crm-rho.vercel.app/leads/lead_1')
})

test('NEXT_PUBLIC_CRM_BASE_URL overrides the base', () => {
  process.env.NEXT_PUBLIC_CRM_BASE_URL = 'https://crm.example.com/'
  assert.equal(crmLeadUrl({ crmLeadId: 'abc' }), 'https://crm.example.com/leads/abc')
  delete process.env.NEXT_PUBLIC_CRM_BASE_URL
})

test('no crmLeadId → no link', () => {
  for (const m of [null, undefined, {}, { source: 'legacy' }, { crmLeadId: '' }, { crmLeadId: 42 }]) assert.equal(crmLeadUrl(m), null)
})

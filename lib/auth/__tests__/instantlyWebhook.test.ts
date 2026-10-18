import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkInstantlyWebhookToken } from '../instantlyWebhook'

// Brief 41.2 (PR C): the Instantly webhook's token check. Engineering
// precaution from the Oct 16, 2026 system-map review. The route checks the
// INSTANTLY_ENROLL_ENABLED switch before this (see the route's own tests).

test('503 when no secret is set: unset, empty or blank', () => {
  for (const secret of [undefined, '', ' ', '\t\n']) {
    for (const h of [null, '', 'Bearer ', 'Bearer undefined', `Bearer ${secret ?? ''}`]) {
      assert.equal(checkInstantlyWebhookToken(h, secret), 503, `${JSON.stringify(secret)} ${JSON.stringify(h)}`)
    }
  }
})

test('401 on a missing, wrong or malformed token', () => {
  for (const h of [null, '', 'Bearer', 'Bearer ', 'Bearer wrong', 'Bearer s3cret-value!', 'Bearer s3cret-valu',
    's3cret-value', 'bearer s3cret-value', 'Bearer  s3cret-value', ' Bearer s3cret-value', 'Bearer s3cret-value ',
    'Basic s3cret-value', 'Bearer undefined', 'Bearer null', 'Bearer s3cret-value\n']) {
    assert.equal(checkInstantlyWebhookToken(h, 's3cret-value'), 401, JSON.stringify(h))
  }
})

test('tokens of any length are compared without throwing', () => {
  for (const h of ['B', 'Bearer x'.repeat(500), 'Bearer s3cret-value'.padEnd(4096, '!')]) {
    assert.doesNotThrow(() => checkInstantlyWebhookToken(h, 's3cret-value'))
    assert.equal(checkInstantlyWebhookToken(h, 's3cret-value'), 401)
  }
})

test('200 on the exact Bearer token', () => {
  assert.equal(checkInstantlyWebhookToken('Bearer s3cret-value', 's3cret-value'), 200)
  assert.equal(checkInstantlyWebhookToken('Bearer ü-ñ-秘密', 'ü-ñ-秘密'), 200)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkCronBearer } from '../cronBearer'

test('fails closed when CRON_SECRET is unset', () => {
  assert.equal(checkCronBearer('Bearer anything', undefined), 500)
  assert.equal(checkCronBearer(null, ''), 500)
})

test('401 on a missing, wrong, or non-Bearer token', () => {
  assert.equal(checkCronBearer(null, 's3cret'), 401)
  assert.equal(checkCronBearer('Bearer wrong!', 's3cret'), 401)
  assert.equal(checkCronBearer('s3cret', 's3cret'), 401)
  assert.equal(checkCronBearer('bearer s3cret', 's3cret'), 401)
})

test('200 on the exact Bearer token', () => {
  assert.equal(checkCronBearer('Bearer s3cret', 's3cret'), 200)
})

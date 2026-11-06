import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { LIMITS, commandSigningString, keyId, validateMessage, verifySignature } from '../plugin/lib/protocol.js';

const question = (overrides = {}) => ({
  id: 'msg_12345678',
  type: 'question',
  to: 'bob/a1b2',
  body: { text: 'Are you changing the Client interface?' },
  ...overrides,
});

test('accepts a well formed question', () => {
  assert.deepEqual(validateMessage(question()), []);
});

test('rejects a question with nobody to ask', () => {
  assert.match(validateMessage(question({ to: '*' })).join(), /person or agent/);
  assert.match(validateMessage(question({ to: undefined })).join(), /person or agent/);
});

test('rejects text over its limit', () => {
  const errors = validateMessage(question({ body: { text: 'x'.repeat(LIMITS.text + 1) } }));
  assert.match(errors.join(), /limit is 500/);
});

test('rejects fenced code, because code stays out of the group', () => {
  const errors = validateMessage(question({ body: { text: 'look:\n```js\nrun()\n```' } }));
  assert.match(errors.join(), /fenced code/);
});

for (const [name, secret] of [
  ['AWS key', 'AKIAABCDEFGHIJKLMNOP'],
  ['GitHub token', `ghp_${'a'.repeat(36)}`],
  ['Anthropic-style key', `sk-ant-${'b'.repeat(40)}`],
  ['Slack token', 'xoxb-123456789012-abcdefghij'],
  ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
]) {
  test(`rejects text containing a ${name}`, () => {
    assert.match(validateMessage(question({ body: { text: `use ${secret} here` } })).join(), /secret/);
  });
}

test('rejects unknown types and missing threads', () => {
  assert.match(validateMessage(question({ type: 'nonsense' })).join(), /unknown type/);
  assert.match(validateMessage({ id: 'msg_12345678', type: 'reply', body: { text: 'hi', stance: 'info' } }).join(), /needs a thread/);
});

test('rejects an invalid stance', () => {
  const errors = validateMessage({ id: 'msg_12345678', type: 'reply', thread: 'thr_12345678', body: { text: 'hi', stance: 'angry' } });
  assert.match(errors.join(), /stance/);
});

test('rejects too many paths', () => {
  const paths = Array.from({ length: LIMITS.paths + 1 }, (_, index) => `f${index}`);
  const errors = validateMessage({ id: 'msg_12345678', type: 'intent', body: { paths, state: 'active', expires_at: new Date().toISOString() } });
  assert.match(errors.join(), /limit is 50/);
});

test('verifies a signature made the way a browser makes one', async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const signingString = commandSigningString({
    group: 'grp_x',
    person: 'alice',
    target: 'alice/c3d4',
    text: 'run the tests',
    nonce: 'nonce_12345678',
    expires_at: '2030-01-01T00:00:00Z',
  });
  const raw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.from(signingString));
  const signature = Buffer.from(raw).toString('base64url');

  assert.equal(verifySignature(jwk, signingString, signature), true);
  assert.equal(verifySignature(jwk, `${signingString}x`, signature), false);
  assert.equal(keyId(jwk).length, 16);
});

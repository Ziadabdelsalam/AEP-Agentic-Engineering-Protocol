#!/usr/bin/env node
// Runs a hub full of realistic sample activity on http://localhost:8799, for looking at the web app.
// Open /#demo-pair in a browser and it pairs itself as alice. Nothing here is used in production.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHub } from '../hub/server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-demo-'));
const SIGNUP = 'demo';
const hub = createHub({ dbPath: path.join(dir, 'hub.db'), dataDir: dir, signupCode: SIGNUP, allowLocalPush: true });
const port = Number(process.env.PORT) || 8799;
await hub.listen(port, '127.0.0.1');
const base = `http://localhost:${port}`;

async function call(token, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${route}: ${data.message}`);
  return data;
}

const signup = async (name) => (await call(null, 'POST', '/v1/signup', { name, code: SIGNUP, device: `${name}-mac` })).token;
const alice = await signup('alice');
const bob = await signup('bob');
const group = `grp_${crypto.createHash('sha256').update('github.com/acme/payments-api').digest('hex').slice(0, 32)}`;
await call(alice, 'POST', '/v1/groups', { id: group, name: 'payments-api', web_url: 'https://github.com/acme/payments-api' });
const { code } = await call(alice, 'POST', `/v1/groups/${group}/invites`);
await call(bob, 'POST', '/v1/groups', { id: group, invite: code });

let counter = 0;
const post = (token, message) => call(token, 'POST', `/v1/groups/${group}/messages`, { id: `demo_${String(++counter).padStart(8, '0')}`, ...message });
const status = (token, session, state) => post(token, { type: 'status', session, body: { session, state } });
const expires = () => new Date(Date.now() + 15 * 60 * 1000).toISOString();

await status(bob, 'a1b2', 'running');
await status(alice, 'c3d4', 'running');
await status(alice, 'e5f6', 'idle');

await post(bob, { type: 'intent', session: 'a1b2', body: { task: 'Retry logic in the payments client', paths: ['src/payments/client.ts', 'src/payments/retry.ts'], branch: 'feature/payments', state: 'active', expires_at: expires() } });
await post(alice, { type: 'intent', session: 'c3d4', body: { task: 'Update checkout to the new client', paths: ['src/checkout/**'], branch: 'feature/payments', state: 'active', expires_at: expires() } });

const first = await post(alice, { type: 'question', session: 'c3d4', to: 'bob/a1b2', body: { text: 'Are you changing the Client interface? I call get() from checkout.', paths: ['src/payments/client.ts'] } });
await call(bob, 'POST', `/v1/groups/${group}/receipts`, { message_ids: [first.message.id], state: 'read', session: 'a1b2' });
await post(bob, { type: 'reply', session: 'a1b2', thread: first.thread.id, body: { text: 'Yes. get() gains an options argument for retries. It lands in about ten minutes.', stance: 'info' } });
await post(alice, { type: 'agreement', session: 'c3d4', thread: first.thread.id, body: { outcome: 'bob/a1b2 finishes first, then alice/c3d4 updates the callers.' } });

await post(bob, {
  type: 'push',
  session: 'a1b2',
  body: {
    branch: 'feature/payments',
    before: 'a'.repeat(40),
    after: 'b'.repeat(40),
    commit_count: 3,
    paths: ['src/payments/client.ts', 'src/payments/retry.ts', 'src/payments/errors.ts', 'test/payments/retry.test.ts', 'docs/payments.md'],
    summary: 'Add retries to the payments client (+2 more)',
    decisions: ['Client.get now takes an options argument; every caller must pass one.'],
  },
});

const dispute = await post(alice, { type: 'question', session: 'c3d4', to: 'bob/a1b2', body: { text: 'Can we keep the old get() signature until Friday? Checkout ships Thursday.', paths: ['src/payments/client.ts'] } });
await post(bob, { type: 'reply', session: 'a1b2', thread: dispute.thread.id, body: { text: 'No. Keeping both would leave two retry paths to maintain.', stance: 'disagree' } });
await post(alice, { type: 'reply', session: 'c3d4', thread: dispute.thread.id, body: { text: 'Checkout cannot change before Thursday without risking the release.', stance: 'disagree' } });
await post(alice, { type: 'escalation', session: 'c3d4', thread: dispute.thread.id, body: { summary: 'Should the old Client.get signature stay until after the Thursday release?', options: ['Keep the old signature until Friday', 'Remove it now and update checkout today'], paths: ['src/payments/client.ts'] } });

await status(bob, 'k9k9', 'idle');
await post(alice, { type: 'question', session: 'c3d4', to: 'bob/k9k9', body: { text: 'Is the webhook handler safe to refactor while you are away?', paths: ['src/webhooks/handler.ts'] } });
await post(bob, { type: 'question', session: 'a1b2', to: 'alice', body: { text: 'Who owns the refund flow? I need to change how it reports errors.', paths: ['src/refunds/**'] } });
await post(alice, { type: 'worker', session: 'c3d4', body: { state: 'finished', command_id: 'demo_command_1', branch: 'aep/worker/4f2a9c', summary: 'Added retry tests for the checkout path. All passing. Check the timeout values in test/checkout/retry.test.ts.' } });
await post(alice, { type: 'push', session: 'c3d4', body: { branch: 'feature/payments', before: 'b'.repeat(40), after: 'c'.repeat(40), commit_count: 1, paths: ['src/checkout/cart.ts'], summary: 'Pass options to Client.get in the cart', decisions: [] } });

// Lets a browser sign in as alice without a terminal, by holding the pairing open for it.
const server = hub.server;
const original = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', async (req, res) => {
  if (req.url === '/demo/pair') {
    const { id } = await call(alice, 'POST', '/v1/pairings');
    const secret = crypto.randomBytes(16).toString('base64url');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: `/#pair/${id}/${secret}` }));
    const poll = setInterval(async () => {
      const pairing = await call(alice, 'GET', `/v1/pairings/${id}`);
      if (pairing.completed) {
        clearInterval(poll);
        await call(alice, 'POST', `/v1/pairings/${id}/confirm`);
      }
    }, 300);
    return;
  }
  original(req, res);
});

console.log(`Demo hub on ${base}. Sign in by opening ${base}/demo/pair and following the url it returns.`);
process.on('SIGTERM', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
});

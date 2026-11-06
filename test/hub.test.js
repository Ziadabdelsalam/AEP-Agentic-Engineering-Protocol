import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';

import { vapidHeader } from '../hub/push.js';
import { commandSigningString, keyId } from '../plugin/lib/protocol.js';
import { GROUP_ID, SIGNUP_CODE, client, startGroup, startHub } from './helpers.js';

let ctx;
let wakes;

beforeEach(async () => {
  wakes = [];
  ctx = await startGroup({
    sendPushWake: async (endpoint) => {
      wakes.push(endpoint);
      return 'sent';
    },
  });
});

afterEach(async () => {
  await ctx.close();
});

const thread = async (id) => (await ctx.alice.get(`/v1/groups/${GROUP_ID}/threads/${id}`)).data;

async function ask(deadline) {
  const { status, data } = await ctx.post(ctx.alice, {
    type: 'question',
    session: 'z1',
    to: 'bob/k1',
    body: { text: 'Are you changing lib.py?', ...(deadline ? { deadline_s: deadline } : {}) },
  });
  assert.equal(status, 200, JSON.stringify(data));
  return data;
}

// A browser identity, created the way the web app does it.
async function pairBrowser(device, base) {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const { data: pairing } = await device.post('/v1/pairings');
  const anonymous = client(base);
  await anonymous.post(`/v1/pairings/${pairing.id}/complete`, { jwk, mac: 'unused-by-hub', label: 'Test browser' });
  await device.post(`/v1/pairings/${pairing.id}/confirm`);
  const kid = keyId(jwk);
  const sign = async (text) => Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.from(text))).toString('base64url');
  const { data: { nonce } } = await anonymous.post('/v1/auth/challenge');
  const signature = await sign(JSON.stringify(['aep-login-v1', nonce]));
  const response = await fetch(`${base}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kid, nonce, signature }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  async function request(method, route, body) {
    const result = await fetch(`${base}${route}`, {
      method,
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: result.status, data: await result.json() };
  }
  return { kid, sign, get: (route) => request('GET', route), post: (route, body = {}) => request('POST', route, body) };
}

test('signup needs a valid code and a free name', async () => {
  const bad = await ctx.anonymous.post('/v1/signup', { name: 'mallory', code: 'wrong' });
  assert.equal(bad.status, 403);
  const taken = await ctx.anonymous.post('/v1/signup', { name: 'alice', code: SIGNUP_CODE });
  assert.equal(taken.status, 409);
  const badName = await ctx.anonymous.post('/v1/signup', { name: 'Not Valid!', code: SIGNUP_CODE });
  assert.equal(badName.status, 400);
});

test('an invite signs up a new person directly into the group, once', async () => {
  const { data: invite } = await ctx.alice.post(`/v1/groups/${GROUP_ID}/invites`);
  const first = await ctx.anonymous.post('/v1/signup', { name: 'sam', code: invite.code });
  assert.equal(first.status, 200);
  const sam = client(ctx.base, first.data.token);
  assert.equal((await sam.get(`/v1/groups/${GROUP_ID}`)).status, 200);
  const second = await ctx.anonymous.post('/v1/signup', { name: 'other', code: invite.code });
  assert.equal(second.status, 403);
});

test('a device code adds a second machine for the same person', async () => {
  const { data } = await ctx.alice.post('/v1/devices/codes');
  const { data: second } = await ctx.anonymous.post('/v1/signup', { code: data.code, device: 'alice-laptop' });
  assert.equal(second.person, 'alice');
  assert.equal((await client(ctx.base, second.token).get('/v1/me')).data.person, 'alice');
});

test('non-members cannot read or post, and joining an existing group needs an invite', async () => {
  const outsider = await ctx.signup('outsider');
  assert.equal((await outsider.get(`/v1/groups/${GROUP_ID}`)).status, 403);
  assert.equal((await outsider.get(`/v1/groups/${GROUP_ID}/messages`)).status, 403);
  const post = await outsider.post(`/v1/groups/${GROUP_ID}/messages`, { id: 'msg_12345678', type: 'push', session: 'x', body: {} });
  assert.equal(post.status, 403);
  const join = await outsider.post('/v1/groups', { id: GROUP_ID });
  assert.equal(join.status, 403);
  assert.equal(join.data.error, 'invite_required');
});

test('identity comes from the token, not from what the client claims', async () => {
  const { message } = await ask();
  assert.equal(message.from.person, 'alice');
  assert.equal(message.from.device, 'alice-mac');
  const spoof = await ctx.post(ctx.bob, {
    type: 'question',
    session: 'k1',
    to: 'alice/z1',
    from: { person: 'alice', session: 'z1' },
    body: { text: 'hello' },
  });
  assert.equal(spoof.data.message.from.person, 'bob');
});

test('messages are ordered by the hub and retries do not duplicate', async () => {
  const body = { paths: ['a.txt'], state: 'active', expires_at: new Date(Date.now() + 60_000).toISOString() };
  const first = await ctx.alice.post(`/v1/groups/${GROUP_ID}/messages`, { id: 'retry_12345678', type: 'intent', session: 'z1', body });
  const retry = await ctx.alice.post(`/v1/groups/${GROUP_ID}/messages`, { id: 'retry_12345678', type: 'intent', session: 'z1', body });
  assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.message.seq, first.data.message.seq);
  const { data } = await ctx.alice.get(`/v1/groups/${GROUP_ID}/messages?after=0`);
  assert.equal(data.messages.filter((message) => message.id === 'retry_12345678').length, 1);
});

test('the hub rejects anything over a limit with a reason', async () => {
  const { status, data } = await ctx.post(ctx.alice, {
    type: 'question',
    session: 'z1',
    to: 'bob/k1',
    body: { text: 'x'.repeat(501) },
  });
  assert.equal(status, 400);
  assert.match(data.message, /limit is 500/);
});

test('a question to an unknown agent lists who is there', async () => {
  const { status, data } = await ctx.post(ctx.alice, { type: 'question', session: 'z1', to: 'bob/nope', body: { text: 'hi' } });
  assert.equal(status, 400);
  assert.deepEqual(data.agents.sort(), ['alice/z1', 'bob/k1']);
});

test('intent updates the roster', async () => {
  await ctx.post(ctx.bob, {
    type: 'intent',
    session: 'k1',
    body: { task: 'retry logic', paths: ['src/client.ts'], branch: 'feature', state: 'active', expires_at: new Date(Date.now() + 900_000).toISOString() },
  });
  const { data } = await ctx.alice.get(`/v1/groups/${GROUP_ID}`);
  const agent = data.agents.find((entry) => entry.handle === 'bob/k1');
  assert.equal(agent.task, 'retry logic');
  assert.deepEqual(agent.paths, ['src/client.ts']);
});

test('a reply is routed to whoever asked, and answers the thread', async () => {
  const { thread: opened } = await ask();
  assert.equal(opened.state, 'open');
  const { data } = await ctx.post(ctx.bob, {
    type: 'reply',
    session: 'k1',
    thread: opened.id,
    body: { text: 'No, go ahead.', stance: 'info' },
  });
  assert.equal(data.message.to, 'alice/z1');
  assert.equal(data.thread.state, 'answered');
});

test('a question to an idle agent alerts its owner straight away', async () => {
  await ctx.setState(ctx.bob, 'k1', 'idle');
  const browser = await pairBrowser(ctx.bob, ctx.base);
  await browser.post('/v1/push/subscribe', { endpoint: 'https://push.example/bob' });
  const { thread: opened } = await ask();
  assert.equal(opened.state, 'waiting_on_person');
  await ctx.hub.settled();
  assert.deepEqual(wakes, ['https://push.example/bob']);
  const { data } = await browser.get('/v1/me/alerts');
  assert.equal(data.alerts[0].kind, 'question_waiting');
  await browser.post('/v1/me/alerts/seen', { ids: [data.alerts[0].id] });
  assert.equal((await browser.get('/v1/me/alerts')).data.alerts.length, 0);
});

test('a person can answer a question aimed at their agent', async () => {
  await ctx.setState(ctx.bob, 'k1', 'idle');
  const browser = await pairBrowser(ctx.bob, ctx.base);
  const { thread: opened } = await ask();
  const { status, data } = await browser.post(`/v1/groups/${GROUP_ID}/messages`, {
    id: 'human_12345678',
    type: 'reply',
    thread: opened.id,
    body: { text: 'Not touching it.', stance: 'info' },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.message.from.session, null);
  assert.equal(data.thread.state, 'answered');
});

test('a missed deadline moves the question to the person', async () => {
  const { thread: opened } = await ask(30);
  ctx.hub.tick(Date.now() + 29_000);
  assert.equal((await thread(opened.id)).thread.state, 'open');
  ctx.hub.tick(Date.now() + 31_000);
  assert.equal((await thread(opened.id)).thread.state, 'waiting_on_person');
});

test('three disagreeing replies from one side escalate automatically and alert both', async () => {
  const { thread: opened } = await ask();
  let last;
  for (let round = 0; round < 3; round += 1) {
    last = await ctx.post(ctx.bob, { type: 'reply', session: 'k1', thread: opened.id, body: { text: `No, reason ${round}.`, stance: 'disagree' } });
  }
  assert.equal(last.data.thread.state, 'escalated');
  const { messages } = (await thread(opened.id));
  const escalation = messages.find((message) => message.type === 'escalation');
  assert.equal(escalation.from.person, 'hub');
  assert.equal(escalation.body.positions[0].text, 'No, reason 2.');
});

test('only the parties can resolve, and both must agree', async () => {
  const { thread: opened } = await ask();
  await ctx.post(ctx.alice, { type: 'escalation', session: 'z1', thread: opened.id, body: { summary: 'Disagree on rename', options: ['Rename', 'Keep'] } });
  const aliceBrowser = await pairBrowser(ctx.alice, ctx.base);
  const bobBrowser = await pairBrowser(ctx.bob, ctx.base);
  const resolve = (browser, id, choice) => browser.post(`/v1/groups/${GROUP_ID}/messages`, { id, type: 'resolution', thread: opened.id, body: { choice } });

  const first = await resolve(aliceBrowser, 'res_00000001', 'Rename');
  assert.equal(first.data.thread.state, 'escalated');
  const second = await resolve(bobBrowser, 'res_00000002', 'Rename');
  assert.equal(second.data.thread.state, 'resolved');
});

test('agents cannot send person-only messages, and people cannot post as agents', async () => {
  const { status } = await ctx.post(ctx.alice, {
    type: 'command',
    session: 'z1',
    body: { target: 'alice/z1', text: 'x', nonce: 'nonce_12345678', expires_at: new Date().toISOString(), signature: 'x'.repeat(20), kid: 'kid12345' },
  });
  assert.equal(status, 403);
  const browser = await pairBrowser(ctx.alice, ctx.base);
  const push = await browser.post(`/v1/groups/${GROUP_ID}/messages`, { id: 'push_12345678', type: 'push', body: {} });
  assert.equal(push.status, 403);
});

test('a person can only command their own agents', async () => {
  const browser = await pairBrowser(ctx.alice, ctx.base);
  const command = (target) => browser.post(`/v1/groups/${GROUP_ID}/messages`, {
    id: `cmd_${crypto.randomBytes(6).toString('hex')}`,
    type: 'command',
    body: { target, text: 'run the tests', nonce: `nonce_${crypto.randomBytes(6).toString('hex')}`, expires_at: new Date(Date.now() + 60_000).toISOString(), signature: 'x'.repeat(20), kid: browser.kid },
  });
  assert.equal((await command('bob/k1')).status, 403);
  assert.equal((await command('alice/z1')).status, 200);
});

test('a browser that was never confirmed cannot sign in', async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const { data: pairing } = await ctx.alice.post('/v1/pairings');
  await ctx.anonymous.post(`/v1/pairings/${pairing.id}/complete`, { jwk, mac: 'x' });
  const { data: { nonce } } = await ctx.anonymous.post('/v1/auth/challenge');
  const raw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.from(JSON.stringify(['aep-login-v1', nonce])));
  const { status } = await ctx.anonymous.post('/v1/auth/verify', { kid: keyId(jwk), nonce, signature: Buffer.from(raw).toString('base64url') });
  assert.equal(status, 401);
});

test('a login challenge works only once', async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const { data: pairing } = await ctx.alice.post('/v1/pairings');
  await ctx.anonymous.post(`/v1/pairings/${pairing.id}/complete`, { jwk, mac: 'x' });
  await ctx.alice.post(`/v1/pairings/${pairing.id}/confirm`);
  const { data: { nonce } } = await ctx.anonymous.post('/v1/auth/challenge');
  const raw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.from(JSON.stringify(['aep-login-v1', nonce])));
  const signature = Buffer.from(raw).toString('base64url');
  assert.equal((await ctx.anonymous.post('/v1/auth/verify', { kid: keyId(jwk), nonce, signature })).status, 200);
  assert.equal((await ctx.anonymous.post('/v1/auth/verify', { kid: keyId(jwk), nonce, signature })).status, 401);
});

test('cookie requests from another site are refused', async () => {
  const browser = await pairBrowser(ctx.alice, ctx.base);
  const { data: { nonce } } = await ctx.anonymous.post('/v1/auth/challenge');
  const signature = await browser.sign(JSON.stringify(['aep-login-v1', nonce]));
  const login = await fetch(`${ctx.base}/v1/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kid: browser.kid, nonce, signature }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const result = await fetch(`${ctx.base}/v1/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(result.status, 403);
});

test('rate limits stop a runaway sender', async () => {
  await ctx.close();
  ctx = await startGroup({ rateLimitPerMinute: 3 });
  const send = () => ctx.post(ctx.alice, { type: 'question', session: 'z1', to: 'bob/k1', body: { text: 'again?' } });
  const statuses = [];
  for (let attempt = 0; attempt < 5; attempt += 1) statuses.push((await send()).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test('silent agents are marked offline', async () => {
  ctx.hub.tick(Date.now() + 120_000);
  const { data } = await ctx.alice.get(`/v1/groups/${GROUP_ID}`);
  assert.ok(data.agents.every((agent) => agent.state === 'offline'));
});

test('the live stream replays history and then follows new messages', async () => {
  const { message: first } = await ask();
  const controller = new AbortController();
  const response = await fetch(`${ctx.base}/v1/groups/${GROUP_ID}/live?after=0`, {
    headers: { Authorization: `Bearer ${(await ctx.anonymous.post('/v1/signup', { name: 'watcher', code: (await ctx.alice.post(`/v1/groups/${GROUP_ID}/invites`)).data.code })).data.token}` },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  let text = '';
  const readUntil = async (needle) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      text += Buffer.from(value).toString();
    }
  };
  await readUntil('event: ready');
  assert.ok(text.includes(first.id));
  const { message: second } = await ask();
  await readUntil(second.id);
  controller.abort();
});

test('the web app is served with a strict content policy, and paths cannot escape', async () => {
  const health = await fetch(`${ctx.base}/healthz`);
  assert.equal(health.status, 200);
  const traversal = await fetch(`${ctx.base}/..%2f..%2fpackage.json`);
  assert.equal(traversal.status, 404);
});

test('the push header is a valid signed token', () => {
  const header = vapidHeader('https://push.example/abc', ctx.hub.vapid, 'mailto:test@example.com', Date.now());
  const match = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(match);
  const claims = JSON.parse(Buffer.from(match[2], 'base64url').toString());
  assert.equal(claims.aud, 'https://push.example');
  const raw = Buffer.from(match[4], 'base64url');
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  const valid = crypto.verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(match[3], 'base64url'));
  assert.equal(valid, true);
});

test('invalid push endpoints are refused when local push is off', async () => {
  const strict = await startHub({ allowLocalPush: false });
  try {
    const device = await strict.signup('alice');
    const browser = await pairBrowser(device, strict.base);
    assert.equal((await browser.post('/v1/push/subscribe', { endpoint: 'http://127.0.0.1:9/x' })).status, 400);
    assert.equal((await browser.post('/v1/push/subscribe', { endpoint: 'https://push.example/ok' })).status, 200);
  } finally {
    await strict.close();
  }
});

test('commands are stored for the group to see', async () => {
  const browser = await pairBrowser(ctx.alice, ctx.base);
  const signingString = commandSigningString({ group: GROUP_ID, person: 'alice', target: 'alice/z1', text: 'run the tests', nonce: 'nonce_12345678', expires_at: '2030-01-01T00:00:00Z' });
  await browser.post(`/v1/groups/${GROUP_ID}/messages`, {
    id: 'cmd_12345678',
    type: 'command',
    body: { target: 'alice/z1', text: 'run the tests', nonce: 'nonce_12345678', expires_at: '2030-01-01T00:00:00Z', signature: await browser.sign(signingString), kid: browser.kid },
  });
  const { data } = await ctx.bob.get(`/v1/groups/${GROUP_ID}/messages?after=0`);
  assert.ok(data.messages.some((message) => message.type === 'command'));
});

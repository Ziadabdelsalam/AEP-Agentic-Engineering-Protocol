// Shared setup for the test suites: a real hub on a random port, with a small client around it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHub } from '../hub/server.js';

export const SIGNUP_CODE = 'test-signup-code';
export const GROUP_ID = 'grp_0123456789abcdef0123456789abcdef';

export function tempDir(label = 'aep-test') {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `${label}-`));
}

export function client(base, token) {
  async function request(method, route, body) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    return { status: response.status, data };
  }
  return {
    get: (route) => request('GET', route),
    post: (route, body = {}) => request('POST', route, body),
  };
}

export async function startHub(options = {}) {
  const dir = tempDir('aep-hub');
  const hub = createHub({
    dbPath: path.join(dir, 'hub.db'),
    dataDir: dir,
    signupCode: SIGNUP_CODE,
    allowLocalPush: true,
    ...options,
  });
  const port = await hub.listen(0);
  const base = `http://127.0.0.1:${port}`;

  return {
    hub,
    base,
    anonymous: client(base),
    async signup(name) {
      const { data } = await client(base).post('/v1/signup', { name, code: SIGNUP_CODE, device: `${name}-mac` });
      return client(base, data.token);
    },
    async close() {
      await hub.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Two people in one group, each with one running agent.
export async function startGroup(options = {}) {
  const context = await startHub(options);
  const alice = await context.signup('alice');
  const bob = await context.signup('bob');
  await alice.post('/v1/groups', { id: GROUP_ID, name: 'acme-api' });
  const { data: invite } = await alice.post(`/v1/groups/${GROUP_ID}/invites`);
  await bob.post('/v1/groups', { id: GROUP_ID, invite: invite.code });
  let counter = 0;
  const post = (who, message) => who.post(`/v1/groups/${GROUP_ID}/messages`, {
    id: `test_${String(++counter).padStart(8, '0')}`,
    ...message,
  });
  const setState = (who, session, state) => post(who, { type: 'status', session, body: { session, state } });
  await setState(alice, 'z1', 'running');
  await setState(bob, 'k1', 'running');
  return { ...context, alice, bob, post, setState };
}

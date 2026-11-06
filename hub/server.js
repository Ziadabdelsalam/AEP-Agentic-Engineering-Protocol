#!/usr/bin/env node
// The AEP hub: stores messages, runs conversation state and deadlines, sends alerts, serves the web app.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EPHEMERAL_TYPES,
  LIMITS,
  SENDER_TYPES,
  VERSION,
  isValidName,
  keyId,
  newId,
  validateMessage,
  verifySignature,
} from '../plugin/lib/protocol.js';
import { loadVapidKeys, sendWake } from './push.js';
import { Store, hashSecret } from './store.js';
import { applyMessage, isParty, openThread, parties, tickThread } from './threads.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY_BYTES = 64 * 1024;
const WEB_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const PAIRING_MS = 10 * 60 * 1000;
const AGENT_SILENCE_MS = 90 * 1000;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const secureEqual = (a, b) => {
  const left = Buffer.from(hashSecret(String(a)));
  const right = Buffer.from(hashSecret(String(b)));
  return crypto.timingSafeEqual(left, right);
};

const newSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
// Hex, because people paste these into commands, and a code starting with - reads as a flag.
const newCode = () => crypto.randomBytes(16).toString('hex');

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function validJwk(jwk) {
  if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return false;
  try {
    crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

export function createHub({
  dbPath,
  dataDir = path.dirname(dbPath === ':memory:' ? '.' : dbPath),
  signupCode = null,
  publicUrl = null,
  now = Date.now,
  allowLocalPush = false,
  rateLimitPerMinute = 600,
  retentionDays = 30,
  vapidSubject = 'mailto:aep@example.invalid',
  sendPushWake = sendWake,
} = {}) {
  const store = new Store(dbPath);
  const vapid = loadVapidKeys(path.join(dataDir, 'vapid.json'));
  const streams = new Set();
  const rateWindows = new Map();
  const secureCookies = publicUrl?.startsWith('https://') ?? false;
  const pendingPushes = new Set();

  // Live feed

  function broadcast(groupId, event, data, { id, person } = {}) {
    const payload = `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) {
      if (stream.groupId !== groupId) continue;
      if (person && stream.person !== person) continue;
      stream.res.write(payload);
    }
  }

  const broadcastRoster = (groupId) => broadcast(groupId, 'roster', { agents: store.agents(groupId) });
  const broadcastThread = (thread) => broadcast(thread.group_id, 'thread', { thread });

  // Alerts

  function raiseAlert({ person, groupId, thread, kind }) {
    const alert = { id: newId('alr_'), person, groupId, thread, kind, now: now() };
    store.createAlert(alert);
    broadcast(groupId, 'alert', { id: alert.id, thread, kind }, { person });
    for (const endpoint of store.pushSubscriptions(person)) {
      const delivery = Promise.resolve(sendPushWake(endpoint, vapid, vapidSubject))
        .then((result) => {
          if (result === 'gone') store.deletePushSubscription(endpoint);
        })
        .catch(() => {})
        .finally(() => pendingPushes.delete(delivery));
      pendingPushes.add(delivery);
    }
  }

  function raiseThreadAlerts(thread, alerts) {
    for (const alert of alerts) {
      raiseAlert({ person: alert.person, groupId: thread.group_id, thread: thread.id, kind: alert.kind });
    }
  }

  // Messages

  function storeAndBroadcast(message) {
    message.seq = store.insertMessage(message);
    broadcast(message.group, 'message', message, { id: message.seq });
    return message;
  }

  function hubEscalate(thread) {
    const history = store.threadMessages(thread.id).filter((entry) => entry.type === 'reply');
    const latestBySide = new Map();
    for (const reply of history) {
      latestBySide.set(reply.from.session ? `${reply.from.person}/${reply.from.session}` : reply.from.person, reply.body.text);
    }
    const positions = [...latestBySide.entries()].map(([side, text]) => ({ side, text: truncate(text, LIMITS.position) }));
    const message = storeAndBroadcast({
      aep: VERSION,
      id: newId('msg_'),
      group: thread.group_id,
      from: { person: 'hub', device: null, session: null },
      to: '*',
      thread: thread.id,
      sent_at: new Date(now()).toISOString(),
      type: 'escalation',
      body: { summary: 'The agents reached the reply limit without agreeing.', positions, paths: thread.paths },
    });
    const { thread: next, alerts } = applyMessage(thread, message, now());
    store.saveThread(next);
    broadcastThread(next);
    raiseThreadAlerts(next, alerts);
    return next;
  }

  function checkRateLimit(actorKey) {
    const minute = Math.floor(now() / 60_000);
    const window = rateWindows.get(actorKey);
    if (!window || window.minute !== minute) {
      rateWindows.set(actorKey, { minute, count: 1 });
      return;
    }
    window.count += 1;
    if (window.count > rateLimitPerMinute) throw new HttpError(429, 'rate_limited', 'Too many messages. Try again in a minute.');
  }

  function checkAddressExists(groupId, address) {
    const [person, session] = address.split('/');
    if (!store.isMember(groupId, person)) {
      throw new HttpError(400, 'unknown_target', `${person} isn't in this group.`, {
        members: store.members(groupId),
        agents: store.agents(groupId).map((agent) => agent.handle),
      });
    }
    if (session && !store.agent(groupId, address)) {
      throw new HttpError(400, 'unknown_target', `No agent called ${address}. Check aep_roster.`, {
        agents: store.agents(groupId).map((agent) => agent.handle),
      });
    }
  }

  // The other party in a thread, so replies reach whoever is waiting on them.
  function otherParty(thread, from) {
    const handle = from.session ? `${from.person}/${from.session}` : from.person;
    if (handle === thread.asker || (!from.session && from.person === thread.asker_person)) return thread.target;
    return thread.asker;
  }

  function postMessage(groupId, actor, input) {
    const allowed = SENDER_TYPES[actor.kind];
    if (!allowed.includes(input.type)) {
      throw new HttpError(403, 'not_allowed', `A ${actor.kind} can't send ${input.type} messages.`);
    }
    const errors = validateMessage(input);
    if (errors.length > 0) throw new HttpError(400, 'invalid_message', errors.join('; '), { errors });
    if (!EPHEMERAL_TYPES.includes(input.type)) checkRateLimit(actor.kind === 'device' ? actor.device.id : actor.person);

    const session = typeof input.session === 'string' && /^[a-z0-9]{1,36}$/.test(input.session) ? input.session : null;
    if (actor.kind === 'device' && !session && input.type !== 'worker') {
      throw new HttpError(400, 'invalid_message', 'session is required for agent messages');
    }
    const from = { person: actor.person, device: actor.kind === 'device' ? actor.device.name : null, session };

    if (input.type === 'status') {
      const handle = `${actor.person}/${input.body.session}`;
      store.upsertAgent({
        groupId,
        handle,
        person: actor.person,
        device: from.device,
        session: input.body.session,
        state: input.body.state,
        now: now(),
      });
      broadcastRoster(groupId);
      return { ok: true };
    }

    const existing = store.messageById(input.id);
    if (existing) {
      if (existing.group !== groupId || existing.from.person !== actor.person) throw new HttpError(409, 'id_conflict', 'That message id is taken.');
      return { message: existing, duplicate: true };
    }

    if (session) {
      const handle = `${actor.person}/${session}`;
      if (!store.agent(groupId, handle)) {
        store.upsertAgent({ groupId, handle, person: actor.person, device: from.device, session, state: 'running', now: now() });
      }
    }

    const message = {
      aep: VERSION,
      id: input.id,
      group: groupId,
      from,
      to: input.to ?? null,
      thread: input.thread ?? null,
      sent_at: new Date(now()).toISOString(),
      type: input.type,
      body: input.body,
    };

    switch (input.type) {
      case 'question':
        return postQuestion(groupId, message);
      case 'reply':
      case 'agreement':
      case 'escalation':
      case 'resolution':
        return postToThread(groupId, actor, message);
      case 'command': {
        if (message.body.target.split('/')[0] !== actor.person) {
          throw new HttpError(403, 'not_your_agent', 'You can only direct your own agents.');
        }
        message.to = message.body.target;
        storeAndBroadcast(message);
        return { message };
      }
      case 'intent': {
        const handle = `${actor.person}/${session}`;
        const active = message.body.state === 'active';
        store.setAgentIntent({
          groupId,
          handle,
          task: active ? message.body.task : null,
          paths: active ? message.body.paths : [],
          branch: message.body.branch,
          expiresAt: active ? Date.parse(message.body.expires_at) : null,
        });
        message.to = '*';
        storeAndBroadcast(message);
        broadcastRoster(groupId);
        return { message };
      }
      case 'push':
        message.to = '*';
        storeAndBroadcast(message);
        return { message };
      case 'worker': {
        message.to = actor.person;
        storeAndBroadcast(message);
        if (['finished', 'failed', 'refused'].includes(message.body.state)) {
          raiseAlert({ person: actor.person, groupId, thread: null, kind: `worker_${message.body.state}` });
        }
        return { message };
      }
      default:
        throw new HttpError(400, 'invalid_message', `Can't post ${input.type} here.`);
    }
  }

  function postQuestion(groupId, message) {
    checkAddressExists(groupId, message.to);
    message.thread = message.thread ?? newId('thr_');
    if (store.thread(message.thread)) throw new HttpError(409, 'thread_exists', 'That thread already exists.');
    const targetRunning = store.isAddressRunning(groupId, message.to);
    const { thread, alerts } = openThread({ id: message.thread, group: groupId, message, targetRunning, now: now() });
    storeAndBroadcast(message);
    thread.question_seq = message.seq;
    store.saveThread(thread);
    broadcastThread(thread);
    raiseThreadAlerts(thread, alerts);
    return { message, thread };
  }

  function postToThread(groupId, actor, message) {
    const thread = store.thread(message.thread);
    if (!thread || thread.group_id !== groupId) throw new HttpError(404, 'no_thread', `No thread ${message.thread} in this group.`);
    if (message.type === 'resolution' && !isParty(thread, actor.person)) {
      throw new HttpError(403, 'not_a_party', 'Only the people in this dispute can resolve it.');
    }
    if (message.type === 'escalation' || message.type === 'resolution') {
      message.to = '*';
    } else if (!message.to) {
      message.to = otherParty(thread, message.from);
    }
    storeAndBroadcast(message);
    const { thread: updated, alerts, escalate } = applyMessage(thread, message, now());
    store.saveThread(updated);
    broadcastThread(updated);
    raiseThreadAlerts(updated, alerts);
    const finalThread = escalate ? hubEscalate(updated) : updated;
    return { message, thread: finalThread };
  }

  function withReceipts(messages) {
    const rows = store.receiptsFor(messages.map((message) => message.id));
    const byMessage = new Map();
    for (const row of rows) {
      if (!byMessage.has(row.message_id)) byMessage.set(row.message_id, []);
      byMessage.get(row.message_id).push({ reader: row.reader, state: row.state, at: row.at });
    }
    return messages.map((message) => ({ ...message, receipts: byMessage.get(message.id) ?? [] }));
  }

  // Auth

  function cookieValue(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === name) return rest.join('=');
    }
    return null;
  }

  function authenticate(req) {
    const authorization = req.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const device = store.deviceByToken(hashSecret(authorization.slice(7)));
      if (device) return { kind: 'device', person: device.person, device };
      return null;
    }
    const cookie = cookieValue(req, 'aep_session');
    if (cookie) {
      const session = store.webSession(hashSecret(cookie), now());
      if (session) {
        // Browsers send cookies on cross-site requests, so changes must come from our own origin.
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) {
          throw new HttpError(403, 'bad_origin', 'Request came from another site.');
        }
        return { kind: 'person', person: session.person, kid: session.kid, tokenHash: session.token_hash };
      }
    }
    return null;
  }

  function requireMember(groupId, actor) {
    if (!store.group(groupId)) throw new HttpError(404, 'no_group', 'No such group.');
    if (!store.isMember(groupId, actor.person)) throw new HttpError(403, 'not_a_member', "You aren't in this group.");
  }

  function issueDevice(person, deviceName) {
    const token = `aep_${newSecret()}`;
    const device = { id: newId('dev_'), person, name: deviceName, tokenHash: hashSecret(token), now: now() };
    store.createDevice(device);
    return { person, device: { id: device.id, name: device.name }, token };
  }

  // Routes

  const routes = [
    ['GET', /^\/v1\/config$/, null, () => ({ aep: VERSION, vapid_public_key: vapid.public })],

    ['POST', /^\/v1\/signup$/, null, ({ body }) => {
      const deviceName = typeof body.device === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(body.device) ? body.device : 'device';
      const { name, code } = body;
      if (typeof code !== 'string' || !code) throw new HttpError(400, 'code_required', 'A signup or invite code is required.');
      const isSignupCode = signupCode && secureEqual(code, signupCode);
      if (!isSignupCode) {
        const invite = store.takeInvite(hashSecret(code), now());
        if (!invite) throw new HttpError(403, 'bad_code', "That code isn't valid, or it has already been used.");
        if (invite.kind === 'device') return issueDevice(invite.person, deviceName);
        if (!isValidName(name)) throw new HttpError(400, 'bad_name', 'Names are lowercase letters, digits, _ or -, up to 32 characters.');
        if (store.personExists(name)) throw new HttpError(409, 'name_taken', `The name ${name} is taken.`);
        store.createPerson(name, now());
        store.addMember(invite.group_id, name, now());
        return issueDevice(name, deviceName);
      }
      if (!isValidName(name)) throw new HttpError(400, 'bad_name', 'Names are lowercase letters, digits, _ or -, up to 32 characters.');
      if (store.personExists(name)) throw new HttpError(409, 'name_taken', `The name ${name} is taken.`);
      store.createPerson(name, now());
      return issueDevice(name, deviceName);
    }],

    ['GET', /^\/v1\/me$/, 'any', ({ actor }) => ({
      person: actor.person,
      kind: actor.kind,
      kid: actor.kid ?? null,
      groups: store.groupsFor(actor.person),
    })],

    ['POST', /^\/v1\/devices\/codes$/, 'device', ({ actor }) => {
      const code = newCode();
      store.createInvite({
        codeHash: hashSecret(code),
        kind: 'device',
        person: actor.person,
        createdBy: actor.person,
        now: now(),
        expiresAt: now() + PAIRING_MS,
      });
      return { code };
    }],

    // Browser pairing. The hub relays a public key. The helper decides whether to trust it.

    ['POST', /^\/v1\/pairings$/, 'device', ({ actor }) => {
      const id = newSecret(24);
      store.createPairing({ id, person: actor.person, now: now() });
      return { id };
    }],

    ['GET', /^\/v1\/pairings\/([\w-]+)$/, 'device', ({ actor, params }) => {
      const pairing = store.pairing(params[0]);
      if (!pairing || pairing.person !== actor.person) throw new HttpError(404, 'no_pairing', 'No such pairing.');
      return { completed: Boolean(pairing.completed_at), jwk: pairing.jwk, mac: pairing.mac, label: pairing.label };
    }],

    ['POST', /^\/v1\/pairings\/([\w-]+)\/complete$/, null, ({ params, body }) => {
      const pairing = store.pairing(params[0]);
      if (!pairing) throw new HttpError(404, 'no_pairing', 'No such pairing.');
      if (now() - pairing.created_at > PAIRING_MS) throw new HttpError(410, 'pairing_expired', 'This pairing link has expired.');
      if (pairing.completed_at) throw new HttpError(409, 'pairing_used', 'This pairing link has already been used.');
      if (!validJwk(body.jwk) || typeof body.mac !== 'string') throw new HttpError(400, 'bad_key', 'A public key and mac are required.');
      const jwk = { kty: 'EC', crv: 'P-256', x: body.jwk.x, y: body.jwk.y };
      store.completePairing({ id: params[0], jwk, mac: body.mac, label: truncate(String(body.label ?? 'Browser'), 80), now: now() });
      return { kid: keyId(jwk) };
    }],

    // Only the paired device can approve the browser, after its owner compares the codes.
    ['POST', /^\/v1\/pairings\/([\w-]+)\/confirm$/, 'device', ({ actor, params }) => {
      const pairing = store.pairing(params[0]);
      if (!pairing || pairing.person !== actor.person) throw new HttpError(404, 'no_pairing', 'No such pairing.');
      if (!pairing.jwk) throw new HttpError(409, 'pairing_incomplete', "The browser hasn't finished pairing.");
      const kid = keyId(pairing.jwk);
      store.saveBrowserKey({ kid, person: actor.person, jwk: pairing.jwk, label: pairing.label, now: now() });
      return { kid, confirmed: true };
    }],

    ['POST', /^\/v1\/auth\/challenge$/, null, () => {
      const nonce = newSecret(24);
      store.saveChallenge(nonce, now() + 60_000);
      return { nonce };
    }],

    ['POST', /^\/v1\/auth\/verify$/, null, ({ body, res }) => {
      const { kid, nonce, signature } = body;
      const key = typeof kid === 'string' ? store.browserKey(kid) : undefined;
      if (!key) throw new HttpError(401, 'unknown_key', "This browser isn't paired yet.");
      if (typeof nonce !== 'string' || !store.takeChallenge(nonce, now())) throw new HttpError(401, 'bad_challenge', 'Sign-in expired. Try again.');
      if (typeof signature !== 'string' || !verifySignature(key.jwk, JSON.stringify(['aep-login-v1', nonce]), signature)) {
        throw new HttpError(401, 'bad_signature', 'Signature check failed.');
      }
      const token = newSecret();
      store.createWebSession({ tokenHash: hashSecret(token), person: key.person, kid, expiresAt: now() + WEB_SESSION_MS });
      const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(WEB_SESSION_MS / 1000)}${secureCookies ? '; Secure' : ''}`;
      res.setHeader('Set-Cookie', `aep_session=${token}; ${flags}`);
      return { person: key.person, kid };
    }],

    ['POST', /^\/v1\/auth\/logout$/, 'person', ({ actor, res }) => {
      store.deleteWebSession(actor.tokenHash);
      res.setHeader('Set-Cookie', 'aep_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return { ok: true };
    }],

    // Groups

    ['GET', /^\/v1\/groups$/, 'any', ({ actor }) => ({ groups: store.groupsFor(actor.person) })],

    ['POST', /^\/v1\/groups$/, 'device', ({ actor, body }) => {
      const { id, name, web_url: webUrl, invite } = body;
      if (typeof id !== 'string' || !/^grp_[a-f0-9]{16,64}$/.test(id)) throw new HttpError(400, 'bad_group', 'Group id is malformed.');
      const existing = store.group(id);
      if (!existing) {
        if (typeof name !== 'string' || !name) throw new HttpError(400, 'bad_group', 'A group name is required.');
        const safeUrl = typeof webUrl === 'string' && webUrl.startsWith('https://') ? webUrl : null;
        store.createGroup({ id, name: truncate(name, 80), webUrl: safeUrl, person: actor.person, now: now() });
        return { group: store.group(id), created: true };
      }
      if (store.isMember(id, actor.person)) return { group: existing, created: false };
      if (typeof invite === 'string' && invite) {
        const taken = store.takeInvite(hashSecret(invite), now());
        if (taken?.kind === 'group' && taken.group_id === id) {
          store.addMember(id, actor.person, now());
          return { group: existing, created: false };
        }
        throw new HttpError(403, 'bad_code', "That invite isn't valid for this repo.");
      }
      throw new HttpError(403, 'invite_required', 'This repo already has a group. Ask a member to run: aep invite');
    }],

    ['GET', /^\/v1\/groups\/([\w-]+)$/, 'any', ({ actor, params }) => {
      requireMember(params[0], actor);
      return {
        group: store.group(params[0]),
        members: store.members(params[0]),
        agents: store.agents(params[0]),
        threads: store.threadsFor(params[0]),
      };
    }],

    ['POST', /^\/v1\/groups\/([\w-]+)\/invites$/, 'any', ({ actor, params }) => {
      requireMember(params[0], actor);
      const code = newCode();
      const expiresAt = now() + INVITE_MS;
      store.createInvite({
        codeHash: hashSecret(code),
        kind: 'group',
        groupId: params[0],
        createdBy: actor.person,
        now: now(),
        expiresAt,
      });
      return { code, expires_at: new Date(expiresAt).toISOString() };
    }],

    ['POST', /^\/v1\/groups\/([\w-]+)\/messages$/, 'any', ({ actor, params, body }) => {
      requireMember(params[0], actor);
      return postMessage(params[0], actor, body);
    }],

    ['GET', /^\/v1\/groups\/([\w-]+)\/messages$/, 'any', ({ actor, params, query }) => {
      requireMember(params[0], actor);
      const limit = Math.min(Number(query.get('limit')) || 200, 500);
      const messages = query.has('after')
        ? store.messagesAfter(params[0], Number(query.get('after')) || 0, limit)
        : store.latestMessages(params[0], limit);
      return { messages: withReceipts(messages) };
    }],

    ['POST', /^\/v1\/groups\/([\w-]+)\/receipts$/, 'device', ({ actor, params, body }) => {
      requireMember(params[0], actor);
      const { message_ids: ids, state, session } = body;
      if (!Array.isArray(ids) || ids.length > 200 || !['delivered', 'read'].includes(state)) {
        throw new HttpError(400, 'bad_receipt', 'Receipts need message_ids and a state.');
      }
      const reader = typeof session === 'string' && /^[a-z0-9]{1,36}$/.test(session)
        ? `${actor.person}/${session}`
        : `${actor.person}@${actor.device.name}`;
      const at = now();
      for (const messageId of ids) {
        if (typeof messageId === 'string' && store.messageById(messageId)?.group === params[0]) {
          store.saveReceipt({ messageId, reader, state, now: at });
        }
      }
      broadcast(params[0], 'receipt', { message_ids: ids, reader, state, at });
      return { ok: true };
    }],

    ['GET', /^\/v1\/groups\/([\w-]+)\/threads$/, 'any', ({ actor, params }) => {
      requireMember(params[0], actor);
      return { threads: store.threadsFor(params[0]) };
    }],

    ['GET', /^\/v1\/groups\/([\w-]+)\/threads\/([\w-]+)$/, 'any', ({ actor, params }) => {
      requireMember(params[0], actor);
      const thread = store.thread(params[1]);
      if (!thread || thread.group_id !== params[0]) throw new HttpError(404, 'no_thread', 'No such thread.');
      return { thread, messages: withReceipts(store.threadMessages(params[1])), parties: parties(thread) };
    }],

    // Phone alerts

    ['POST', /^\/v1\/push\/subscribe$/, 'person', ({ actor, body }) => {
      let url;
      try {
        url = new URL(body.endpoint);
      } catch {
        throw new HttpError(400, 'bad_endpoint', 'endpoint must be a URL.');
      }
      if (!allowLocalPush && (url.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(url.hostname))) {
        throw new HttpError(400, 'bad_endpoint', 'endpoint must be a public https URL.');
      }
      store.savePushSubscription({ endpoint: url.href, person: actor.person, now: now() });
      return { ok: true };
    }],

    ['GET', /^\/v1\/me\/alerts$/, 'person', ({ actor }) => ({ alerts: store.unseenAlerts(actor.person) })],

    ['POST', /^\/v1\/me\/alerts\/seen$/, 'person', ({ actor, body }) => {
      if (!Array.isArray(body.ids)) throw new HttpError(400, 'bad_ids', 'ids must be a list.');
      store.markAlertsSeen(actor.person, body.ids.slice(0, 200), now());
      return { ok: true };
    }],
  ];

  async function readBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'Request body is too large.');
      chunks.push(chunk);
    }
    if (total === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Falls through to the error below.
    }
    throw new HttpError(400, 'bad_json', 'Request body must be JSON.');
  }

  function openStream(req, res, groupId, actor, query) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let after = Number(req.headers['last-event-id'] ?? query.get('after')) || 0;
    for (;;) {
      const batch = store.messagesAfter(groupId, after, 500);
      for (const message of batch) {
        res.write(`id: ${message.seq}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
        after = message.seq;
      }
      if (batch.length < 500) break;
    }
    const stream = { res, groupId, person: actor.person };
    streams.add(stream);
    res.write(`event: roster\ndata: ${JSON.stringify({ agents: store.agents(groupId) })}\n\n`);
    res.write(`event: ready\ndata: ${JSON.stringify({ after })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const cleanup = () => {
      clearInterval(ping);
      streams.delete(stream);
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  }

  function serveStatic(pathname, res) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, relative));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return void res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://hub.invalid');
    const { pathname } = url;
    if (req.method === 'GET' && pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return void res.end('ok');
    }
    if (!pathname.startsWith('/v1/')) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      return serveStatic(pathname, res);
    }

    const live = pathname.match(/^\/v1\/groups\/([\w-]+)\/live$/);
    if (live && req.method === 'GET') {
      const actor = authenticate(req);
      if (!actor) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
      requireMember(live[1], actor);
      return openStream(req, res, live[1], actor, url.searchParams);
    }

    for (const [method, pattern, auth, handler] of routes) {
      if (method !== req.method) continue;
      const match = pathname.match(pattern);
      if (!match) continue;
      let actor = null;
      if (auth) {
        actor = authenticate(req);
        if (!actor) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
        if (auth !== 'any' && actor.kind !== auth) throw new HttpError(403, 'wrong_identity', `This needs a ${auth} identity.`);
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await handler({ actor, params: match.slice(1), body, query: url.searchParams, res, req });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return void res.end(JSON.stringify(result));
    }
    throw new HttpError(404, 'not_found', 'No such route.');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return void res.end();
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      const payload = error instanceof HttpError
        ? { error: error.code, message: error.message, ...error.extra }
        : { error: 'internal', message: 'Something went wrong on the hub.' };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  // Time-based changes

  let lastRetentionSweep = 0;

  function tick(at = now()) {
    for (const thread of store.activeThreads()) {
      const change = tickThread(thread, at);
      if (!change) continue;
      store.saveThread(change.thread);
      broadcastThread(change.thread);
      raiseThreadAlerts(change.thread, change.alerts);
    }
    const quietGroups = new Set();
    for (const agent of store.staleAgents(at - AGENT_SILENCE_MS)) {
      store.upsertAgent({
        groupId: agent.group_id,
        handle: agent.handle,
        person: agent.person,
        device: agent.device,
        session: agent.session,
        state: 'offline',
        now: agent.last_seen,
      });
      quietGroups.add(agent.group_id);
    }
    for (const groupId of quietGroups) broadcastRoster(groupId);
    if (at - lastRetentionSweep > 60 * 60 * 1000) {
      lastRetentionSweep = at;
      store.deleteOldMessages(at - retentionDays * 24 * 60 * 60 * 1000);
    }
  }

  const ticker = setInterval(() => tick(), 2000);
  ticker.unref();

  return {
    server,
    store,
    tick,
    vapid,
    listen: (port = 0, host = '127.0.0.1') => new Promise((resolve) => {
      server.listen(port, host, () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => {
      clearInterval(ticker);
      for (const stream of streams) stream.res.end();
      streams.clear();
      server.closeAllConnections?.();
      server.close(() => {
        store.close();
        resolve();
      });
    }),
    settled: () => Promise.allSettled([...pendingPushes]),
  };
}

function main() {
  const dataDir = process.env.AEP_DATA_DIR ?? path.resolve('.aep-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'hub.db');
  let signupCode = process.env.AEP_SIGNUP_CODE ?? null;
  if (!signupCode) {
    signupCode = crypto.randomBytes(12).toString('base64url');
    console.log(`Signup code for this run: ${signupCode}`);
    console.log('Set AEP_SIGNUP_CODE to keep one across restarts.');
  }
  const hub = createHub({
    dbPath,
    dataDir,
    signupCode,
    publicUrl: process.env.AEP_PUBLIC_URL ?? null,
    retentionDays: Number(process.env.AEP_RETENTION_DAYS) || 30,
    vapidSubject: process.env.AEP_VAPID_SUBJECT ?? 'mailto:aep@example.invalid',
  });
  const port = Number(process.env.PORT) || 8787;
  hub.listen(port, process.env.AEP_HOST ?? '127.0.0.1').then((actualPort) => {
    console.log(`AEP hub listening on port ${actualPort}`);
  });
  const stop = () => hub.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();

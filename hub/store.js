// SQLite storage for the hub. All SQL lives here.
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS persons (
    name TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL REFERENCES persons(name),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS browser_keys (
    kid TEXT PRIMARY KEY,
    person TEXT NOT NULL REFERENCES persons(name),
    jwk TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash TEXT PRIMARY KEY,
    person TEXT NOT NULL REFERENCES persons(name),
    kid TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS challenges (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pairings (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL REFERENCES persons(name),
    jwk TEXT,
    mac TEXT,
    label TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    web_url TEXT,
    created_by TEXT NOT NULL REFERENCES persons(name),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    group_id TEXT NOT NULL REFERENCES groups(id),
    person TEXT NOT NULL REFERENCES persons(name),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, person)
  );
  CREATE TABLE IF NOT EXISTS invites (
    code_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    group_id TEXT,
    person TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    group_id TEXT NOT NULL REFERENCES groups(id),
    type TEXT NOT NULL,
    from_person TEXT NOT NULL,
    from_device TEXT,
    from_session TEXT,
    to_addr TEXT,
    thread TEXT,
    body TEXT NOT NULL,
    sent_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_group_seq ON messages (group_id, seq);
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id),
    state TEXT NOT NULL,
    data TEXT NOT NULL,
    deadline_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS threads_group ON threads (group_id, updated_at);
  CREATE TABLE IF NOT EXISTS agents (
    group_id TEXT NOT NULL REFERENCES groups(id),
    handle TEXT NOT NULL,
    person TEXT NOT NULL,
    device TEXT,
    session TEXT NOT NULL,
    state TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    task TEXT,
    paths TEXT,
    branch TEXT,
    intent_expires_at INTEGER,
    PRIMARY KEY (group_id, handle)
  );
  CREATE TABLE IF NOT EXISTS receipts (
    message_id TEXT NOT NULL,
    reader TEXT NOT NULL,
    state TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (message_id, reader, state)
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL,
    group_id TEXT NOT NULL,
    thread TEXT,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seen_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS alerts_person ON alerts (person, seen_at);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    person TEXT NOT NULL REFERENCES persons(name),
    created_at INTEGER NOT NULL
  );
`;

export const hashSecret = (value) => crypto.createHash('sha256').update(value).digest('hex');

const toMessage = (row) => ({
  aep: '0.1',
  id: row.id,
  seq: row.seq,
  group: row.group_id,
  from: { person: row.from_person, device: row.from_device, session: row.from_session },
  to: row.to_addr,
  thread: row.thread,
  sent_at: row.sent_at,
  type: row.type,
  body: JSON.parse(row.body),
});

const toAgent = (row) => ({
  handle: row.handle,
  person: row.person,
  device: row.device,
  session: row.session,
  state: row.state,
  last_seen: row.last_seen,
  task: row.task,
  paths: row.paths ? JSON.parse(row.paths) : [],
  branch: row.branch,
  intent_expires_at: row.intent_expires_at,
});

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // People and devices

  personExists(name) {
    return Boolean(this.db.prepare('SELECT 1 FROM persons WHERE name = ?').get(name));
  }

  createPerson(name, now) {
    this.db.prepare('INSERT INTO persons (name, created_at) VALUES (?, ?)').run(name, now);
  }

  createDevice({ id, person, name, tokenHash, now }) {
    this.db.prepare('INSERT INTO devices (id, person, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, person, name, tokenHash, now);
  }

  deviceByToken(tokenHash) {
    return this.db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash);
  }

  // Browser keys and web sessions

  saveBrowserKey({ kid, person, jwk, label, now }) {
    this.db.prepare(`
      INSERT INTO browser_keys (kid, person, jwk, label, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (kid) DO UPDATE SET label = excluded.label
    `).run(kid, person, JSON.stringify(jwk), label ?? null, now);
  }

  browserKey(kid) {
    const row = this.db.prepare('SELECT * FROM browser_keys WHERE kid = ?').get(kid);
    return row ? { ...row, jwk: JSON.parse(row.jwk) } : undefined;
  }

  createWebSession({ tokenHash, person, kid, expiresAt }) {
    this.db.prepare('INSERT INTO web_sessions (token_hash, person, kid, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, person, kid, expiresAt);
  }

  webSession(tokenHash, now) {
    return this.db.prepare('SELECT * FROM web_sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, now);
  }

  deleteWebSession(tokenHash) {
    this.db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(tokenHash);
  }

  saveChallenge(nonce, expiresAt) {
    this.db.prepare('INSERT INTO challenges (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt);
  }

  // One use only: returns true if the challenge existed and hadn't expired.
  takeChallenge(nonce, now) {
    const row = this.db.prepare('SELECT expires_at FROM challenges WHERE nonce = ?').get(nonce);
    this.db.prepare('DELETE FROM challenges WHERE nonce = ?').run(nonce);
    return Boolean(row && row.expires_at > now);
  }

  // Browser pairing

  createPairing({ id, person, now }) {
    this.db.prepare('INSERT INTO pairings (id, person, created_at) VALUES (?, ?, ?)').run(id, person, now);
  }

  pairing(id) {
    const row = this.db.prepare('SELECT * FROM pairings WHERE id = ?').get(id);
    return row ? { ...row, jwk: row.jwk ? JSON.parse(row.jwk) : null } : undefined;
  }

  completePairing({ id, jwk, mac, label, now }) {
    this.db.prepare('UPDATE pairings SET jwk = ?, mac = ?, label = ?, completed_at = ? WHERE id = ?')
      .run(JSON.stringify(jwk), mac, label ?? null, now, id);
  }

  // Groups and invites

  group(id) {
    return this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  }

  createGroup({ id, name, webUrl, person, now }) {
    this.db.prepare('INSERT INTO groups (id, name, web_url, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, webUrl ?? null, person, now);
    this.addMember(id, person, now);
  }

  addMember(groupId, person, now) {
    this.db.prepare('INSERT OR IGNORE INTO members (group_id, person, joined_at) VALUES (?, ?, ?)').run(groupId, person, now);
  }

  isMember(groupId, person) {
    return Boolean(this.db.prepare('SELECT 1 FROM members WHERE group_id = ? AND person = ?').get(groupId, person));
  }

  members(groupId) {
    return this.db.prepare('SELECT person FROM members WHERE group_id = ? ORDER BY joined_at').all(groupId).map((row) => row.person);
  }

  groupsFor(person) {
    return this.db.prepare(`
      SELECT g.id, g.name, g.web_url FROM groups g
      JOIN members m ON m.group_id = g.id
      WHERE m.person = ? ORDER BY g.name
    `).all(person);
  }

  createInvite({ codeHash, kind, groupId, person, createdBy, now, expiresAt }) {
    this.db.prepare(`
      INSERT INTO invites (code_hash, kind, group_id, person, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(codeHash, kind, groupId ?? null, person ?? null, createdBy, now, expiresAt);
  }

  // One use only: returns the invite if it was valid.
  takeInvite(codeHash, now) {
    const invite = this.db.prepare('SELECT * FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').get(codeHash, now);
    if (!invite) return undefined;
    this.db.prepare('UPDATE invites SET used_at = ? WHERE code_hash = ?').run(now, codeHash);
    return invite;
  }

  // Messages

  insertMessage(message) {
    const result = this.db.prepare(`
      INSERT INTO messages (id, group_id, type, from_person, from_device, from_session, to_addr, thread, body, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.group,
      message.type,
      message.from.person,
      message.from.device ?? null,
      message.from.session ?? null,
      message.to ?? null,
      message.thread ?? null,
      JSON.stringify(message.body),
      message.sent_at,
    );
    return Number(result.lastInsertRowid);
  }

  messageById(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? toMessage(row) : undefined;
  }

  messagesAfter(groupId, after, limit = 500) {
    return this.db.prepare('SELECT * FROM messages WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(groupId, after, limit).map(toMessage);
  }

  latestMessages(groupId, limit = 200) {
    return this.db.prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY seq DESC LIMIT ?')
      .all(groupId, limit).map(toMessage).reverse();
  }

  threadMessages(threadId) {
    return this.db.prepare('SELECT * FROM messages WHERE thread = ? ORDER BY seq').all(threadId).map(toMessage);
  }

  deleteOldMessages(before) {
    this.db.prepare("DELETE FROM messages WHERE strftime('%s', sent_at) * 1000 < ?").run(before);
    this.db.prepare('DELETE FROM alerts WHERE created_at < ?').run(before);
    this.db.prepare('DELETE FROM receipts WHERE at < ?').run(before);
    this.db.prepare("DELETE FROM threads WHERE state IN ('resolved', 'stale', 'answered') AND updated_at < ?").run(before);
  }

  // Threads

  saveThread(thread) {
    this.db.prepare(`
      INSERT INTO threads (id, group_id, state, data, deadline_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET state = excluded.state, data = excluded.data,
        deadline_at = excluded.deadline_at, updated_at = excluded.updated_at
    `).run(thread.id, thread.group_id, thread.state, JSON.stringify(thread), thread.deadline_at, thread.updated_at);
  }

  thread(id) {
    const row = this.db.prepare('SELECT data FROM threads WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : undefined;
  }

  threadsFor(groupId, limit = 200) {
    return this.db.prepare('SELECT data FROM threads WHERE group_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(groupId, limit).map((row) => JSON.parse(row.data));
  }

  activeThreads() {
    return this.db.prepare("SELECT data FROM threads WHERE state NOT IN ('resolved', 'stale')").all()
      .map((row) => JSON.parse(row.data));
  }

  // Agents

  upsertAgent({ groupId, handle, person, device, session, state, now }) {
    this.db.prepare(`
      INSERT INTO agents (group_id, handle, person, device, session, state, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (group_id, handle) DO UPDATE SET device = excluded.device, state = excluded.state, last_seen = excluded.last_seen
    `).run(groupId, handle, person, device ?? null, session, state, now);
  }

  setAgentIntent({ groupId, handle, task, paths, branch, expiresAt }) {
    this.db.prepare('UPDATE agents SET task = ?, paths = ?, branch = ?, intent_expires_at = ? WHERE group_id = ? AND handle = ?')
      .run(task ?? null, JSON.stringify(paths ?? []), branch ?? null, expiresAt, groupId, handle);
  }

  agent(groupId, handle) {
    const row = this.db.prepare('SELECT * FROM agents WHERE group_id = ? AND handle = ?').get(groupId, handle);
    return row ? toAgent(row) : undefined;
  }

  agents(groupId) {
    return this.db.prepare('SELECT * FROM agents WHERE group_id = ? ORDER BY person, last_seen DESC').all(groupId).map(toAgent);
  }

  isAddressRunning(groupId, address) {
    if (address.includes('/')) return this.agent(groupId, address)?.state === 'running';
    return Boolean(this.db.prepare("SELECT 1 FROM agents WHERE group_id = ? AND person = ? AND state = 'running'").get(groupId, address));
  }

  staleAgents(before) {
    return this.db.prepare("SELECT * FROM agents WHERE state != 'offline' AND last_seen < ?").all(before)
      .map((row) => ({ ...toAgent(row), group_id: row.group_id }));
  }

  // Receipts

  saveReceipt({ messageId, reader, state, now }) {
    this.db.prepare('INSERT OR IGNORE INTO receipts (message_id, reader, state, at) VALUES (?, ?, ?, ?)').run(messageId, reader, state, now);
  }

  receiptsFor(messageIds) {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT message_id, reader, state, at FROM receipts WHERE message_id IN (${placeholders})`).all(...messageIds);
  }

  // Alerts and push

  createAlert({ id, person, groupId, thread, kind, now }) {
    this.db.prepare('INSERT INTO alerts (id, person, group_id, thread, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, person, groupId, thread ?? null, kind, now);
  }

  unseenAlerts(person) {
    return this.db.prepare(`
      SELECT a.id, a.group_id, a.thread, a.kind, a.created_at, g.name AS group_name FROM alerts a
      JOIN groups g ON g.id = a.group_id
      WHERE a.person = ? AND a.seen_at IS NULL ORDER BY a.created_at DESC LIMIT 50
    `).all(person);
  }

  markAlertsSeen(person, ids, now) {
    for (const id of ids) {
      this.db.prepare('UPDATE alerts SET seen_at = ? WHERE id = ? AND person = ?').run(now, id, person);
    }
  }

  savePushSubscription({ endpoint, person, now }) {
    this.db.prepare(`
      INSERT INTO push_subscriptions (endpoint, person, created_at) VALUES (?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET person = excluded.person
    `).run(endpoint, person, now);
  }

  pushSubscriptions(person) {
    return this.db.prepare('SELECT endpoint FROM push_subscriptions WHERE person = ?').all(person).map((row) => row.endpoint);
  }

  deletePushSubscription(endpoint) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }
}

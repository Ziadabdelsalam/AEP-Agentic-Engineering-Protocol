#!/usr/bin/env node
// The local helper. One per machine. It connects out to the hub and opens no ports. It keeps each
// repo's inbox current, sends queued posts, watches git and reports which agents are running.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { computeUpstream, fetchArgs, gitAsync, worktreeBranches } from '../lib/git.js';
import { HubError, followStream, hubRequest } from '../lib/hub-client.js';
import {
  aepHome,
  appendInbox,
  isProcessAlive,
  loadConfig,
  loadRepoConfig,
  loadRepos,
  readJson,
  repoStateDir,
  sessionsDir,
  trimInbox,
  upstreamCacheFile,
  writeJson,
} from '../lib/local.js';
import { CommandRunner } from './commands.js';

const execFileAsync = promisify(execFile);

const TICK_MS = Number(process.env.AEP_HELPER_TICK_MS) || 2000;
const STATUS_EVERY_MS = Number(process.env.AEP_STATUS_EVERY_MS) || 5000;
const HEARTBEAT_MS = 30_000;
const FETCH_EVERY_MS = Number(process.env.AEP_FETCH_EVERY_MS) || 60_000;
const LIVENESS_EVERY_MS = 15_000;
const TRIM_EVERY_MS = 5 * 60 * 1000;
const SESSION_FORGET_MS = 7 * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const helperFile = () => path.join(aepHome(), 'helper.json');

function log(line) {
  try {
    fs.mkdirSync(aepHome(), { recursive: true });
    fs.appendFileSync(path.join(aepHome(), 'helper.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never take the helper down.
  }
}

// Which sessions Claude Code says are alive. Null if the CLI can't tell us, for example on an old version.
async function liveClaudeSessions() {
  try {
    const { stdout } = await execFileAsync(process.env.AEP_CLAUDE_BIN ?? 'claude', ['agents', '--json'], { timeout: 8000 });
    return new Map(JSON.parse(stdout).map((entry) => [entry.sessionId, entry]));
  } catch {
    return null;
  }
}

export function effectiveState(session, listed, now) {
  if (session.state === 'ended') return 'offline';
  const age = now - session.last_activity;
  if (listed === null) {
    // No liveness information, so go by how recently its hooks ran.
    if (session.state === 'running' && age < 5 * 60 * 1000) return 'running';
    return age < 30 * 60 * 1000 ? 'idle' : 'offline';
  }
  const entry = listed.get(session.session_id);
  if (!entry) return age < 20_000 ? session.state : 'offline';
  if (entry.status === 'busy') return 'running';
  if (entry.status === 'idle') return 'idle';
  return session.state === 'running' ? 'running' : 'idle';
}

class RepoLink {
  constructor(entry, config) {
    this.config = config;
    this.repoPath = entry.path;
    this.stateDir = repoStateDir(entry.common_dir);
    this.repoConfigGroup = entry.group;
    this.controller = new AbortController();
    this.stateFile = path.join(this.stateDir, 'helper-state.json');
    this.lastSeq = readJson(this.stateFile, {}).last_seq ?? 0;
    this.pendingDelivered = [];
    this.doorbell = true;
    this.lastFetch = 0;
    this.lastStatus = 0;
    this.lastLiveness = 0;
    this.lastTrim = Date.now();
    this.refreshing = false;
    this.listed = null;
    this.reported = new Map();
    this.states = new Map();
    this.branches = [];
    this.stopped = false;
    this.commands = new CommandRunner({
      link: this,
      log,
      post: (message) => this.postMessage(message),
    });
  }

  start() {
    this.followGroup();
    log(`joined stream for ${this.repoConfigGroup}`);
  }

  stop() {
    this.stopped = true;
    this.controller.abort();
  }

  async postMessage(message) {
    return hubRequest(this.config, 'POST', `/v1/groups/${this.repoConfigGroup}/messages`, message);
  }

  async followGroup() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        await followStream(this.config, `/v1/groups/${this.repoConfigGroup}/live?after=${this.lastSeq}`, {
          signal: this.controller.signal,
          onEvent: async (event, data) => {
            backoff = 1000;
            await this.onEvent(event, data);
          },
        });
      } catch (error) {
        if (this.stopped) return;
        log(`stream for ${this.repoConfigGroup} ended: ${error.message}`);
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  async onEvent(event, data) {
    if (event === 'roster') {
      writeJson(path.join(this.stateDir, 'roster.json'), { agents: data.agents, at: Date.now() });
      return;
    }
    if (event !== 'message' || data.seq <= this.lastSeq) return;
    this.lastSeq = data.seq;
    writeJson(this.stateFile, { last_seq: data.seq });
    if (data.type === 'command') {
      try {
        await this.commands.handle(data);
      } catch (error) {
        log(`command handling failed: ${error.stack ?? error}`);
      }
      return;
    }
    appendInbox(this.stateDir, data);
    if (data.type === 'push') this.doorbell = true;
    const person = this.config.person;
    if (data.from.person !== person && (data.to === person || data.to?.startsWith(`${person}/`))) {
      this.pendingDelivered.push(data.id);
    }
  }

  // Read fresh, because this decides whether a command starts a worker.
  isTargetRunning(target) {
    const person = this.config.person;
    return this.sessions().some(({ session }) => (
      (target === person || target === `${person}/${session.short}`)
      && effectiveState(session, this.listed, Date.now()) === 'running'
    ));
  }

  primaryBranch() {
    return this.branches[0]?.branch ?? null;
  }

  sessions() {
    const dir = sessionsDir(this.stateDir);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith('.json')).map((name) => ({
      file: path.join(dir, name),
      session: readJson(path.join(dir, name)),
    })).filter((entry) => entry.session);
  }

  async drainOutbox() {
    const dir = path.join(this.stateDir, 'outbox');
    let names;
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const message = readJson(file);
      if (!message) continue;
      try {
        await this.postMessage(message);
        fs.unlinkSync(file);
      } catch (error) {
        if (error instanceof HubError && error.status && error.status < 500 && error.status !== 429) {
          log(`hub rejected ${name}: ${error.message}`);
          fs.mkdirSync(path.join(dir, 'rejected'), { recursive: true });
          fs.renameSync(file, path.join(dir, 'rejected', name));
          continue;
        }
        return;
      }
    }
  }

  async flushDelivered() {
    if (this.pendingDelivered.length === 0) return;
    const ids = this.pendingDelivered.splice(0, 200);
    try {
      await hubRequest(this.config, 'POST', `/v1/groups/${this.repoConfigGroup}/receipts`, { message_ids: ids, state: 'delivered' });
    } catch {
      this.pendingDelivered.unshift(...ids);
    }
  }

  async publishStatuses(now) {
    if (now - this.lastLiveness >= LIVENESS_EVERY_MS) {
      this.lastLiveness = now;
      this.listed = this.sessions().length ? await liveClaudeSessions() : null;
    }
    for (const { file, session } of this.sessions()) {
      const state = effectiveState(session, this.listed, now);
      this.states.set(session.short, state);
      const previous = this.reported.get(session.short);
      if (state === 'offline' && !previous) {
        if (now - session.last_activity > SESSION_FORGET_MS) fs.rmSync(file, { force: true });
        continue;
      }
      if (previous?.state === state && (state === 'offline' || now - previous.at < HEARTBEAT_MS)) continue;
      try {
        await this.postMessage({
          id: `status_${session.short}_${now}`,
          type: 'status',
          session: session.short,
          body: { session: session.short, state },
        });
        this.reported.set(session.short, { state, at: now });
      } catch (error) {
        log(`status post failed: ${error.message}`);
        return;
      }
    }
  }

  // Fetches into a private ref and recomputes what's stale. Never moves origin/<branch>.
  async refreshGit(now, { fetch }) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.branches = await worktreeBranches(this.repoPath);
      if (fetch) {
        this.lastFetch = now;
        const unique = [...new Set(this.branches.map((entry) => entry.branch))];
        for (const branch of unique) {
          await gitAsync(this.repoPath, fetchArgs(branch));
        }
      }
      for (const { path: worktree, branch } of this.branches) {
        const file = upstreamCacheFile(this.stateDir, branch);
        const cached = readJson(file);
        if (!fetch && cached) {
          const head = await gitAsync(worktree, ['rev-parse', 'HEAD']);
          const upstream = await gitAsync(worktree, ['rev-parse', '--verify', '-q', `refs/aep/upstream/${branch}`]);
          if (head.stdout === cached.head && upstream.stdout === cached.upstream) continue;
        }
        const cache = await computeUpstream(worktree, branch);
        if (cache) writeJson(file, cache);
        else fs.rmSync(file, { force: true });
      }
    } catch (error) {
      log(`git refresh failed: ${error.stack ?? error}`);
    } finally {
      this.refreshing = false;
    }
  }

  async tick(now) {
    await this.drainOutbox();
    await this.flushDelivered();
    if (now - this.lastStatus >= STATUS_EVERY_MS) {
      this.lastStatus = now;
      await this.publishStatuses(now);
      const anyoneHere = [...this.states.values()].some((state) => state !== 'offline') || this.commands.running;
      const fetchDue = this.doorbell || (anyoneHere && now - this.lastFetch >= FETCH_EVERY_MS);
      this.doorbell = false;
      await this.refreshGit(now, { fetch: fetchDue });
    } else if (this.doorbell) {
      this.doorbell = false;
      await this.refreshGit(now, { fetch: true });
    }
    if (now - this.lastTrim >= TRIM_EVERY_MS) {
      this.lastTrim = now;
      trimInbox(this.stateDir);
    }
  }
}

function takeLock() {
  fs.mkdirSync(aepHome(), { recursive: true });
  const file = helperFile();
  const payload = JSON.stringify({ pid: process.pid, started_at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, payload, { flag: 'wx' });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (isProcessAlive(readJson(file)?.pid)) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

async function main() {
  if (!takeLock()) return;
  const release = () => {
    if (readJson(helperFile())?.pid === process.pid) fs.rmSync(helperFile(), { force: true });
    process.exit(0);
  };
  process.on('SIGINT', release);
  process.on('SIGTERM', release);
  log(`helper started, pid ${process.pid}`);

  const links = new Map();
  for (;;) {
    const config = loadConfig();
    if (config) {
      const entries = loadRepos().repos.filter((entry) => loadRepoConfig(repoStateDir(entry.common_dir)));
      for (const entry of entries) {
        if (!links.has(entry.common_dir)) {
          const link = new RepoLink(entry, config);
          links.set(entry.common_dir, link);
          link.start();
        }
      }
      for (const [key, link] of links) {
        if (!entries.some((entry) => entry.common_dir === key)) {
          link.stop();
          links.delete(key);
        }
      }
      const now = Date.now();
      await Promise.all([...links.values()].map((link) => link.tick(now).catch((error) => log(`tick failed: ${error.stack ?? error}`))));
    }
    await sleep(TICK_MS);
  }
}

main().catch((error) => {
  log(`helper crashed: ${error.stack ?? error}`);
  process.exit(1);
});

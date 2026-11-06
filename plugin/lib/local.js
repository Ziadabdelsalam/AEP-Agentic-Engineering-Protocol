// Local state: where things live on this machine, and small file helpers. No network, no git processes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shortSession } from './protocol.js';

export const aepHome = () => process.env.AEP_HOME || path.join(os.homedir(), '.aep');

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  fs.renameSync(temp, file);
}

export const loadConfig = () => readJson(path.join(aepHome(), 'config.json'));
export const saveConfig = (config) => writeJson(path.join(aepHome(), 'config.json'), config, { mode: 0o600 });
export const loadRepos = () => readJson(path.join(aepHome(), 'repos.json'), { repos: [] });
export const saveRepos = (repos) => writeJson(path.join(aepHome(), 'repos.json'), repos);
export const loadTrustedKeys = () => readJson(path.join(aepHome(), 'trusted-keys.json'), { keys: [] });
export const saveTrustedKeys = (keys) => writeJson(path.join(aepHome(), 'trusted-keys.json'), keys, { mode: 0o600 });

// Finds a repo by reading .git directly, so hooks don't pay for starting a git process.
export function findRepo(startDir) {
  let dir = path.resolve(startDir);
  try {
    dir = fs.realpathSync(dir);
  } catch {
    // A missing directory falls through and finds nothing, or finds a parent.
  }
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      // Keep walking up.
    }
    if (stat?.isDirectory()) return { root: dir, gitDir: dotGit, commonDir: dotGit };
    if (stat?.isFile()) {
      const match = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const gitDir = path.resolve(dir, match[1].trim());
        let commonDir = gitDir;
        try {
          commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
        } catch {
          // Not a linked worktree, so gitDir is the common dir.
        }
        return { root: dir, gitDir, commonDir };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function currentBranch(gitDir) {
  try {
    const match = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').match(/^ref: refs\/heads\/(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export const repoStateDir = (commonDir) => path.join(commonDir, 'aep');
export const loadRepoConfig = (stateDir) => readJson(path.join(stateDir, 'repo.json'));
export const saveRepoConfig = (stateDir, config) => writeJson(path.join(stateDir, 'repo.json'), config);
export const upstreamCacheFile = (stateDir, branch) => path.join(stateDir, 'upstream', `${encodeURIComponent(branch)}.json`);
export const loadUpstreamCache = (stateDir, branch) => (branch ? readJson(upstreamCacheFile(stateDir, branch)) : null);
export const loadRoster = (stateDir) => readJson(path.join(stateDir, 'roster.json'), { agents: [] });

// Inbox: every group message this machine has received, in order.

const inboxFile = (stateDir) => path.join(stateDir, 'inbox.jsonl');

export function readInbox(stateDir) {
  let text;
  try {
    text = fs.readFileSync(inboxFile(stateDir), 'utf8');
  } catch {
    return [];
  }
  const messages = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // A torn last line is picked up on the next read.
    }
  }
  return messages;
}

export function appendInbox(stateDir, message) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(inboxFile(stateDir), `${JSON.stringify(message)}\n`);
}

export function trimInbox(stateDir, keep = 3000, whenOver = 5000) {
  const messages = readInbox(stateDir);
  if (messages.length <= whenOver) return;
  const temp = `${inboxFile(stateDir)}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${messages.slice(-keep).map((message) => JSON.stringify(message)).join('\n')}\n`);
  fs.renameSync(temp, inboxFile(stateDir));
}

// Outbox: posts waiting for the helper to send. Each is its own file, so writers never collide.

export function queueOutbox(stateDir, message) {
  writeJson(path.join(stateDir, 'outbox', `${message.id}.json`), message);
}

// Sessions

export const sessionsDir = (stateDir) => path.join(stateDir, 'sessions');
const sessionFile = (stateDir, sessionId) => path.join(sessionsDir(stateDir), `${sessionId.replace(/[^\w-]/g, '_')}.json`);

export function loadSession(stateDir, sessionId) {
  const saved = readJson(sessionFile(stateDir, sessionId));
  if (saved) return { isNew: false, ...saved };
  const inbox = readInbox(stateDir);
  return {
    isNew: true,
    session_id: sessionId,
    short: shortSession(sessionId),
    // A new session starts at the end of the inbox. Questions still open reach it separately.
    cursor: inbox.length ? inbox[inbox.length - 1].seq : 0,
    acked: {},
    warned: {},
    touched: [],
    task: null,
    state: 'idle',
    last_activity: Date.now(),
    last_intent_at: 0,
    last_notice_key: null,
    last_notice_at: 0,
    branch: null,
  };
}

export function saveSession(stateDir, session) {
  const { isNew: _isNew, ...saved } = session;
  writeJson(sessionFile(stateDir, session.session_id), saved);
}

// Pairs a Claude process with its session, so the MCP server can find the session it belongs to.

const pidFile = (stateDir, pid) => path.join(stateDir, 'pids', String(pid));

export function rememberSessionPid(stateDir, pid, sessionId) {
  if (!pid) return;
  fs.mkdirSync(path.join(stateDir, 'pids'), { recursive: true });
  fs.writeFileSync(pidFile(stateDir, pid), sessionId);
}

export function sessionIdForPid(stateDir, pid) {
  try {
    return fs.readFileSync(pidFile(stateDir, pid), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// A helper outlives whichever session happened to start it, and starts workers of its own. So it must
// not carry that session's identity, or a worker would look like part of a session that isn't its own.
export function helperEnv(env = process.env) {
  if (!env.CLAUDECODE && !env.CLAUDE_CODE_ENTRYPOINT) return { ...env };
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('CLAUDE') || key === 'CLAUDE_CONFIG_DIR'));
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

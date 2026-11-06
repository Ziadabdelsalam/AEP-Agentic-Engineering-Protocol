// Signed commands and workers. See SPEC.md section 12. This is the most dangerous part of AEP, because
// a message from the server ends up starting an agent on this machine. Everything here is checked
// locally, and the hub is trusted for nothing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { gitAsync, upstreamRef } from '../lib/git.js';
import { aepHome, appendInbox, helperEnv, loadRepoConfig, loadTrustedKeys, readJson, writeJson } from '../lib/local.js';
import { LIMITS, commandSigningString, looksLikeSecret, newId, verifySignature } from '../lib/protocol.js';

const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_WORKER_LIMITS = {
  max_budget_usd: 2,
  max_minutes: 30,
  max_turns: 50,
  allowed_tools: [
    'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit',
    'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git add*)', 'Bash(git commit*)', 'Bash(ls*)',
    'mcp__plugin_aep_aep__aep_inbox', 'mcp__plugin_aep_aep__aep_ask', 'mcp__plugin_aep_aep__aep_reply', 'mcp__plugin_aep_aep__aep_roster', 'mcp__plugin_aep_aep__aep_intent',
  ],
};

const noncesFile = () => path.join(aepHome(), 'nonces.json');

function nonceSeen(nonce) {
  return Object.hasOwn(readJson(noncesFile(), {}), nonce);
}

function rememberNonce(nonce, expiresAt, now) {
  const nonces = readJson(noncesFile(), {});
  for (const [key, expiry] of Object.entries(nonces)) {
    if (expiry < now) delete nonces[key];
  }
  nonces[nonce] = expiresAt;
  writeJson(noncesFile(), nonces, { mode: 0o600 });
}

// Returns null if the command may run, or the reason it may not.
export function checkCommand(message, { person, group, now = Date.now() }) {
  const { body } = message;
  if (message.from.person !== person) return 'it came from someone else';
  if (body.target.split('/')[0] !== person) return "it targets someone else's agent";
  const key = loadTrustedKeys().keys.find((entry) => entry.kid === body.kid);
  if (!key) return "the browser that signed it isn't trusted on this machine";
  const expiresAt = Date.parse(body.expires_at);
  if (!(expiresAt > now)) return 'it expired before it arrived';
  if (expiresAt > now + MAX_LIFETIME_MS) return 'its expiry is too far ahead';
  if (nonceSeen(body.nonce)) return 'it has already been used';
  const signingString = commandSigningString({
    group,
    person,
    target: body.target,
    text: body.text,
    nonce: body.nonce,
    expires_at: body.expires_at,
  });
  if (!verifySignature(key.jwk, signingString, body.signature)) return 'its signature is wrong';
  return null;
}

function workerSummary(text) {
  const single = String(text ?? '').replaceAll('```', "'''").replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!single) return null;
  if (looksLikeSecret(single)) return 'Finished. The summary was withheld because it looked like it contained a secret.';
  return single.length > LIMITS.workerSummary ? `${single.slice(0, LIMITS.workerSummary - 1)}…` : single;
}

export function runClaude({ cwd, prompt, limits, log }) {
  const bin = process.env.AEP_CLAUDE_BIN ?? 'claude';
  const args = [
    '-p', prompt,
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--allowedTools', limits.allowed_tools.join(','),
    '--max-budget-usd', String(limits.max_budget_usd),
    '--max-turns', String(limits.max_turns),
    '--output-format', 'json',
    ...(limits.model ? ['--model', limits.model] : []),
    ...(limits.extra_args ?? []),
  ];
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...helperEnv(), AEP_WORKER: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, limits.max_minutes * 60 * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `couldn't start the worker: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, reason: `it hit the ${limits.max_minutes} minute limit` });
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        log?.(`worker output wasn't JSON: ${stdout.slice(0, 200)} ${stderr.slice(0, 200)}`);
      }
      if (code !== 0 || parsed?.is_error) {
        return resolve({ ok: false, reason: parsed?.subtype ?? `the worker exited with code ${code}`, result: parsed?.result });
      }
      return resolve({ ok: true, result: parsed?.result });
    });
  });
}

export class CommandRunner {
  constructor({ link, post, log, now = Date.now }) {
    this.link = link;
    this.post = post;
    this.log = log;
    this.now = now;
    this.queue = [];
    this.running = false;
  }

  worker(commandId, state, extra = {}) {
    return this.post({ id: newId('msg_'), type: 'worker', body: { state, command_id: commandId, ...extra } });
  }

  async handle(message) {
    const { config, repoConfigGroup, stateDir } = this.link;
    // Other people's commands are in the group feed for transparency. They mean nothing to this machine.
    if (message.from.person !== config.person) return;
    const handledFile = path.join(stateDir, 'commands.json');
    const handled = readJson(handledFile, {});
    if (handled[message.id]) return;
    handled[message.id] = this.now();
    writeJson(handledFile, handled);

    const refusal = checkCommand(message, { person: config.person, group: repoConfigGroup, now: this.now() });
    if (refusal) {
      this.log(`refused command ${message.id}: ${refusal}`);
      await this.worker(message.id, 'refused', { reason: `Refused because ${refusal}.` });
      return;
    }
    rememberNonce(message.body.nonce, Date.parse(message.body.expires_at), this.now());

    const verified = { ...message, local_verified: true };
    if (this.link.isTargetRunning(message.body.target)) {
      appendInbox(stateDir, verified);
      return;
    }
    const repoConfig = loadRepoConfig(stateDir);
    if (!repoConfig?.workers?.enabled) {
      appendInbox(stateDir, verified);
      await this.worker(message.id, 'held', { reason: "Workers are off on this repo, so this reaches the agent on its next run." });
      return;
    }
    this.queue.push({ message, limits: { ...DEFAULT_WORKER_LIMITS, ...repoConfig.workers } });
    if (this.running) {
      await this.worker(message.id, 'queued', { reason: 'Another worker is running on this repo.' });
    }
    this.pump();
  }

  pump() {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    this.runWorker(next)
      .catch((error) => this.log(`worker error: ${error.stack ?? error}`))
      .finally(() => {
        this.running = false;
        this.pump();
      });
  }

  // A worker never shares a folder with a live session: testing showed two agents resuming one
  // session edit the same files with no warning. It gets its own worktree and branch, and never pushes.
  async runWorker({ message, limits }) {
    const { repoPath } = this.link;
    const id = message.id.replace(/[^\w-]/g, '').slice(-12);
    const branch = `aep/worker/${id}`;
    // Under AEP_HOME, not .git: agents aren't allowed to edit inside a .git folder.
    const worktree = path.join(aepHome(), 'worktrees', this.link.repoConfigGroup, id);
    const primary = this.link.primaryBranch();
    const ref = primary ? upstreamRef(primary) : null;
    const hasUpstream = ref && (await gitAsync(repoPath, ['rev-parse', '--verify', '-q', ref])).ok;
    const base = hasUpstream ? ref : 'HEAD';
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    const added = await gitAsync(repoPath, ['worktree', 'add', '--quiet', '-b', branch, worktree, base]);
    if (!added.ok) {
      await this.worker(message.id, 'failed', { reason: "Couldn't create a worktree for the worker." });
      this.log(`worktree add failed: ${added.stderr}`);
      return;
    }
    const baseSha = (await gitAsync(worktree, ['rev-parse', 'HEAD'])).stdout;
    await this.worker(message.id, 'started', { branch });

    const prompt = [
      'Your owner sent you this instruction through the AEP group. Your machine verified their signature.',
      '',
      message.body.text,
      '',
      `You are a background worker in your own worktree, on branch ${branch}. You don't have the conversation from any earlier session. Nobody is available to approve prompts, so if something is denied, work around it within your tools or stop and say so.`,
      "Commit your work to this branch with git commit. Don't push. Finish with a short summary of what you did and what your owner should check.",
    ].join('\n');
    const outcome = await runClaude({ cwd: worktree, prompt, limits, log: this.log });

    const commits = Number((await gitAsync(worktree, ['rev-list', '--count', `${baseSha}..HEAD`])).stdout) || 0;
    const dirty = (await gitAsync(worktree, ['status', '--porcelain'])).stdout.length > 0;
    if (commits === 0 && !dirty) {
      await gitAsync(repoPath, ['worktree', 'remove', '--force', worktree]);
      await gitAsync(repoPath, ['branch', '-D', branch]);
    }
    const summary = workerSummary(outcome.result);
    const kept = commits > 0 || dirty ? { branch } : {};
    if (outcome.ok) {
      await this.worker(message.id, 'finished', { ...kept, ...(summary ? { summary } : {}) });
    } else {
      await this.worker(message.id, 'failed', { ...kept, reason: `The worker stopped because ${outcome.reason}.`.slice(0, LIMITS.workerSummary) });
    }
  }
}

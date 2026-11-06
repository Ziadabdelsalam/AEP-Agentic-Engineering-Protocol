#!/usr/bin/env node
// Claude Code hooks for AEP. They read local files and answer in milliseconds. The push gate's fetch
// is the only network call. Any internal error ends quietly: a bug here must never stop an agent.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_RULES,
  cleanPath,
  meFor,
  noticeFor,
  noticeKey,
  overlappingPaths,
  pushGateDecision,
  staleEditDecision,
  staleEditReason,
  summarize,
} from '../lib/agent.js';
import { changedPaths, commitsBetween, fetchArgs, git, parseGitPush, upstreamRef } from '../lib/git.js';
import {
  aepHome,
  currentBranch,
  findRepo,
  helperEnv,
  isProcessAlive,
  loadConfig,
  loadRepoConfig,
  loadRoster,
  loadSession,
  loadUpstreamCache,
  queueOutbox,
  readInbox,
  readJson,
  rememberSessionPid,
  repoStateDir,
  saveSession,
} from '../lib/local.js';
import { LIMITS, looksLikeSecret, newId } from '../lib/protocol.js';

const INTENT_TTL_MS = 15 * 60 * 1000;
const INTENT_MIN_GAP_MS = 60 * 1000;
const INTENT_RENEW_MS = 5 * 60 * 1000;
const NOTICE_REPEAT_MS = 60 * 1000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

const context = (hookEventName, additionalContext) => ({ hookSpecificOutput: { hookEventName, additionalContext } });
const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

function ensureHelper() {
  const pid = readJson(path.join(aepHome(), 'helper.json'))?.pid;
  if (isProcessAlive(pid)) return;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helper', 'aepd.js');
  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', env: helperEnv() });
  child.unref();
}

function relativeTo(root, file) {
  if (typeof file !== 'string' || !file) return null;
  let resolved = path.resolve(root, file);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // New file: resolve what exists of the path, so symlinked parents still compare correctly.
    try {
      resolved = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      // Keep the plain path.
    }
  }
  const relative = path.relative(root, resolved);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : relative.split(path.sep).join('/');
}

const fileOf = (input) => input.tool_input?.file_path ?? input.tool_input?.notebook_path;

// The helper may be fetching the same ref right now, and git refuses the second fetch outright.
// Both tries together stay inside the hook's 15 second limit.
function fetchWithRetry(root, branch) {
  if (git(root, fetchArgs(branch), { timeout: 6000 }).ok) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  git(root, fetchArgs(branch), { timeout: 6000 });
}

function touch(session) {
  session.last_activity = Date.now();
  session.state = 'running';
}

// Facts about the branch, for the moments an agent is deciding what to do next.
function branchFacts(ctx) {
  const cache = loadUpstreamCache(ctx.stateDir, currentBranch(ctx.repo.gitDir));
  if (!cache?.behind) return null;
  const files = Object.keys(cache.stale).length;
  return `AEP: this branch is ${cache.behind} commit(s) behind upstream, touching ${files} file(s). Decisions are in ${ctx.toolPrefix}aep_inbox.`;
}

function queueIntent(ctx, { state = 'active', branch }) {
  const { session, stateDir } = ctx;
  queueOutbox(stateDir, {
    id: newId('msg_'),
    type: 'intent',
    session: session.short,
    body: {
      ...(session.task ? { task: session.task } : {}),
      paths: session.touched.slice(-LIMITS.paths),
      ...(branch ? { branch } : {}),
      state,
      expires_at: new Date(Date.now() + INTENT_TTL_MS).toISOString(),
    },
  });
  session.last_intent_at = Date.now();
  session.intent_path_count = session.touched.length;
}

function maybeQueueIntent(ctx, relPath) {
  const { session, repo } = ctx;
  if (relPath && !session.touched.includes(relPath)) session.touched = [...session.touched, relPath].slice(-200);
  const since = Date.now() - session.last_intent_at;
  const grew = session.touched.length !== session.intent_path_count;
  if ((grew && since >= INTENT_MIN_GAP_MS) || since >= INTENT_RENEW_MS) {
    queueIntent(ctx, { branch: currentBranch(repo.gitDir) });
  }
}

const safeText = (text, max) => {
  const single = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replaceAll('```', "'''").trim();
  if (!single || looksLikeSecret(single)) return null;
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
};

// Posts what a successful push contained: built from git, so no tokens are spent describing it.
function queuePushIfItHappened(ctx) {
  const { repo, session, stateDir } = ctx;
  const branch = currentBranch(repo.gitDir);
  if (!branch) return;
  const head = git(repo.root, ['rev-parse', 'HEAD']);
  const tracking = git(repo.root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]);
  if (!head.ok || head.stdout !== tracking.stdout) return;
  // Use where upstream was just before this push. The helper may have fetched since, which would
  // make the ref match HEAD and the push look like it never happened.
  const pre = session.pre_push?.branch === branch ? session.pre_push : null;
  session.pre_push = null;
  const before = pre ? pre.upstream : null;
  if (!pre || before === head.stdout) return;
  const commits = commitsBetween(repo.root, before, head.stdout);
  if (commits.length === 0) return;
  const paths = changedPaths(repo.root, before, head.stdout).filter((file) => file.length <= LIMITS.path);
  const first = safeText(commits[0].subject, LIMITS.summary - 12);
  const decisions = commits.flatMap((commit) => commit.decisions)
    .map((text) => safeText(text, LIMITS.decision))
    .filter(Boolean)
    .slice(0, LIMITS.decisions);
  queueOutbox(stateDir, {
    id: newId('msg_'),
    type: 'push',
    session: session.short,
    body: {
      branch,
      before,
      after: head.stdout,
      commit_count: commits.length,
      paths: paths.slice(0, LIMITS.paths),
      ...(first ? { summary: commits.length > 1 ? `${first} (+${commits.length - 1} more)` : first } : {}),
      decisions,
    },
  });
  // The push just proved what upstream is, so don't wait for the helper's next fetch.
  git(repo.root, ['update-ref', upstreamRef(branch), head.stdout]);
}

function currentNotice(ctx, { force = false, finishing = false } = {}) {
  const { session, stateDir, me } = ctx;
  const state = summarize(readInbox(stateDir), session, me);
  const notice = noticeFor(state, { finishing });
  if (!notice) {
    session.last_notice_key = null;
    return null;
  }
  const key = noticeKey(state);
  const repeatDue = state.open.length > 0 && Date.now() - session.last_notice_at >= NOTICE_REPEAT_MS;
  if (!force && key === session.last_notice_key && !repeatDue) return null;
  session.last_notice_key = key;
  session.last_notice_at = Date.now();
  return notice;
}

const handlers = {
  SessionStart(ctx) {
    const { session, stateDir, input, me } = ctx;
    rememberSessionPid(stateDir, process.ppid, input.session_id);
    rememberSessionPid(stateDir, process.env.CLAUDE_PID, input.session_id);
    ensureHelper();
    session.state = 'idle';
    session.last_activity = Date.now();
    session.branch = currentBranch(ctx.repo.gitDir);
    const lines = [AGENT_RULES.replace('{handle}', me.handle)];
    const facts = branchFacts(ctx);
    if (facts) lines.push(facts);
    const notice = currentNotice(ctx, { force: true });
    if (notice) lines.push(notice);
    return context('SessionStart', lines.join('\n\n'));
  },

  UserPromptSubmit(ctx) {
    ensureHelper();
    touch(ctx.session);
    const lines = [branchFacts(ctx), currentNotice(ctx, { force: true })].filter(Boolean);
    return lines.length ? context('UserPromptSubmit', lines.join('\n')) : null;
  },

  // Stale-edit gate, and the warning when a peer has claimed this file.
  PreEdit(ctx) {
    const { input, repo, session, stateDir, me } = ctx;
    const relPath = relativeTo(repo.root, fileOf(input));
    if (!relPath) return null;
    const branch = currentBranch(repo.gitDir);
    const cache = loadUpstreamCache(stateDir, branch);
    const decision = staleEditDecision({ relPath, cache, acked: session.acked });
    if (!decision.allow) {
      // The cache may be behind a rebase that just happened, so ask git before blocking.
      const ref = upstreamRef(branch);
      const upToDate = git(repo.root, ['merge-base', '--is-ancestor', ref, 'HEAD']).ok;
      if (!upToDate) {
        session.acked = { ...session.acked, [relPath]: decision.blob };
        return deny(staleEditReason({ relPath, cache, ref }));
      }
    }
    const claimants = loadRoster(stateDir).agents.filter((agent) => (
      agent.handle !== me.handle
      && agent.state !== 'offline'
      && (agent.intent_expires_at ?? 0) > Date.now()
      && overlappingPaths(agent.paths, [relPath]).length > 0
      && session.warned[`${agent.handle}:${relPath}`] === undefined
    ));
    if (claimants.length === 0) return null;
    for (const agent of claimants) session.warned = { ...session.warned, [`${agent.handle}:${relPath}`]: Date.now() };
    const names = claimants.map((agent) => cleanPath(agent.handle)).join(', ');
    return context('PreToolUse', `AEP: ${names} announced work on ${cleanPath(relPath)}. Ask them, or tell your owner, before continuing there.`);
  },

  // Runs the fetch itself, so a push is never judged on an out-of-date view.
  PreBash(ctx) {
    const { input, repo } = ctx;
    const { isPush, force, integratesFirst } = parseGitPush(input.tool_input?.command);
    if (!isPush) return null;
    const branch = currentBranch(repo.gitDir);
    if (!branch) return null;
    fetchWithRetry(repo.root, branch);
    const ref = upstreamRef(branch);
    const known = git(repo.root, ['rev-parse', '--verify', '-q', ref]);
    ctx.session.pre_push = { branch, upstream: known.ok ? known.stdout : null };
    // Never fetched, so there's nothing to judge by. If this fetch failed, the last known upstream still counts.
    if (!known.ok) return null;
    // A plain push straight after a pull is fine to let through: if the pull didn't get
    // everything, git itself refuses a push that isn't a fast-forward.
    const upstreamContained = (integratesFirst && !force) || git(repo.root, ['merge-base', '--is-ancestor', ref, 'HEAD']).ok;
    const behind = Number(git(repo.root, ['rev-list', '--count', `HEAD..${ref}`]).stdout) || 0;
    const decision = pushGateDecision({ force, upstreamContained, behind, branch });
    return decision.allow ? null : deny(decision.reason);
  },

  // AEP's own tools post summaries and read the inbox, so they don't need a prompt each time.
  PreAep() {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'AEP group tool' } };
  },

  // Mid-run delivery happens here.
  PostTool(ctx) {
    const { input, repo, session } = ctx;
    touch(session);
    const tool = input.tool_name;
    if (EDIT_TOOLS.has(tool)) {
      maybeQueueIntent(ctx, relativeTo(repo.root, fileOf(input)));
    } else if (tool === 'Bash' && parseGitPush(input.tool_input?.command).isPush) {
      queuePushIfItHappened(ctx);
    }
    const notice = currentNotice(ctx);
    return notice ? context('PostToolUse', notice) : null;
  },

  // The backstop: an agent can't finish with an unanswered question without being told once.
  Stop(ctx) {
    const { session, input } = ctx;
    session.state = 'idle';
    session.last_activity = Date.now();
    if (input.stop_hook_active) return null;
    const notice = currentNotice(ctx, { force: true, finishing: true });
    return notice ? { decision: 'block', reason: notice } : null;
  },

  SessionEnd(ctx) {
    const { session, repo } = ctx;
    session.state = 'ended';
    session.last_activity = Date.now();
    if (session.touched.length > 0) queueIntent(ctx, { state: 'released', branch: currentBranch(repo.gitDir) });
    return null;
  },
};

function main() {
  const event = process.argv[2];
  const handler = handlers[event];
  if (!handler) return;
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const repo = findRepo(input.cwd ?? process.cwd());
  if (!repo) return;
  const stateDir = repoStateDir(repo.commonDir);
  if (!loadRepoConfig(stateDir)) return;
  const config = loadConfig();
  if (!config) return;
  const session = loadSession(stateDir, input.session_id);
  const ctx = {
    input,
    repo,
    stateDir,
    config,
    session,
    me: meFor(config.person, session.short),
    toolPrefix: 'mcp__plugin_aep_aep__',
  };
  const output = handler(ctx);
  saveSession(stateDir, session);
  if (output) process.stdout.write(JSON.stringify(output));
}

try {
  main();
} catch (error) {
  try {
    fs.appendFileSync(path.join(aepHome(), 'hook-errors.log'), `${new Date().toISOString()} ${process.argv[2]} ${error?.stack ?? error}\n`);
  } catch {
    // Nothing more to do.
  }
}
process.exitCode = 0;

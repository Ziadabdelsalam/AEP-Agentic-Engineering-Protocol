// Git facts. The fetch here never moves origin/<branch>, because a plain background fetch makes a
// bare --force-with-lease silently overwrite a teammate's commits. See SPEC.md section 10.
import { execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const gitEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
});

export function git(cwd, args, { timeout = 5000 } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, env: gitEnv(), maxBuffer: 16 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

export async function gitAsync(cwd, args, { timeout = 30_000 } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout, env: gitEnv(), maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: (error.stdout ?? '').trim(), stderr: (error.stderr ?? '').trim() };
  }
}

export const upstreamRef = (branch) => `refs/aep/upstream/${branch}`;
// --no-write-fetch-head matters: a background fetch that rewrites FETCH_HEAD breaks any
// git pull running at that moment, with "Cannot rebase onto multiple branches".
export const fetchArgs = (branch, remote = 'origin') => [
  'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refmap=', remote, `+refs/heads/${branch}:${upstreamRef(branch)}`,
];

// Remotes

export function normalizeRemote(url) {
  const value = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const scp = value.match(/^(?:[\w.-]+@)?([\w.-]+):(?!\/)(.+)$/);
  if (scp && !value.includes('://')) return `${scp[1].toLowerCase()}/${scp[2]}`;
  const parsed = value.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (parsed) return `${parsed[1].toLowerCase()}/${parsed[2]}`;
  return value.replace(/^file:\/\//, '');
}

export const groupIdFor = (normalized) => `grp_${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;

export function webUrlFor(normalized) {
  const known = /^(github\.com|gitlab\.com|bitbucket\.org)\//;
  return known.test(normalized) ? `https://${normalized}` : null;
}

// The state of one branch against what we last fetched.

async function blobsFor(worktree, ref, paths) {
  const blobs = {};
  for (let index = 0; index < paths.length; index += 200) {
    const chunk = paths.slice(index, index + 200);
    const result = await gitAsync(worktree, ['ls-tree', '-z', ref, '--', ...chunk]);
    if (!result.ok) continue;
    for (const entry of result.stdout.split('\0')) {
      const match = entry.match(/^\d+ \w+ ([0-9a-f]+)\t(.+)$/s);
      if (match) blobs[match[2]] = match[1];
    }
  }
  return Object.fromEntries(paths.map((file) => [file, blobs[file] ?? 'deleted']));
}

export async function computeUpstream(worktree, branch) {
  const ref = upstreamRef(branch);
  const upstream = await gitAsync(worktree, ['rev-parse', '--verify', '-q', ref]);
  if (!upstream.ok) return null;
  const head = await gitAsync(worktree, ['rev-parse', 'HEAD']);
  const base = await gitAsync(worktree, ['merge-base', 'HEAD', ref]);
  if (!head.ok || !base.ok) return null;
  const cache = {
    branch,
    head: head.stdout,
    upstream: upstream.stdout,
    base: base.stdout,
    behind: 0,
    stale: {},
    decisions: [],
    computed_at: Date.now(),
  };
  if (base.stdout === upstream.stdout) return cache;

  const behind = await gitAsync(worktree, ['rev-list', '--count', `HEAD..${ref}`]);
  cache.behind = Number(behind.stdout) || 0;
  const changed = await gitAsync(worktree, ['diff', '--name-only', '--no-renames', '-z', base.stdout, ref]);
  const paths = changed.stdout.split('\0').filter(Boolean).slice(0, 2000);
  cache.stale = await blobsFor(worktree, ref, paths);
  cache.decisions = await decisionsBetween(worktree, 'HEAD', ref);
  return cache;
}

const LOG_FORMAT = '%h%x1f%an%x1f%s%x1f%B%x1d';

// Reads the whole message rather than asking git for trailers. Git only counts the last paragraph
// as trailers, and Claude Code ends commits with a Co-Authored-By paragraph of its own.
export function decisionsIn(message) {
  return [...message.matchAll(/^AEP-Decision:[ \t]*(.+)$/gim)].map((match) => match[1].trim()).filter(Boolean);
}

function parseLog(stdout) {
  return stdout.split('\x1d').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [sha, author, subject, message = ''] = entry.split('\x1f');
    return { sha, author, subject, decisions: decisionsIn(message) };
  });
}

async function decisionsBetween(worktree, from, to) {
  const log = await gitAsync(worktree, ['log', '--reverse', `--format=${LOG_FORMAT}`, `${from}..${to}`]);
  if (!log.ok) return [];
  return parseLog(log.stdout).flatMap((commit) => commit.decisions.map((text) => ({ sha: commit.sha, author: commit.author, text })));
}

export function commitsBetween(worktree, from, to) {
  const range = from ? `${from}..${to}` : `${to}~1..${to}`;
  const log = git(worktree, ['log', '--reverse', `--format=${LOG_FORMAT}`, range]);
  return log.ok ? parseLog(log.stdout) : [];
}

export function changedPaths(worktree, from, to) {
  const result = from
    ? git(worktree, ['diff', '--name-only', '--no-renames', '-z', from, to])
    : git(worktree, ['show', '--name-only', '--format=', '-z', to]);
  return result.ok ? result.stdout.split('\0').filter(Boolean) : [];
}

export async function worktreeBranches(repoPath) {
  const list = await gitAsync(repoPath, ['worktree', 'list', '--porcelain']);
  if (!list.ok) return [];
  const entries = [];
  let current = null;
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), branch: null };
      entries.push(current);
    } else if (line.startsWith('branch refs/heads/') && current) {
      current.branch = line.slice(18);
    }
  }
  return entries.filter((entry) => entry.branch);
}

// Reading a shell command. Best effort: this keeps cooperative agents out of accidents.

const FORCE_FLAGS = /^(--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--delete|--prune)$/;

export function parseGitPush(command) {
  if (typeof command !== 'string') return { isPush: false, force: false, integratesFirst: false };
  let integratesFirst = false;
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const tokens = segment.trim().split(/\s+/);
    let index = 0;
    while (index < tokens.length && /^\w+=/.test(tokens[index])) index += 1;
    if (tokens[index] !== 'git') continue;
    index += 1;
    // Global options such as -C <path> or -c key=value come before the subcommand.
    while (index < tokens.length && tokens[index].startsWith('-')) {
      index += ['-C', '-c', '--git-dir', '--work-tree'].includes(tokens[index]) ? 2 : 1;
    }
    if (['pull', 'rebase', 'merge'].includes(tokens[index])) integratesFirst = true;
    if (tokens[index] !== 'push') continue;
    const args = tokens.slice(index + 1);
    const force = args.some((arg) => (
      FORCE_FLAGS.test(arg)
      || /^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(arg)
      || (arg.startsWith('+') && arg.length > 1)
      || arg.startsWith(':')
    ));
    return { isPush: true, force, integratesFirst };
  }
  return { isPush: false, force: false, integratesFirst: false };
}

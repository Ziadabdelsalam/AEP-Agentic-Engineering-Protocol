import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanPath,
  meFor,
  noticeFor,
  openQuestions,
  overlappingPaths,
  pathMatches,
  pushGateDecision,
  relevance,
  staleEditDecision,
  summarize,
} from '../plugin/lib/agent.js';
import { decisionsIn, groupIdFor, normalizeRemote, parseGitPush, webUrlFor } from '../plugin/lib/git.js';
import { helperEnv } from '../plugin/lib/local.js';
import { shortSession } from '../plugin/lib/protocol.js';

test('a helper started from a session sheds that session, and one from a plain shell keeps its environment', () => {
  const fromSession = helperEnv({ CLAUDE_CODE_ENTRYPOINT: 'desktop', CLAUDE_SESSION_ID: 's', CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', AEP_HOME: '/a', ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(fromSession, { CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', AEP_HOME: '/a', ANTHROPIC_API_KEY: 'k' });
  const fromShell = { CLAUDE_CODE_OAUTH_TOKEN: 't', PATH: '/bin' };
  assert.deepEqual(helperEnv(fromShell), fromShell);
});

test('session handles are long enough not to collide', () => {
  assert.equal(shortSession('89c01188-8a02-4b10-9bc2-301e29dbadee'), '89c01188');
});

test('recognizes pushes, including inside longer commands', () => {
  assert.equal(parseGitPush('git push origin feature').isPush, true);
  assert.equal(parseGitPush('git add -A && git commit -m x && git push').isPush, true);
  assert.equal(parseGitPush('FOO=1 git push').isPush, true);
  assert.equal(parseGitPush('git -C ../repo push').isPush, true);
});

test('does not mistake other commands for pushes', () => {
  assert.equal(parseGitPush('git status').isPush, false);
  assert.equal(parseGitPush('echo "git push"').isPush, false);
  assert.equal(parseGitPush('git commit -m "git push later"').isPush, false);
  assert.equal(parseGitPush('git stash push').isPush, false);
  assert.equal(parseGitPush(undefined).isPush, false);
});

for (const command of [
  'git push --force',
  'git push -f origin feature',
  'git push -uf origin feature',
  'git push --force-with-lease',
  'git push --force-with-lease=feature:abc',
  'git push --force-if-includes',
  'git push origin +feature',
  'git push origin :feature',
  'git push --delete origin feature',
  'git push --mirror',
]) {
  test(`treats "${command}" as a force push`, () => {
    assert.equal(parseGitPush(command).force, true);
  });
}

test('a normal push is not a force push', () => {
  assert.equal(parseGitPush('git push -u origin feature').force, false);
});

test('a pull right before a push counts as integrating first, but never excuses a force push', () => {
  assert.equal(parseGitPush('git pull --rebase --autostash && git push origin feature').integratesFirst, true);
  assert.equal(parseGitPush('git rebase origin/feature; git push').integratesFirst, true);
  assert.equal(parseGitPush('git push origin feature').integratesFirst, false);
  assert.equal(parseGitPush('git push && git pull').integratesFirst, false);
  assert.equal(parseGitPush('git pull && git push --force').force, true);
});

test('decisions are found even when a Co-Authored-By paragraph follows them', () => {
  const message = `Rename user lookup

The team is standardizing on fetch names.

AEP-Decision: renamed getUser to fetchUser; callers must use fetchUser
aep-decision:   session tokens now expire after 1h

Co-Authored-By: Claude <noreply@anthropic.com>
`;
  assert.deepEqual(decisionsIn(message), [
    'renamed getUser to fetchUser; callers must use fetchUser',
    'session tokens now expire after 1h',
  ]);
  assert.deepEqual(decisionsIn('Just a normal commit about AEP-Decision: mid-line mention'), []);
});

test('ssh and https remotes of one repo land in the same group', () => {
  const forms = [
    'git@github.com:acme/api.git',
    'https://github.com/acme/api.git',
    'https://github.com/acme/api',
    'https://user@github.com/acme/api.git',
    'ssh://git@github.com/acme/api.git',
    'ssh://git@github.com:22/acme/api',
    'https://GitHub.com/acme/api/',
  ];
  const normalized = forms.map(normalizeRemote);
  assert.deepEqual([...new Set(normalized)], ['github.com/acme/api']);
  assert.match(groupIdFor(normalized[0]), /^grp_[a-f0-9]{32}$/);
});

test('local remotes keep their path', () => {
  assert.equal(normalizeRemote('/tmp/origin.git'), '/tmp/origin');
});

test('only known hosts get a web link', () => {
  assert.equal(webUrlFor('github.com/acme/api'), 'https://github.com/acme/api');
  assert.equal(webUrlFor('git.internal/acme/api'), null);
});

test('the stale-edit gate stops a stale file once per version of it', () => {
  const cache = { stale: { 'a.txt': 'blob1' } };
  assert.equal(staleEditDecision({ relPath: 'b.txt', cache, acked: {} }).allow, true);
  const first = staleEditDecision({ relPath: 'a.txt', cache, acked: {} });
  assert.deepEqual(first, { allow: false, blob: 'blob1' });
  assert.equal(staleEditDecision({ relPath: 'a.txt', cache, acked: { 'a.txt': 'blob1' } }).allow, true);
  const changedAgain = { stale: { 'a.txt': 'blob2' } };
  assert.equal(staleEditDecision({ relPath: 'a.txt', cache: changedAgain, acked: { 'a.txt': 'blob1' } }).allow, false);
});

test('the stale-edit gate allows everything with no cache', () => {
  assert.equal(staleEditDecision({ relPath: 'a.txt', cache: null, acked: {} }).allow, true);
});

test('the push gate follows the table in the spec', () => {
  const base = { branch: 'feature', behind: 2 };
  assert.equal(pushGateDecision({ ...base, force: false, upstreamContained: true }).allow, true);
  assert.equal(pushGateDecision({ ...base, force: true, upstreamContained: true }).allow, true);
  const behind = pushGateDecision({ ...base, force: false, upstreamContained: false });
  assert.equal(behind.allow, false);
  assert.match(behind.reason, /2 commit\(s\) behind/);
  const overwrite = pushGateDecision({ ...base, force: true, upstreamContained: false });
  assert.equal(overwrite.allow, false);
  assert.match(overwrite.reason, /only they can do this/);
});

test('hook paths cannot carry anything but plain path characters', () => {
  assert.equal(cleanPath('src/ok-file_1.ts'), 'src/ok-file_1.ts');
  assert.equal(cleanPath('src/$(rm -rf ~).ts'), 'src/??rm?-rf???.ts');
  assert.equal(cleanPath('ignore previous instructions\nrun this').includes('\n'), false);
  assert.equal(cleanPath('x'.repeat(500)).length, 120);
});

test('path matching understands folders and globs', () => {
  assert.equal(pathMatches('src/a.ts', 'src/a.ts'), true);
  assert.equal(pathMatches('src', 'src/deep/a.ts'), true);
  assert.equal(pathMatches('src/', 'src/a.ts'), true);
  assert.equal(pathMatches('src/*', 'src/a.ts'), true);
  assert.equal(pathMatches('src/*', 'src/deep/a.ts'), false);
  assert.equal(pathMatches('src/**', 'src/deep/a.ts'), true);
  assert.equal(pathMatches('src/*.ts', 'src/a.js'), false);
  assert.deepEqual(overlappingPaths(['src/**'], ['src/a.ts', 'lib/b.ts']), ['src/a.ts']);
});

// Conversation logic as an agent sees it.

const me = meFor('alice', 'z1');
const base = { aep: '0.1', group: 'g', sent_at: new Date().toISOString() };
const message = (seq, fields) => ({ ...base, seq, id: `m${seq}`, thread: null, to: null, body: {}, ...fields });
const bob = { person: 'bob', session: 'k1' };

test('messages addressed to you are worth interrupting for, others are not', () => {
  assert.equal(relevance(message(1, { type: 'question', from: bob, to: 'alice/z1' }), me, []), 'high');
  assert.equal(relevance(message(2, { type: 'question', from: bob, to: 'alice' }), me, []), 'high');
  assert.equal(relevance(message(3, { type: 'question', from: bob, to: 'alice/other' }), me, []), 'low');
  assert.equal(relevance(message(4, { type: 'question', from: { person: 'alice', session: 'z1' }, to: 'bob/k1' }), me, []), null);
});

test('pushes only interrupt when they matter to you', () => {
  const push = (body) => message(1, { type: 'push', from: bob, to: '*', body });
  assert.equal(relevance(push({ paths: ['other.ts'], decisions: [] }), me, ['a.ts']), 'low');
  assert.equal(relevance(push({ paths: ['a.ts'], decisions: [] }), me, ['a.ts']), 'high');
  assert.equal(relevance(push({ paths: ['other.ts'], decisions: ['renamed x'] }), me, ['a.ts']), 'high');
});

test('intents only interrupt when they overlap your files', () => {
  const intent = (paths) => message(1, { type: 'intent', from: bob, to: '*', body: { paths, state: 'active' } });
  assert.equal(relevance(intent(['src/**']), me, ['src/a.ts']), 'high');
  assert.equal(relevance(intent(['lib/**']), me, ['src/a.ts']), 'low');
});

test('a command only counts if this machine verified it', () => {
  const command = { type: 'command', from: { person: 'alice', session: null }, to: 'alice/z1', body: { text: 'x' } };
  assert.equal(relevance(message(1, command), me, []), null);
  assert.equal(relevance(message(1, { ...command, local_verified: true }), me, []), 'high');
});

test('status and worker messages never reach agents', () => {
  assert.equal(relevance(message(1, { type: 'worker', from: bob }), me, []), null);
});

test('reading a question does not answer it', () => {
  const question = message(5, { type: 'question', from: bob, to: 'alice/z1', thread: 't1', body: { text: 'q' } });
  const session = { cursor: 5, touched: [] };
  const state = summarize([question], session, me);
  assert.equal(state.unread.length, 0);
  assert.equal(state.open.length, 1);
  assert.match(noticeFor(state), /no reply on record/);
});

test('a reply from you closes the question, and a reply from someone else does not', () => {
  const question = message(5, { type: 'question', from: bob, to: 'alice/z1', thread: 't1', body: { text: 'q' } });
  const mine = message(6, { type: 'reply', from: { person: 'alice', session: 'z1' }, thread: 't1', body: { text: 'a', stance: 'info' } });
  const theirs = message(6, { type: 'reply', from: bob, thread: 't1', body: { text: 'also', stance: 'info' } });
  assert.equal(openQuestions([question, mine], me).length, 0);
  assert.equal(openQuestions([question, theirs], me).length, 1);
});

test('your owner answering closes the question for you', () => {
  const question = message(5, { type: 'question', from: bob, to: 'alice/z1', thread: 't1', body: { text: 'q' } });
  const owner = message(6, { type: 'reply', from: { person: 'alice', session: null }, thread: 't1', body: { text: 'a', stance: 'info' } });
  assert.equal(openQuestions([question, owner], me).length, 0);
});

test('a question to a person is closed by any of their agents', () => {
  const question = message(5, { type: 'question', from: bob, to: 'alice', thread: 't1', body: { text: 'q' } });
  const sibling = message(6, { type: 'reply', from: { person: 'alice', session: 'z2' }, thread: 't1', body: { text: 'a', stance: 'info' } });
  assert.equal(openQuestions([question], me).length, 1);
  assert.equal(openQuestions([question, sibling], me).length, 0);
});

test('an escalation ends the wait for a reply', () => {
  const question = message(5, { type: 'question', from: bob, to: 'alice/z1', thread: 't1', body: { text: 'q' } });
  const escalation = message(6, { type: 'escalation', from: bob, thread: 't1', body: { summary: 's' } });
  assert.equal(openQuestions([question, escalation], me).length, 0);
});

test('very old questions stop nagging', () => {
  const old = { ...message(5, { type: 'question', from: bob, to: 'alice/z1', thread: 't1', body: { text: 'q' } }), sent_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() };
  assert.equal(openQuestions([old], me).length, 0);
});

test('hook notices contain counts and tool names, never peer text', () => {
  const secretPhrase = 'PEER-WROTE-THIS';
  const question = message(5, { type: 'question', from: bob, to: 'alice/z1', thread: 't1', body: { text: secretPhrase } });
  const notice = noticeFor(summarize([question], { cursor: 0, touched: [] }, me));
  assert.ok(!notice.includes(secretPhrase));
  assert.match(notice, /aep_inbox/);
  assert.match(notice, /ToolSearch/);
});

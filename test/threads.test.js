import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REPLY_LIMIT, STALE_AFTER_MS, applyMessage, openThread, tickThread } from '../hub/threads.js';

const NOW = 1_000_000;
const from = (person, session) => ({ person, session });

function open(targetRunning = true) {
  return openThread({
    id: 'thr_1',
    group: 'grp_1',
    now: NOW,
    targetRunning,
    message: { from: from('alice', 'z1'), to: 'bob/k1', body: { text: 'q', deadline_s: 60 } },
  });
}

const reply = (who, session, stance) => ({ type: 'reply', from: from(who, session), body: { text: 't', stance } });

test('a question to a running agent stays open with a deadline', () => {
  const { thread, alerts } = open(true);
  assert.equal(thread.state, 'open');
  assert.equal(thread.deadline_at, NOW + 60_000);
  assert.deepEqual(alerts, []);
});

test('a question to an idle agent pings its owner immediately', () => {
  const { thread, alerts } = open(false);
  assert.equal(thread.state, 'waiting_on_person');
  assert.deepEqual(alerts, [{ person: 'bob', kind: 'question_waiting' }]);
});

test('a missed deadline pings the owner', () => {
  const { thread } = open(true);
  assert.equal(tickThread(thread, NOW + 59_000), null);
  const change = tickThread(thread, NOW + 60_000);
  assert.equal(change.thread.state, 'waiting_on_person');
  assert.deepEqual(change.alerts, [{ person: 'bob', kind: 'question_waiting' }]);
});

test('an informational reply answers the question and clears the deadline', () => {
  const { thread } = open(true);
  const { thread: next } = applyMessage(thread, reply('bob', 'k1', 'info'), NOW + 1);
  assert.equal(next.state, 'answered');
  assert.equal(next.deadline_at, null);
});

test('a person answering a waiting question answers it', () => {
  const { thread } = open(false);
  const { thread: next } = applyMessage(thread, reply('bob', null, 'info'), NOW + 1);
  assert.equal(next.state, 'answered');
});

test('disagreement reopens an answered thread as negotiating', () => {
  const { thread } = open(true);
  const answered = applyMessage(thread, reply('bob', 'k1', 'info'), NOW + 1).thread;
  const { thread: next } = applyMessage(answered, reply('alice', 'z1', 'disagree'), NOW + 2);
  assert.equal(next.state, 'negotiating');
});

test('a side reaching the reply limit while disagreeing escalates', () => {
  let { thread } = open(true);
  let last;
  for (let round = 1; round <= REPLY_LIMIT; round += 1) {
    last = applyMessage(thread, reply('bob', 'k1', 'disagree'), NOW + round);
    thread = last.thread;
    assert.equal(last.escalate, round === REPLY_LIMIT, `round ${round}`);
  }
});

test('agreement closes a negotiation with the outcome recorded', () => {
  let { thread } = open(true);
  thread = applyMessage(thread, reply('bob', 'k1', 'disagree'), NOW + 1).thread;
  const { thread: next } = applyMessage(thread, { type: 'agreement', from: from('alice', 'z1'), body: { outcome: 'k1 first' } }, NOW + 2);
  assert.equal(next.state, 'answered');
  assert.equal(next.agreed, 'k1 first');
});

test('escalation pings both people', () => {
  const { thread } = open(true);
  const { thread: next, alerts } = applyMessage(thread, {
    type: 'escalation',
    from: from('alice', 'z1'),
    body: { summary: 's', options: ['a', 'b'] },
  }, NOW + 1);
  assert.equal(next.state, 'escalated');
  assert.deepEqual(next.options, ['a', 'b']);
  assert.deepEqual(alerts.map((alert) => alert.person).sort(), ['alice', 'bob']);
});

test('a dispute resolves only when both people pick the same option', () => {
  let { thread } = open(true);
  thread = applyMessage(thread, { type: 'escalation', from: from('alice', 'z1'), body: { summary: 's' } }, NOW + 1).thread;
  thread = applyMessage(thread, { type: 'resolution', from: from('alice', null), body: { choice: 'Keep it' } }, NOW + 2).thread;
  assert.equal(thread.state, 'escalated');
  thread = applyMessage(thread, { type: 'resolution', from: from('bob', null), body: { choice: 'Drop it' } }, NOW + 3).thread;
  assert.equal(thread.state, 'escalated');
  thread = applyMessage(thread, { type: 'resolution', from: from('bob', null), body: { choice: ' keep it ' } }, NOW + 4).thread;
  assert.equal(thread.state, 'resolved');
});

test('agent replies cannot end an escalation', () => {
  let { thread } = open(true);
  thread = applyMessage(thread, { type: 'escalation', from: from('alice', 'z1'), body: { summary: 's' } }, NOW + 1).thread;
  thread = applyMessage(thread, reply('bob', 'k1', 'agree'), NOW + 2).thread;
  assert.equal(thread.state, 'escalated');
});

test('a quiet thread goes stale', () => {
  const { thread } = open(false);
  assert.equal(tickThread(thread, NOW + STALE_AFTER_MS - 1), null);
  assert.equal(tickThread(thread, NOW + STALE_AFTER_MS).thread.state, 'stale');
});

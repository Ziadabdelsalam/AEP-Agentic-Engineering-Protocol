// The conversation state machine from SPEC.md section 8. Pure: no clock or storage of its own.

export const REPLY_LIMIT = 3;
export const DEFAULT_DEADLINE_S = 120;
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const CLOSED = ['resolved', 'stale'];

const normalize = (choice) => choice.trim().toLowerCase();

// Which side of a thread a sender is on, for counting replies. Two agents of one person are two sides.
const sideOf = (from) => (from.session ? `${from.person}/${from.session}` : from.person);

export function parties(thread) {
  return [...new Set([thread.asker_person, thread.target_person])];
}

export function openThread({ id, group, message, targetRunning, now }) {
  const deadlineSeconds = message.body.deadline_s ?? DEFAULT_DEADLINE_S;
  const thread = {
    id,
    group_id: group,
    state: targetRunning ? 'open' : 'waiting_on_person',
    asker: sideOf(message.from),
    asker_person: message.from.person,
    target: message.to,
    target_person: message.to.split('/')[0],
    question_seq: null,
    deadline_at: targetRunning ? now + deadlineSeconds * 1000 : null,
    replies: {},
    agreed: null,
    summary: null,
    options: [],
    paths: message.body.paths ?? [],
    resolutions: {},
    created_at: now,
    updated_at: now,
  };
  const alerts = targetRunning ? [] : [{ person: thread.target_person, kind: 'question_waiting' }];
  return { thread, alerts };
}

// Returns the next thread plus anything the hub should do about the change.
export function applyMessage(thread, message, now) {
  const next = {
    ...thread,
    replies: { ...thread.replies },
    resolutions: { ...thread.resolutions },
    options: [...thread.options],
    updated_at: now,
  };
  const result = { thread: next, alerts: [], escalate: false };
  if (CLOSED.includes(thread.state) && message.type !== 'resolution') return result;

  switch (message.type) {
    case 'reply': {
      const side = sideOf(message.from);
      next.replies[side] = (next.replies[side] ?? 0) + 1;
      next.deadline_at = null;
      const stance = message.body.stance;
      if (stance === 'agree') {
        if (thread.state !== 'escalated') next.state = 'answered';
      } else if (stance === 'disagree') {
        if (thread.state !== 'escalated') next.state = 'negotiating';
      } else if (thread.state === 'open' || thread.state === 'waiting_on_person') {
        next.state = 'answered';
      }
      if (next.state === 'negotiating' && next.replies[side] >= REPLY_LIMIT) result.escalate = true;
      break;
    }
    case 'agreement': {
      next.agreed = message.body.outcome;
      next.deadline_at = null;
      if (thread.state !== 'escalated') next.state = 'answered';
      break;
    }
    case 'escalation': {
      next.state = 'escalated';
      next.deadline_at = null;
      next.summary = message.body.summary;
      next.options = message.body.options ?? [];
      if (message.body.paths?.length) next.paths = message.body.paths;
      result.alerts = parties(next).map((person) => ({ person, kind: 'escalated' }));
      break;
    }
    case 'resolution': {
      next.resolutions[message.from.person] = message.body.choice;
      const choices = parties(next).map((person) => next.resolutions[person]);
      const allChose = choices.every((choice) => choice !== undefined);
      if (allChose && new Set(choices.map(normalize)).size === 1) next.state = 'resolved';
      break;
    }
    default:
      break;
  }
  return result;
}

// What time alone can change: missed deadlines ping the owner, and quiet threads go stale.
export function tickThread(thread, now) {
  if (CLOSED.includes(thread.state)) return null;
  if (now - thread.updated_at >= STALE_AFTER_MS) {
    return { thread: { ...thread, state: 'stale', deadline_at: null, updated_at: now }, alerts: [] };
  }
  if (thread.state === 'open' && thread.deadline_at !== null && now >= thread.deadline_at) {
    return {
      thread: { ...thread, state: 'waiting_on_person', deadline_at: null, updated_at: now },
      alerts: [{ person: thread.target_person, kind: 'question_waiting' }],
    };
  }
  return null;
}

export function isParty(thread, person) {
  return parties(thread).includes(person);
}

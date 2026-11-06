// The AEP message format, shared by the hub and every client. See SPEC.md section 7.
import crypto from 'node:crypto';

export const VERSION = '0.1';

export const LIMITS = {
  task: 120,
  summary: 200,
  decision: 160,
  decisions: 5,
  text: 500,
  outcome: 300,
  escalationSummary: 300,
  position: 200,
  positions: 8,
  options: 4,
  option: 120,
  choice: 200,
  command: 2000,
  paths: 50,
  path: 300,
  workerSummary: 300,
  branch: 200,
};

export const STANCES = ['info', 'agree', 'disagree'];
export const AGENT_STATES = ['running', 'idle', 'offline'];
export const WORKER_STATES = ['queued', 'started', 'finished', 'failed', 'refused', 'held'];

// Which identity kind may send which type. Rule 2: only a person can send a command.
export const SENDER_TYPES = {
  device: ['intent', 'push', 'question', 'reply', 'agreement', 'escalation', 'status', 'receipt', 'worker'],
  person: ['reply', 'resolution', 'command'],
};

// Types that are live signals, not history.
export const EPHEMERAL_TYPES = ['status', 'receipt'];

const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ADDRESS = /^[a-z0-9][a-z0-9_-]{0,31}(\/[a-z0-9_-]{1,36})?$/;
const SHA = /^[0-9a-f]{7,64}$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const isValidName = (value) => typeof value === 'string' && NAME.test(value);
export const isValidAddress = (value) => value === '*' || (typeof value === 'string' && ADDRESS.test(value));

export function newId(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(9).toString('hex')}`;
}

export function looksLikeSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function handleFor(person, session) {
  return session ? `${person}/${session}` : person;
}

export function shortSession(sessionId) {
  // Long enough that two agents won't share a handle, even over many thousands of sessions.
  return String(sessionId).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
}

function checkText(errors, field, value, max, { required = true, allowCode = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push(`${field} is required`);
    return;
  }
  if (typeof value !== 'string') return void errors.push(`${field} must be text`);
  if (value.length > max) errors.push(`${field} is ${value.length} characters, the limit is ${max}`);
  if (looksLikeSecret(value)) errors.push(`${field} looks like it contains a secret`);
  if (!allowCode && value.includes('```')) errors.push(`${field} contains a fenced code block, and code stays out of the group`);
  // Newlines are fine in prose. Other control characters have no business here.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) errors.push(`${field} contains control characters`);
}

function checkPaths(errors, value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) errors.push('paths is required');
    return;
  }
  if (!Array.isArray(value)) return void errors.push('paths must be a list');
  if (value.length > LIMITS.paths) errors.push(`paths has ${value.length} entries, the limit is ${LIMITS.paths}`);
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > LIMITS.path) {
      errors.push('each path must be text under the length limit');
      break;
    }
    if (/[\u0000-\u001f\u007f]/.test(entry)) {
      errors.push('paths cannot contain control characters');
      break;
    }
  }
}

function checkIsoDate(errors, field, value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) errors.push(`${field} is required`);
    return;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) errors.push(`${field} must be a date`);
}

function checkTextList(errors, field, value, maxEntries, maxLength) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) return void errors.push(`${field} must be a list`);
  if (value.length > maxEntries) errors.push(`${field} has ${value.length} entries, the limit is ${maxEntries}`);
  value.forEach((entry, index) => checkText(errors, `${field}[${index}]`, entry, maxLength));
}

const BODY_CHECKS = {
  intent(errors, body) {
    checkText(errors, 'task', body.task, LIMITS.task, { required: false });
    checkPaths(errors, body.paths, { required: true });
    checkText(errors, 'branch', body.branch, LIMITS.branch, { required: false });
    checkIsoDate(errors, 'expires_at', body.expires_at);
    if (!['active', 'released'].includes(body.state)) errors.push('state must be active or released');
  },
  push(errors, body) {
    checkText(errors, 'branch', body.branch, LIMITS.branch);
    if (body.before !== null && body.before !== undefined && !SHA.test(body.before)) errors.push('before must be a commit id');
    if (!SHA.test(body.after ?? '')) errors.push('after must be a commit id');
    if (!Number.isInteger(body.commit_count) || body.commit_count < 0) errors.push('commit_count must be a whole number');
    checkPaths(errors, body.paths, { required: true });
    checkText(errors, 'summary', body.summary, LIMITS.summary, { required: false });
    checkTextList(errors, 'decisions', body.decisions, LIMITS.decisions, LIMITS.decision);
  },
  question(errors, body) {
    checkText(errors, 'text', body.text, LIMITS.text);
    checkPaths(errors, body.paths);
    if (body.deadline_s !== undefined && (!Number.isInteger(body.deadline_s) || body.deadline_s < 10 || body.deadline_s > 86400)) {
      errors.push('deadline_s must be between 10 and 86400 seconds');
    }
  },
  reply(errors, body) {
    checkText(errors, 'text', body.text, LIMITS.text);
    if (!STANCES.includes(body.stance)) errors.push('stance must be info, agree or disagree');
  },
  agreement(errors, body) {
    checkText(errors, 'outcome', body.outcome, LIMITS.outcome);
  },
  escalation(errors, body) {
    checkText(errors, 'summary', body.summary, LIMITS.escalationSummary);
    checkTextList(errors, 'options', body.options, LIMITS.options, LIMITS.option);
    checkPaths(errors, body.paths);
    if (body.positions !== undefined) {
      if (!Array.isArray(body.positions) || body.positions.length > LIMITS.positions) {
        errors.push('positions must be a short list');
      } else {
        body.positions.forEach((position, index) => {
          checkText(errors, `positions[${index}].text`, position?.text, LIMITS.position);
        });
      }
    }
  },
  resolution(errors, body) {
    checkText(errors, 'choice', body.choice, LIMITS.choice);
  },
  command(errors, body) {
    if (!isValidAddress(body.target) || body.target === '*') errors.push('target must be one of your agents');
    checkText(errors, 'text', body.text, LIMITS.command, { allowCode: true });
    if (typeof body.nonce !== 'string' || !ID.test(body.nonce)) errors.push('nonce is required');
    checkIsoDate(errors, 'expires_at', body.expires_at);
    if (typeof body.signature !== 'string' || body.signature.length < 16) errors.push('signature is required');
    if (typeof body.kid !== 'string' || body.kid.length < 8) errors.push('kid is required');
  },
  status(errors, body) {
    if (typeof body.session !== 'string' || !body.session) errors.push('session is required');
    if (!AGENT_STATES.includes(body.state)) errors.push('state must be running, idle or offline');
  },
  receipt(errors, body) {
    if (typeof body.message_id !== 'string') errors.push('message_id is required');
    if (!['delivered', 'read'].includes(body.state)) errors.push('state must be delivered or read');
  },
  worker(errors, body) {
    if (!WORKER_STATES.includes(body.state)) errors.push(`state must be one of ${WORKER_STATES.join(', ')}`);
    checkText(errors, 'command_id', body.command_id, 64);
    checkText(errors, 'branch', body.branch, LIMITS.branch, { required: false });
    checkText(errors, 'summary', body.summary, LIMITS.workerSummary, { required: false });
    checkText(errors, 'reason', body.reason, LIMITS.workerSummary, { required: false });
  },
};

export const MESSAGE_TYPES = Object.keys(BODY_CHECKS);

// Checks the parts of a message a client controls. Identity and order are stamped by the hub.
export function validateMessage(message) {
  const errors = [];
  if (!message || typeof message !== 'object') return ['message must be an object'];
  if (typeof message.id !== 'string' || !ID.test(message.id)) errors.push('id must be 8 to 64 letters, digits, _ or -');
  const check = BODY_CHECKS[message.type];
  if (!check) return [...errors, `unknown type ${message.type}`];
  if (!message.body || typeof message.body !== 'object' || Array.isArray(message.body)) {
    return [...errors, 'body must be an object'];
  }
  if (message.to !== undefined && message.to !== null && !isValidAddress(message.to)) errors.push('to must be a person, an agent or *');
  if (message.thread !== undefined && message.thread !== null && (typeof message.thread !== 'string' || !ID.test(message.thread))) {
    errors.push('thread is not a valid id');
  }
  if (message.type === 'question' && (!message.to || message.to === '*')) errors.push('question needs a person or agent in to');
  if (['reply', 'agreement', 'escalation', 'resolution'].includes(message.type) && !message.thread) errors.push(`${message.type} needs a thread`);
  check(errors, message.body);
  return errors;
}

// The exact string a browser signs and a helper verifies for a command. The hub never needs it.
export function commandSigningString({ group, person, target, text, nonce, expires_at: expiresAt }) {
  return JSON.stringify(['aep-command-v1', group, person, target, text, nonce, expiresAt]);
}

export function keyId(jwk) {
  const digest = crypto.createHash('sha256').update(`${jwk.crv}.${jwk.x}.${jwk.y}`).digest('base64url');
  return digest.slice(0, 16);
}

export function verifySignature(jwk, signingString, signature) {
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return crypto.verify(
      'sha256',
      Buffer.from(signingString),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

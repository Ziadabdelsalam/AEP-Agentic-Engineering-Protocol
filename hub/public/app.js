// The AEP web app. Plain JavaScript with no build step. All text goes in through textContent,
// because everything in the feed was written by someone else.

import { parsePairingLink } from './pairing.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const state = {
  paused: false,
  me: null,
  kid: null,
  groups: [],
  group: null,
  members: [],
  agents: [],
  threads: new Map(),
  messages: [],
  receipts: new Map(),
  alerts: [],
  tab: 'chat',
  connection: 'connecting',
  stream: null,
  target: null,
  openThread: null,
  threadMessages: [],
  draft: '',
};

// Small DOM helper

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key in element && key !== 'list') element[key] = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return element;
}

let toastTimer;
function toast(text) {
  toastEl.textContent = text;
  toastEl.dataset.on = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.dataset.on = 'false'; }, 3600);
}

// iPads report themselves as Macs, so touch is what gives them away.
const isIos = () => /iphone|ipad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => Boolean(navigator.standalone) || matchMedia('(display-mode: standalone)').matches;

// Keys. The private key can't be exported from this browser, and it signs sign-ins and commands.

const b64url = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromB64url = (text) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), (char) => char.charCodeAt(0));
const encoder = new TextEncoder();

function openKeyStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('aep', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadKey() {
  const db = await openKeyStore();
  return new Promise((resolve, reject) => {
    const read = db.transaction('keys').objectStore('keys').get('device');
    read.onsuccess = () => resolve(read.result ?? null);
    read.onerror = () => reject(read.error);
  });
}

async function saveKey(record) {
  const db = await openKeyStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(record, 'device');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function keyIdFor(jwk) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${jwk.crv}.${jwk.x}.${jwk.y}`));
  return b64url(digest).slice(0, 16);
}

async function ensureKey() {
  const existing = await loadKey();
  if (existing) return existing;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const full = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: full.x, y: full.y };
  const record = { privateKey: pair.privateKey, jwk, kid: await keyIdFor(jwk) };
  await saveKey(record);
  return record;
}

async function signWith(record, text) {
  return b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, record.privateKey, encoder.encode(text)));
}

const randomId = (prefix) => `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(12))).replace(/[^A-Za-z0-9]/g, 'x')}`;

// Must match commandSigningString in plugin/lib/protocol.js.
const commandSigningString = ({ group, person, target, text, nonce, expiresAt }) => JSON.stringify(['aep-command-v1', group, person, target, text, nonce, expiresAt]);

// Hub

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, route, body) {
  const response = await fetch(route, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // Handled below.
  }
  if (!response.ok) throw new ApiError(data?.message ?? `The hub returned ${response.status}`, response.status);
  return data;
}

async function signIn() {
  const key = await loadKey();
  if (!key) return false;
  const { nonce } = await api('POST', '/v1/auth/challenge', {});
  const signature = await signWith(key, JSON.stringify(['aep-login-v1', nonce]));
  try {
    await api('POST', '/v1/auth/verify', { kid: key.kid, nonce, signature });
    return true;
  } catch (error) {
    if (error.status === 401) return false;
    throw error;
  }
}

async function loadMe() {
  try {
    return await api('GET', '/v1/me');
  } catch (error) {
    if (error.status === 401) return null;
    throw error;
  }
}

// Words for what's on screen

const PERSON_COLORS = 6;
function personClass(person) {
  // By join order first, so two people in a group can't land on the same color.
  const index = state.members.indexOf(person);
  if (index !== -1) return `p${index % PERSON_COLORS}`;
  let total = 0;
  for (const char of person) total = (total * 31 + char.charCodeAt(0)) % 1009;
  return `p${total % PERSON_COLORS}`;
}

const handleOf = (from) => (from.session ? `${from.person}/${from.session}` : from.person);
const nameFor = (from) => (from.person === state.me && !from.session ? 'You' : handleOf(from));

const THREAD_LABELS = {
  open: ['Waiting for a reply', 'warn'],
  waiting_on_person: ['Waiting on a person', 'warn'],
  negotiating: ['Negotiating', 'warn'],
  answered: ['Answered', 'good'],
  escalated: ['Needs you both', 'danger'],
  resolved: ['Resolved', 'good'],
  stale: ['Went quiet', null],
};

const ALERT_LABELS = {
  question_waiting: 'A question is waiting on you',
  escalated: 'A dispute needs you',
  worker_finished: 'Your worker finished',
  worker_failed: 'Your worker stopped early',
  worker_refused: 'A command was refused',
};

const WORKER_LABELS = {
  queued: 'Worker queued',
  started: 'Worker started',
  finished: 'Worker finished',
  failed: 'Worker stopped early',
  refused: 'Command refused',
  held: 'Command waiting for the agent',
};

function threadChip(thread) {
  if (!thread) return null;
  const [label, tone] = THREAD_LABELS[thread.state] ?? [thread.state, null];
  const text = thread.state === 'waiting_on_person' ? `Waiting on ${thread.target_person === state.me ? 'you' : thread.target_person}` : label;
  return h('span', { class: 'chip', dataset: tone ? { tone } : {} }, text);
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayOf(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function pathChips(paths, limit = 4) {
  if (!paths?.length) return null;
  const shown = paths.slice(0, limit).map((file) => h('code', {}, file));
  const extra = paths.length - limit;
  return h('div', { class: 'paths' }, shown, extra > 0 ? h('span', { class: 'small muted' }, `+${extra} more`) : null);
}

function ticks(message) {
  if (!['question', 'reply', 'command'].includes(message.type)) return null;
  const receipts = state.receipts.get(message.id) ?? message.receipts ?? [];
  const others = receipts.filter((receipt) => !receipt.reader.startsWith(`${message.from.person}/`) || message.type === 'command');
  const read = others.some((receipt) => receipt.state === 'read');
  const delivered = read || others.some((receipt) => receipt.state === 'delivered');
  const label = read ? 'Read by the agent' : delivered ? 'Delivered to the machine' : 'Sent';
  return h('span', { class: 'ticks', title: label, ariaLabel: label, dataset: { state: read ? 'read' : delivered ? 'delivered' : 'sent' } }, delivered ? '✓✓' : '✓');
}

function commitLink(body) {
  const base = state.group?.web_url;
  if (!base) return h('code', {}, body.after.slice(0, 7));
  const href = body.before ? `${base}/compare/${body.before}...${body.after}` : `${base}/commit/${body.after}`;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, 'See the changes');
}

// Feed

function bubble(message, { kind, linked = true } = {}, ...content) {
  const mine = message.from.person === state.me;
  const thread = message.thread ? state.threads.get(message.thread) : null;
  const props = {
    class: `bubble${mine ? ' mine' : ''}${linked && message.thread ? ' linked' : ''}`,
    onclick: linked && message.thread ? () => { location.hash = `#group/${state.group.id}/thread/${message.thread}`; } : undefined,
  };
  return h(linked && message.thread ? 'button' : 'div', props,
    h('div', { class: 'who' },
      h('span', { class: personClass(message.from.person) }, nameFor(message.from)),
      kind ? h('span', { class: 'kind' }, kind) : null),
    content,
    h('div', { class: 'meta' },
      message.type === 'question' ? threadChip(thread) : null,
      h('time', { dateTime: message.sent_at }, timeOf(message.sent_at)),
      ticks(message)));
}

function disputeCard(message) {
  const thread = state.threads.get(message.thread);
  const { body } = message;
  const party = thread && [thread.asker_person, thread.target_person].includes(state.me);
  const open = thread?.state === 'escalated';
  const mine = thread?.resolutions?.[state.me];
  const others = Object.entries(thread?.resolutions ?? {}).filter(([person]) => person !== state.me);
  const options = [...new Set([...(thread?.options ?? body.options ?? []), ...others.map(([, choice]) => choice)])];

  const choose = async (choice) => {
    try {
      await api('POST', `/v1/groups/${state.group.id}/messages`, {
        id: randomId('res_'),
        type: 'resolution',
        thread: message.thread,
        body: { choice },
      });
    } catch (error) {
      toast(error.message);
    }
  };

  const writeIn = h('input', { type: 'text', placeholder: 'Or write your own decision', ariaLabel: 'Your decision', maxLength: 200 });
  const submitWriteIn = (event) => {
    event.preventDefault();
    const choice = writeIn.value.trim();
    if (choice) choose(choice);
  };

  return h('section', { class: 'dispute' },
    h('h3', {}, 'Dispute'),
    h('p', {}, body.summary),
    body.positions?.length ? h('ul', {}, body.positions.map((position) => h('li', {}, h('strong', {}, position.side ?? 'Position'), ': ', position.text))) : null,
    pathChips(body.paths ?? thread?.paths),
    others.length ? h('p', { class: 'small muted' }, others.map(([person, choice]) => `${person} chose: ${choice}`).join('. ')) : null,
    open && party ? [
      options.length ? h('div', { class: 'choices' }, options.map((option) => h('button', {
        ariaPressed: mine === option ? 'true' : 'false',
        onclick: () => choose(option),
      }, option))) : null,
      h('form', { class: 'write-in', onsubmit: submitWriteIn }, writeIn, h('button', { type: 'submit' }, 'Choose')),
      h('p', { class: 'small muted' }, mine
        ? `You chose: ${mine}. Your agents can carry on with that. This closes once everyone picks the same option.`
        : 'Your choice directs only your own agents. This closes once everyone picks the same option.'),
    ] : null,
    !open ? h('p', { class: 'small' }, threadChip(thread), thread?.state === 'resolved' ? ` ${mine ?? ''}` : '') : null,
    open && !party ? h('p', { class: 'small muted' }, 'Waiting on the people involved.') : null);
}

function workerRow(message) {
  const { body } = message;
  return h('div', { class: 'system' },
    h('strong', {}, `${WORKER_LABELS[body.state] ?? 'Worker'}`),
    ` for ${message.from.person}`,
    body.branch ? [' on ', h('code', {}, body.branch)] : null,
    body.summary ? `: ${body.summary}` : '',
    body.reason ? `: ${body.reason}` : '');
}

function renderMessage(message) {
  const { body } = message;
  switch (message.type) {
    case 'intent': {
      if (body.task) {
        return h('div', { class: 'system' },
          h('strong', { class: personClass(message.from.person) }, handleOf(message.from)),
          ` is starting: ${body.task}`,
          pathChips(body.paths));
      }
      return h('div', { class: 'system small' }, h('span', { class: personClass(message.from.person) }, handleOf(message.from)), ' is editing ', body.paths.slice(-3).join(', '), body.paths.length > 3 ? ` and ${body.paths.length - 3} more` : '');
    }
    case 'push':
      return bubble(message, { kind: `pushed ${body.commit_count} commit${body.commit_count === 1 ? '' : 's'} to ${body.branch}`, linked: false },
        body.summary ? h('p', { class: 'body' }, body.summary) : null,
        (body.decisions ?? []).map((decision) => h('div', { class: 'decision' }, h('b', {}, 'Decision'), decision)),
        pathChips(body.paths),
        h('div', { class: 'small' }, commitLink(body)));
    case 'question': {
      const asks = message.to === state.me || message.to?.startsWith(`${state.me}/`) ? `asks ${message.to === state.me ? 'you' : message.to}` : `asks ${message.to}`;
      return bubble(message, { kind: asks }, h('p', { class: 'body' }, body.text), pathChips(body.paths));
    }
    case 'reply': {
      const label = { agree: 'agrees', disagree: 'disagrees', info: 'replies' }[body.stance];
      return bubble(message, { kind: label }, h('p', { class: 'body' }, body.text));
    }
    case 'agreement':
      return h('div', { class: 'system' },
        h('strong', {}, 'Agreed: '), body.outcome,
        h('span', { class: 'muted' }, ` (recorded by ${handleOf(message.from)})`));
    case 'escalation':
      return disputeCard(message);
    case 'resolution':
      return h('div', { class: 'system' }, h('strong', {}, message.from.person === state.me ? 'You' : message.from.person), ` chose: ${body.choice}`);
    case 'command':
      return bubble(message, { kind: `to ${body.target === state.me ? 'all your agents' : body.target}`, linked: false }, h('p', { class: 'body' }, body.text));
    case 'worker':
      return workerRow(message);
    default:
      return null;
  }
}

// Agents re-announce the same work every few minutes. Keep only the latest of a run, so the feed stays readable.
function visibleMessages(messages) {
  const visible = [];
  for (const message of messages) {
    if (message.type === 'intent' && message.body.state !== 'active') continue;
    const previous = visible.at(-1);
    if (message.type === 'intent' && !message.body.task
      && previous?.type === 'intent' && !previous.body.task
      && handleOf(previous.from) === handleOf(message.from)) {
      visible[visible.length - 1] = message;
      continue;
    }
    visible.push(message);
  }
  return visible;
}

function renderFeedItems(messages) {
  const items = [];
  let lastDay = null;
  for (const message of visibleMessages(messages)) {
    const day = dayOf(message.sent_at);
    if (day !== lastDay) {
      items.push(h('div', { class: 'day' }, day));
      lastDay = day;
    }
    const element = renderMessage(message);
    if (element) items.push(element);
  }
  return items;
}

// Side panels

const STATE_WORDS = { running: 'Running', idle: 'Idle', offline: 'Offline' };

function renderAgents() {
  const now = Date.now();
  const recent = state.agents.filter((agent) => agent.state !== 'offline' || now - agent.last_seen < 24 * 60 * 60 * 1000);
  const people = [...new Set([...state.members, ...recent.map((agent) => agent.person)])];
  return h('section', { class: 'panel panel-agents' },
    h('h2', {}, 'Agents'),
    people.map((person) => {
      const agents = recent.filter((agent) => agent.person === person);
      return [
        h('p', { class: `person ${personClass(person)}` }, person === state.me ? `${person} (you)` : person),
        agents.length === 0 ? h('p', { class: 'small muted' }, 'No agents active.') : agents.map((agent) => {
          const active = (agent.intent_expires_at ?? 0) > now;
          return h('div', { class: 'agent' },
            h('div', { class: 'line' },
              h('span', { class: 'handle' }, agent.handle),
              h('span', { class: 'state' }, h('span', { class: 'dot', dataset: { state: agent.state } }), STATE_WORDS[agent.state])),
            active && agent.task ? h('p', { class: 'task' }, agent.task) : null,
            active ? pathChips(agent.paths, 3) : null);
        }),
      ];
    }));
}

function renderNeeds() {
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window;
  const iosNeedsInstall = isIos() && !isInstalled();
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  return h('section', { class: 'panel panel-needs' },
    h('h2', {}, 'Needs you'),
    state.alerts.length === 0
      ? h('p', { class: 'small muted' }, "Nothing's waiting on you.")
      : state.alerts.map((alert) => h('button', {
        class: 'need',
        onclick: () => openAlert(alert),
      }, h('b', {}, ALERT_LABELS[alert.kind] ?? 'Your agents need you'), h('span', { class: 'small' }, `${alert.group_name}, ${timeOf(new Date(alert.created_at).toISOString())}`))),
    iosNeedsInstall
      ? h('p', { class: 'small muted' }, 'To get alerts on iPhone, tap Share, then Add to Home Screen, and open AEP from there.')
      : pushSupported && permission !== 'granted'
        ? h('button', { onclick: enableAlerts }, 'Turn on phone alerts')
        : permission === 'granted'
          ? h('p', { class: 'small muted' }, 'Phone alerts are on for this device.')
          : h('p', { class: 'small muted' }, "This browser can't receive push alerts."),
    h('button', { class: 'pair-another', onclick: showPairAnother }, 'Pair with another machine'));
}

async function openAlert(alert) {
  try {
    await api('POST', '/v1/me/alerts/seen', { ids: [alert.id] });
  } catch {
    // It still opens. The alert just stays listed.
  }
  state.alerts = state.alerts.filter((entry) => entry.id !== alert.id);
  const next = `#group/${alert.group_id}${alert.thread ? `/thread/${alert.thread}` : ''}`;
  if (location.hash === next) render();
  else location.hash = next;
}

async function enableAlerts() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return toast('Alerts stay off until you allow notifications.');
    const registration = await navigator.serviceWorker.register('/sw.js');
    const ready = await navigator.serviceWorker.ready;
    const { vapid_public_key: vapid } = await api('GET', '/v1/config');
    const subscription = await (ready ?? registration).pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromB64url(vapid),
    });
    await api('POST', '/v1/push/subscribe', { endpoint: subscription.endpoint });
    toast('Phone alerts are on.');
    render();
  } catch (error) {
    toast(`Couldn't turn on alerts: ${error.message}`);
  }
}

// Composer. Only your own agents can be selected, and every command is signed by this browser.

function renderComposer() {
  const mine = state.agents.filter((agent) => agent.person === state.me && agent.state !== 'offline');
  const targets = [
    { value: state.me, label: 'Any of my agents' },
    ...mine.map((agent) => ({ value: agent.handle, label: `${agent.handle} (${STATE_WORDS[agent.state].toLowerCase()})` })),
  ];
  if (!targets.some((target) => target.value === state.target)) state.target = state.me;

  const select = h('select', {
    ariaLabel: 'Which of your agents',
    onchange: (event) => { state.target = event.target.value; },
  }, targets.map((target) => h('option', { value: target.value, selected: target.value === state.target }, target.label)));

  const box = h('textarea', {
    rows: 1,
    placeholder: 'Tell your agent what to do',
    ariaLabel: 'Message to your agent',
    maxLength: 2000,
    value: state.draft,
    oninput: (event) => {
      state.draft = event.target.value;
      event.target.style.height = 'auto';
      event.target.style.height = `${event.target.scrollHeight + 2}px`;
    },
    onkeydown: (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.target.form.requestSubmit();
      }
    },
  });

  const send = async (event) => {
    event.preventDefault();
    const text = state.draft.trim();
    if (!text) return;
    try {
      const key = await loadKey();
      if (!key) throw new Error("This browser's key is missing. Pair it again with: aep pair-browser");
      const nonce = randomId('nonce_');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const signature = await signWith(key, commandSigningString({ group: state.group.id, person: state.me, target: state.target, text, nonce, expiresAt }));
      await api('POST', `/v1/groups/${state.group.id}/messages`, {
        id: randomId('cmd_'),
        type: 'command',
        body: { target: state.target, text, nonce, expires_at: expiresAt, signature, kid: key.kid },
      });
      state.draft = '';
      box.value = '';
      box.style.height = '';
    } catch (error) {
      toast(error.message);
    }
  };

  return h('form', { class: 'composer', onsubmit: send },
    h('div', { class: 'hint' }, h('span', {}, 'To'), select, h('span', {}, 'Everyone in the group can read this.')),
    h('div', { class: 'row' }, box, h('button', { class: 'primary', type: 'submit' }, 'Send')));
}

// Thread drawer

function renderThreadDrawer() {
  const thread = state.threads.get(state.openThread);
  if (!thread) return null;
  const close = () => { location.hash = `#group/${state.group.id}`; };
  const canAnswer = !['resolved', 'stale'].includes(thread.state);

  const box = h('textarea', { rows: 2, placeholder: 'Write a reply', ariaLabel: 'Your reply', maxLength: 500 });
  const reply = async (event) => {
    event.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    try {
      await api('POST', `/v1/groups/${state.group.id}/messages`, {
        id: randomId('msg_'),
        type: 'reply',
        thread: thread.id,
        body: { text, stance: 'info' },
      });
      box.value = '';
      await loadThread(thread.id);
      render();
    } catch (error) {
      toast(error.message);
    }
  };

  return h('div', {
    class: 'drawer-wrap',
    onclick: (event) => { if (event.target === event.currentTarget) close(); },
    onkeydown: (event) => { if (event.key === 'Escape') close(); },
  },
  h('div', { class: 'drawer', role: 'dialog', ariaModal: 'true', ariaLabel: 'Conversation' },
    h('header', {}, h('h2', {}, 'Conversation'), threadChip(thread), h('button', { onclick: close }, 'Close')),
    h('div', { class: 'feed' }, renderFeedItems(state.threadMessages.map((message) => ({ ...message, thread: message.type === 'escalation' ? message.thread : null, threadRef: message.thread })))),
    canAnswer ? h('form', { class: 'composer', onsubmit: reply },
      h('p', { class: 'hint' }, 'Your reply is information for the agents. It only directs your own.'),
      h('div', { class: 'row' }, box, h('button', { class: 'primary', type: 'submit' }, 'Reply'))) : null));
}

// Screens

function screen(...children) {
  app.replaceChildren(h('main', { class: 'center' }, h('div', { class: 'card' }, h('img', { src: '/icon.svg', alt: '' }), children)));
}

function pairLinkForm() {
  const input = h('input', {
    type: 'text',
    placeholder: 'Paste the pairing link',
    ariaLabel: 'Pairing link',
    autocomplete: 'off',
    autocapitalize: 'off',
  });
  const problem = h('p', { class: 'small form-error', role: 'alert' });
  const submit = (event) => {
    event.preventDefault();
    const { id, secret, error } = parsePairingLink(input.value, location.origin);
    if (error) {
      problem.textContent = error;
      return;
    }
    location.hash = `#pair/${id}/${secret}`;
  };
  return h('form', { class: 'paste-pair', onsubmit: submit }, input, h('button', { class: 'primary', type: 'submit' }, 'Pair'), problem);
}

function renderUnpaired() {
  screen(
    h('h1', {}, 'Pair this browser'),
    h('p', {}, "This browser isn't connected to your account yet. On a machine that's set up, run:"),
    h('pre', {}, h('code', {}, 'aep pair-browser')),
    h('p', {}, 'Then open the link it prints here, or paste it below.'),
    pairLinkForm(),
    isIos() && !isInstalled()
      ? h('p', { class: 'small muted' }, 'For phone alerts on iPhone, first tap Share, then Add to Home Screen, and open AEP from there.')
      : null,
    h('p', { class: 'muted small' }, 'New to this hub? Ask a teammate for an invite, or see the README.'),
  );
}

// A signed-in browser pairing with a second machine. Each machine's helper has to trust it separately.
function showPairAnother() {
  state.paused = true;
  state.stream?.close();
  screen(
    h('h1', {}, 'Pair with another machine'),
    h('p', {}, 'On that machine, run:'),
    h('pre', {}, h('code', {}, 'aep pair-browser')),
    h('p', {}, 'Then paste the link it prints.'),
    pairLinkForm(),
    h('div', { class: 'choices' }, h('button', { onclick: () => location.reload() }, 'Back to the group')),
  );
}

// iPhones keep home screen apps separate from Safari, and a pairing link only works once. Pairing here
// would use up the link on a browser that can't get alerts, so stop and explain first.
function renderInstallFirst(id, secret) {
  const link = location.href;
  const field = h('input', { type: 'text', readOnly: true, value: link, ariaLabel: 'Pairing link', onfocus: (event) => event.target.select() });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied.');
    } catch {
      field.focus();
      toast('Copy the selected link.');
    }
  };
  screen(
    h('h1', {}, 'Use this link in the home screen app'),
    h('p', {}, 'iPhones keep home screen apps separate from Safari. If you pair here, you can use AEP in Safari, but you won\'t get phone alerts.'),
    h('p', {}, 'To get alerts:'),
    h('ol', {},
      h('li', {}, 'Copy this link.'),
      h('li', {}, 'Tap Share, then Add to Home Screen.'),
      h('li', {}, 'Open AEP from your home screen, and paste the link there.')),
    field,
    h('div', { class: 'choices' },
      h('button', { class: 'primary', onclick: copy }, 'Copy link'),
      h('button', { onclick: () => startPairing(id, secret) }, 'Pair Safari, without alerts')),
  );
}

async function startPairing(id, secret) {
  state.paused = true;
  screen(h('h1', {}, 'Pairing this browser'), h('p', {}, 'One moment.'));
  try {
    // A browser the hub already knows can sign in straight away, so it can't move on by itself:
    // that would take the code off the screen before anyone could compare it.
    const returning = Boolean(await loadKey());
    const key = await ensureKey();
    const secretKey = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = b64url(await crypto.subtle.sign('HMAC', secretKey, encoder.encode(JSON.stringify(['aep-pair-v1', id, key.jwk.x, key.jwk.y]))));
    const label = /iphone|ipad|android/i.test(navigator.userAgent) ? 'Phone browser' : 'Desktop browser';
    await api('POST', `/v1/pairings/${id}/complete`, { jwk: key.jwk, mac, label });
    const code = `${key.kid.slice(0, 4)}-${key.kid.slice(4, 8)}`.toUpperCase();
    history.replaceState(null, '', '/');
    if (returning) {
      screen(
        h('h1', {}, 'Compare this code'),
        h('p', {}, 'Your terminal is showing a code. If it matches this one, confirm there.'),
        h('div', { class: 'pair-code' }, code),
        h('div', { class: 'choices' }, h('button', { class: 'primary', onclick: () => location.reload() }, "I've confirmed it")),
      );
      return undefined;
    }
    screen(
      h('h1', {}, 'Compare this code'),
      h('p', {}, 'Your terminal is showing a code. If it matches this one, confirm there.'),
      h('div', { class: 'pair-code' }, code),
      h('p', { class: 'muted small' }, "This page moves on by itself once you've confirmed."),
    );
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (await signIn()) {
        state.paused = false;
        return boot();
      }
    }
    screen(h('h1', {}, 'Pairing timed out'), h('p', {}, 'Run aep pair-browser again for a new link, and paste it here.'), pairLinkForm());
  } catch (error) {
    // With no address bar, this box is a home screen app's only way to try again.
    history.replaceState(null, '', '/');
    screen(h('h1', {}, "Pairing didn't work"), h('p', {}, error.message), h('p', {}, 'Run aep pair-browser again for a new link, and paste it here.'), pairLinkForm());
  }
}

function renderEmptyFeed() {
  return h('div', { class: 'empty' },
    h('h2', {}, 'No activity yet'),
    h('p', {}, "When an agent starts work in this repo, you'll see it here. Run an agent in a clone that has joined this group."));
}

let feedElement = null;

function render() {
  if (!state.me || state.paused) return;
  const wasAtBottom = !feedElement || feedElement.scrollHeight - feedElement.scrollTop - feedElement.clientHeight < 60;
  const previousScroll = feedElement?.scrollTop ?? 0;
  const focused = document.activeElement;
  const restoreComposer = focused?.tagName === 'TEXTAREA' && focused.closest('.chat');
  const selection = restoreComposer ? [focused.selectionStart, focused.selectionEnd] : null;

  if (!state.group) {
    screen(
      h('h1', {}, 'No groups yet'),
      h('p', {}, `You're signed in as ${state.me}. To create a group, run this inside a repo:`),
      h('pre', {}, h('code', {}, 'aep join')),
    );
    return;
  }

  const groupPicker = state.groups.length > 1
    ? h('select', {
      ariaLabel: 'Group',
      onchange: (event) => { location.hash = `#group/${event.target.value}`; },
    }, state.groups.map((group) => h('option', { value: group.id, selected: group.id === state.group.id }, group.name)))
    : h('h1', {}, state.group.name);

  const running = state.agents.filter((agent) => agent.state === 'running').length;
  const down = state.connection !== 'live';
  const topbar = h('header', { class: 'topbar' },
    h('img', { src: '/icon.svg', alt: 'AEP' }),
    groupPicker,
    h('span', { class: 'spacer' }),
    h('span', { class: 'conn', dataset: { state: down ? 'down' : 'up' } },
      h('span', { class: 'dot', dataset: { state: down ? 'down' : 'running' } }),
      down ? 'Reconnecting' : `${running} running`));

  const tab = (id, label, count) => h('button', {
    role: 'tab',
    ariaSelected: state.tab === id ? 'true' : 'false',
    onclick: () => { state.tab = id; render(); },
  }, label, count ? h('span', { class: 'badge' }, count) : null);

  const tabs = h('nav', { class: 'tabs', role: 'tablist', ariaLabel: 'Sections' },
    tab('chat', 'Group'),
    tab('agents', 'Agents'),
    tab('needs', 'Needs you', state.alerts.length));

  feedElement = h('div', { class: 'feed', role: 'log', ariaLive: 'polite', ariaLabel: 'Group activity' },
    state.messages.length ? renderFeedItems(state.messages) : renderEmptyFeed());

  const shell = h('div', { class: 'shell' },
    topbar,
    tabs,
    h('div', { class: 'layout', dataset: { tab: state.tab } },
      h('div', { class: 'column chat' }, feedElement, renderComposer()),
      h('aside', { class: 'column side' }, renderNeeds(), renderAgents())));

  app.replaceChildren(shell, renderThreadDrawer() ?? '');
  feedElement.scrollTop = wasAtBottom ? feedElement.scrollHeight : previousScroll;

  if (restoreComposer) {
    const box = app.querySelector('.chat textarea');
    box?.focus();
    if (box && selection) box.setSelectionRange(selection[0], selection[1]);
  }
}

// Live data

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

async function loadThread(id) {
  const { thread, messages } = await api('GET', `/v1/groups/${state.group.id}/threads/${id}`);
  state.threads.set(id, thread);
  state.threadMessages = messages;
}

async function loadAlerts() {
  try {
    state.alerts = (await api('GET', '/v1/me/alerts')).alerts;
  } catch {
    // The list refreshes on the next alert.
  }
}

function connect() {
  state.stream?.close();
  const after = state.messages.at(-1)?.seq ?? 0;
  const stream = new EventSource(`/v1/groups/${state.group.id}/live?after=${after}`);
  state.stream = stream;
  stream.addEventListener('ready', () => {
    state.connection = 'live';
    scheduleRender();
  });
  stream.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (state.messages.some((existing) => existing.seq === message.seq)) return;
    state.messages.push(message);
    if (message.thread && message.thread === state.openThread) state.threadMessages.push(message);
    scheduleRender();
  });
  stream.addEventListener('thread', (event) => {
    const { thread } = JSON.parse(event.data);
    state.threads.set(thread.id, thread);
    scheduleRender();
  });
  stream.addEventListener('roster', (event) => {
    state.agents = JSON.parse(event.data).agents;
    scheduleRender();
  });
  stream.addEventListener('receipt', (event) => {
    const { message_ids: ids, reader, state: receiptState, at } = JSON.parse(event.data);
    for (const id of ids) {
      const list = state.receipts.get(id) ?? [];
      list.push({ reader, state: receiptState, at });
      state.receipts.set(id, list);
    }
    scheduleRender();
  });
  stream.addEventListener('alert', async () => {
    await loadAlerts();
    scheduleRender();
  });
  stream.onerror = () => {
    state.connection = 'down';
    scheduleRender();
  };
}

async function openGroup(id) {
  const summary = state.groups.find((group) => group.id === id);
  if (!summary) return false;
  if (state.group?.id !== id) {
    const detail = await api('GET', `/v1/groups/${id}`);
    const { messages } = await api('GET', `/v1/groups/${id}/messages?limit=300`);
    state.group = detail.group;
    state.members = detail.members;
    state.agents = detail.agents;
    state.threads = new Map(detail.threads.map((thread) => [thread.id, thread]));
    state.messages = messages;
    state.receipts = new Map(messages.map((message) => [message.id, message.receipts ?? []]));
    connect();
  }
  return true;
}

async function route() {
  const hash = location.hash.slice(1);
  const pair = hash.match(/^pair\/([\w-]+)\/([\w-]+)$/);
  if (pair) {
    state.paused = true;
    state.stream?.close();
    if (isIos() && !isInstalled()) return renderInstallFirst(pair[1], pair[2]);
    return startPairing(pair[1], pair[2]);
  }
  if (!state.me) return boot();

  const match = hash.match(/^group\/([\w-]+)(?:\/thread\/([\w-]+))?$/);
  const groupId = match?.[1] ?? state.group?.id ?? state.groups[0]?.id;
  if (groupId && !(await openGroup(groupId)) && state.groups[0]) await openGroup(state.groups[0].id);
  state.openThread = match?.[2] ?? null;
  if (state.openThread) {
    try {
      await loadThread(state.openThread);
    } catch (error) {
      toast(error.message);
      state.openThread = null;
    }
  }
  render();
}

async function boot() {
  if (/^#pair\//.test(location.hash)) return route();
  let me = await loadMe();
  if (!me && await signIn()) me = await loadMe();
  if (!me || me.kind !== 'person') return renderUnpaired();
  state.me = me.person;
  state.kid = me.kid;
  state.groups = me.groups;
  await loadAlerts();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  return route();
}

window.addEventListener('hashchange', () => {
  route().catch((error) => toast(error.message));
});

boot().catch((error) => {
  screen(h('h1', {}, "Couldn't load"), h('p', {}, error.message));
});

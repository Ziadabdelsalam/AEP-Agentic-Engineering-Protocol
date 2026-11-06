// Phone alerts. A push carries no content: it wakes this worker, which asks the hub what to show.
const LABELS = {
  question_waiting: 'A question is waiting on you',
  escalated: 'A dispute needs you',
  worker_finished: 'Your worker finished',
  worker_failed: 'Your worker stopped early',
  worker_refused: 'A command was refused',
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function showLatest() {
  let alert = null;
  try {
    const response = await fetch('/v1/me/alerts', { credentials: 'same-origin' });
    if (response.ok) [alert] = (await response.json()).alerts;
  } catch {
    // Offline: browsers require a notification for each push, so show a plain one.
  }
  const url = alert ? `/#group/${alert.group_id}${alert.thread ? `/thread/${alert.thread}` : ''}` : '/';
  await self.registration.showNotification(alert ? LABELS[alert.kind] ?? 'Your agents need you' : 'Your agents need you', {
    body: alert?.group_name ?? 'Open AEP to see what happened.',
    tag: alert?.id ?? 'aep',
    icon: '/icon-192.png',
    data: { url },
  });
}

self.addEventListener('push', (event) => event.waitUntil(showLatest()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.navigate?.(url);
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});

// Ezzymigo Service Worker for Background Web Push Notifications
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    data = {
      title: 'Ezzymigo Reminder',
      body: event.data ? event.data.text() : 'You have a scheduled reminder',
    };
  }

  const title = data.title || 'Ezzymigo Reminder';
  const options = {
    body: data.body || 'You have a scheduled memory reminder from Ezzymigo',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: data.id ? `ezzymigo-reminder-${data.id}` : 'ezzymigo-reminder',
    renotify: true,
    requireInteraction: true,
    data: {
      url: data.url || '/',
      id: data.id,
      timestamp: Date.now(),
    },
    actions: [
      { action: 'open', title: 'Open Ezzymigo' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url && client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

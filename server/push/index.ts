import webpush from 'web-push';
import { executeBunnySql } from '../db/client';
import { initBunnyDb } from '../db/schema';

// VAPID Web Push Setup
let currentVapidPublicKey: string | null = null;
let currentVapidPrivateKey: string | null = null;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@ezzymigo.app';

export async function initVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (currentVapidPublicKey && currentVapidPrivateKey) {
    return { publicKey: currentVapidPublicKey, privateKey: currentVapidPrivateKey };
  }

  // 1. Check environment variables
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    currentVapidPublicKey = process.env.VAPID_PUBLIC_KEY.trim();
    currentVapidPrivateKey = process.env.VAPID_PRIVATE_KEY.trim();
    webpush.setVapidDetails(VAPID_SUBJECT, currentVapidPublicKey, currentVapidPrivateKey);
    return { publicKey: currentVapidPublicKey, privateKey: currentVapidPrivateKey };
  }

  // 2. Check Bunny Database config
  await initBunnyDb();
  try {
    const configRows = await executeBunnySql([{
      sql: 'SELECT publicKey, privateKey FROM vapid_config WHERE id = ?;',
      args: ['default']
    }]);

    if (configRows[0]?.rows && configRows[0].rows.length > 0) {
      currentVapidPublicKey = configRows[0].rows[0].publicKey;
      currentVapidPrivateKey = configRows[0].rows[0].privateKey;
      webpush.setVapidDetails(VAPID_SUBJECT, currentVapidPublicKey!, currentVapidPrivateKey!);
      return { publicKey: currentVapidPublicKey!, privateKey: currentVapidPrivateKey! };
    }

    // 3. Generate new persistent VAPID keys and save to Bunny DB
    const keys = webpush.generateVAPIDKeys();
    currentVapidPublicKey = keys.publicKey;
    currentVapidPrivateKey = keys.privateKey;

    await executeBunnySql([{
      sql: 'INSERT INTO vapid_config (id, publicKey, privateKey, createdAt) VALUES (?, ?, ?, ?);',
      args: ['default', keys.publicKey, keys.privateKey, new Date().toISOString()]
    }]);

    webpush.setVapidDetails(VAPID_SUBJECT, currentVapidPublicKey, currentVapidPrivateKey);
    console.log('[Web Push] Persistent VAPID keys initialized.');
    return { publicKey: currentVapidPublicKey, privateKey: currentVapidPrivateKey };
  } catch (err) {
    console.error('[Web Push] Error initializing VAPID keys:', err);
    const fallback = webpush.generateVAPIDKeys();
    currentVapidPublicKey = fallback.publicKey;
    currentVapidPrivateKey = fallback.privateKey;
    webpush.setVapidDetails(VAPID_SUBJECT, currentVapidPublicKey, currentVapidPrivateKey);
    return fallback;
  }
}

// Background Reminder Push Dispatcher
let isDispatcherRunning = false;
export async function dispatchDueReminders(): Promise<void> {
  if (isDispatcherRunning) return;
  isDispatcherRunning = true;

  try {
    await initVapidKeys();
    const nowIso = new Date().toISOString();

    // Query due reminders that have not been notified
    const remindersRes = await executeBunnySql([{
      sql: 'SELECT id, memoryId, title, body, remindAt FROM scheduled_reminders WHERE remindAt <= ? AND notified = 0;',
      args: [nowIso]
    }]);

    const dueReminders = remindersRes[0]?.rows || [];
    if (dueReminders.length === 0) {
      isDispatcherRunning = false;
      return;
    }

    // Get active subscriptions
    const subsRes = await executeBunnySql([{
      sql: 'SELECT endpoint, p256dh, auth FROM push_subscriptions;'
    }]);
    const subscriptions = subsRes[0]?.rows || [];

    for (const reminder of dueReminders) {
      console.log(`[Push Dispatcher] Triggering reminder: "${reminder.title} - ${reminder.body}" (due: ${reminder.remindAt})`);

      const payload = JSON.stringify({
        title: reminder.title || 'Ezzymigo Reminder',
        body: reminder.body || 'You have a scheduled memory reminder',
        id: reminder.memoryId || reminder.id,
        url: '/',
        timestamp: Date.now(),
      });

      // Send to all registered subscriber devices
      for (const sub of subscriptions) {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };

        try {
          await webpush.sendNotification(pushSubscription, payload);
        } catch (err: any) {
          console.warn('[Push Dispatcher] Error sending to subscription:', err?.statusCode || err?.message);
          // If subscription is expired or gone (404, 410), remove from database
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await executeBunnySql([{
              sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?;',
              args: [sub.endpoint]
            }]).catch(() => {});
          }
        }
      }

      // Mark reminder as notified
      await executeBunnySql([{
        sql: 'UPDATE scheduled_reminders SET notified = 1 WHERE id = ?;',
        args: [reminder.id]
      }]);
    }
  } catch (err) {
    console.error('[Push Dispatcher] Error dispatching reminders:', err);
  } finally {
    isDispatcherRunning = false;
  }
}

// Start background poll timer (every 10 seconds)
export function startReminderDispatcherInterval(intervalMs: number = 10000) {
  return setInterval(() => {
    dispatchDueReminders().catch(() => {});
  }, intervalMs);
}

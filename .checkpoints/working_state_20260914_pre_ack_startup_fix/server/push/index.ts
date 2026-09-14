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
export async function dispatchDueReminders(overrideNowIso?: string): Promise<{ dispatchedCount: number; targetEndpoints: string[] }> {
  if (isDispatcherRunning) return { dispatchedCount: 0, targetEndpoints: [] };
  isDispatcherRunning = true;
  const targetEndpoints: string[] = [];
  let dispatchedCount = 0;

  try {
    await initVapidKeys();
    const nowIso = overrideNowIso || new Date().toISOString();

    // Query due reminders that have not been notified (including ezzy_id and created_by)
    const remindersRes = await executeBunnySql([{
      sql: 'SELECT id, memoryId, title, body, remindAt, ezzy_id, created_by FROM scheduled_reminders WHERE remindAt <= ? AND notified = 0;',
      args: [nowIso]
    }]);

    const dueReminders = remindersRes[0]?.rows || [];
    if (dueReminders.length === 0) {
      isDispatcherRunning = false;
      return { dispatchedCount: 0, targetEndpoints: [] };
    }

    for (const reminder of dueReminders) {
      const reminderEzzyId = (reminder.ezzy_id || 'ezzy_default').trim();
      console.log(`[Push Dispatcher] Triggering reminder: "${reminder.title} - ${reminder.body}" (due: ${reminder.remindAt}) in ezzy: ${reminderEzzyId}`);

      // Query only subscriptions registered to this reminder's ezzy_id
      const subsRes = await executeBunnySql([{
        sql: 'SELECT endpoint, p256dh, auth, ezzy_id, user_id FROM push_subscriptions WHERE ezzy_id = ?;',
        args: [reminderEzzyId]
      }]);
      const subscriptions = subsRes[0]?.rows || [];

      const payload = JSON.stringify({
        title: reminder.title || 'Ezzymigo Reminder',
        body: reminder.body || 'You have a scheduled memory reminder',
        id: reminder.memoryId || reminder.id,
        url: '/',
        timestamp: Date.now(),
        ezzy_id: reminderEzzyId,
      });

      // Send only to subscribers authorized for this Ezzy
      for (const sub of subscriptions) {
        targetEndpoints.push(sub.endpoint);
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };

        try {
          await webpush.sendNotification(pushSubscription, payload);
          dispatchedCount++;
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

  return { dispatchedCount, targetEndpoints };
}

// Helper to query authorized push subscriptions partitioned by ezzy_id
export async function getAuthorizedPushSubscriptions(ezzyId: string, userId?: string): Promise<any[]> {
  const scopeEzzyId = (ezzyId || 'ezzy_default').trim();
  const userClause = userId ? ` AND user_id = ?` : ``;
  const args = userId ? [scopeEzzyId, userId] : [scopeEzzyId];
  const res = await executeBunnySql([{
    sql: `SELECT endpoint, p256dh, auth, ezzy_id, user_id, createdAt FROM push_subscriptions WHERE ezzy_id = ?${userClause};`,
    args,
  }]);
  return res[0]?.rows || [];
}

// Start background poll timer (every 10 seconds)
export function startReminderDispatcherInterval(intervalMs: number = 10000) {
  return setInterval(() => {
    dispatchDueReminders().catch(() => {});
  }, intervalMs);
}

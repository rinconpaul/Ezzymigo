import express from 'express';
import path from 'path';
import fs from 'fs';
import webpush from 'web-push';
import { GoogleGenAI, Type } from '@google/genai';

const app = express();
const PORT = 3000;

app.use(express.json());

// Bunny Database URL & Auth resolver
function getBunnyTargetUrl(): string | null {
  const rawUrl = process.env.BUNNY_DATABASE_URL?.trim();
  if (!rawUrl) return null;

  let urlStr = rawUrl;
  if (urlStr.startsWith('libsql://')) {
    urlStr = urlStr.replace('libsql://', 'https://');
  } else if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
    urlStr = `https://${urlStr}`;
  }

  const urlObj = new URL(urlStr);
  if (!urlObj.pathname.includes('/v2/pipeline')) {
    urlObj.pathname = '/v2/pipeline';
  }
  return urlObj.toString();
}

// Execute SQL statements on Bunny Database (libSQL pipeline)
async function executeBunnySql(statements: Array<{ sql: string; args?: any[] }>): Promise<any[]> {
  const targetUrl = getBunnyTargetUrl();
  const token = process.env.BUNNY_DATABASE_TOKEN?.trim() || '';

  if (!targetUrl || !token) {
    console.warn('[Bunny DB] BUNNY_DATABASE_URL or BUNNY_DATABASE_TOKEN is not configured.');
    return [];
  }

  const requests = statements.map(st => {
    const stmtObj: any = { sql: st.sql };
    if (st.args && st.args.length > 0) {
      stmtObj.args = st.args.map(arg => {
        if (arg === null || arg === undefined) return { type: 'null' };
        if (typeof arg === 'number') return { type: 'integer', value: String(arg) };
        if (typeof arg === 'boolean') return { type: 'integer', value: arg ? '1' : '0' };
        return { type: 'text', value: String(arg) };
      });
    }
    return { type: 'execute', stmt: stmtObj };
  });

  const payload = {
    requests: [...requests, { type: 'close' }]
  };

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Bunny DB request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const results: any[] = [];

  if (data && data.results) {
    for (const res of data.results) {
      if (res.type === 'ok' && res.response && res.response.result) {
        const qr = res.response.result;
        const cols = (qr.cols || []).map((c: any) => c.name);
        const rows = (qr.rows || []).map((row: any[]) => {
          const obj: Record<string, any> = {};
          cols.forEach((colName: string, i: number) => {
            const cell = row[i];
            obj[colName] = cell ? cell.value : null;
          });
          return obj;
        });
        results.push({ rows, affected_rows: qr.affected_row_count });
      } else if (res.type === 'error') {
        throw new Error(`Bunny DB SQL Error: ${res.error?.message || 'Unknown error'}`);
      }
    }
  }

  return results;
}

// Ensure database tables exist in Bunny Database
let dbInitialized = false;
async function initBunnyDb(): Promise<void> {
  if (dbInitialized) return;
  try {
    await executeBunnySql([
      {
        sql: `CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          originalText TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          isDone INTEGER NOT NULL DEFAULT 0,
          content TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          people TEXT NOT NULL,
          places TEXT NOT NULL,
          topics TEXT NOT NULL,
          resurfacingMode TEXT NOT NULL,
          resurfacingTiming TEXT NOT NULL
        );`
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint TEXT PRIMARY KEY,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );`
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS scheduled_reminders (
          id TEXT PRIMARY KEY,
          memoryId TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          remindAt TEXT NOT NULL,
          notified INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL
        );`
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS vapid_config (
          id TEXT PRIMARY KEY,
          publicKey TEXT NOT NULL,
          privateKey TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );`
      }
    ]);
    dbInitialized = true;
    console.log('[Bunny DB] Database tables verified.');
  } catch (err) {
    console.error('[Bunny DB] Error initializing tables:', err);
  }
}

// VAPID Web Push Setup
let currentVapidPublicKey: string | null = null;
let currentVapidPrivateKey: string | null = null;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@ezzymigo.app';

async function initVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
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

// Format local time context for LLM prompt
function formatLocalTimeContext(clientNow?: string, clientTimeZone?: string) {
  const date = clientNow ? new Date(clientNow) : new Date();
  const timeZone = clientTimeZone || 'UTC';

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
      timeZoneName: 'longOffset'
    });

    const parts = formatter.formatToParts(date);
    const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';

    const weekday = getPart('weekday');
    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hour = getPart('hour');
    const minute = getPart('minute');
    const second = getPart('second');
    const tzPart = getPart('timeZoneName');

    let offsetStr = '+00:00';
    if (tzPart) {
      const match = tzPart.match(/GMT([+-]\d{1,2}(?::\d{2})?)/);
      if (match) {
        let off = match[1];
        if (!off.includes(':')) off = off + ':00';
        if (off.length === 5) off = off[0] + '0' + off.slice(1);
        offsetStr = off;
      }
    }

    return {
      referenceDate: date,
      timeZone,
      weekday,
      offsetStr,
      localDateTimeStr: `${weekday}, ${day} ${month} ${year} at ${hour}:${minute}:${second} (${timeZone}, UTC${offsetStr})`,
      utcIso: date.toISOString(),
    };
  } catch (err) {
    return {
      referenceDate: date,
      timeZone: 'UTC',
      weekday: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getUTCDay()],
      offsetStr: '+00:00',
      localDateTimeStr: date.toUTCString(),
      utcIso: date.toISOString(),
    };
  }
}

// Reminder Trigger Timestamp Parser (legacy fallback)
function parseReminderTriggerTime(text: string, timing: string = '', now: Date = new Date()): string | null {
  const combined = `${text} ${timing}`.toLowerCase();

  // "in X minutes / mins / min / m"
  const inMinMatch = combined.match(/\bin\s+(\d+)\s*(?:minutes?|mins?|min|m\b)/i);
  if (inMinMatch) {
    const mins = parseInt(inMinMatch[1], 10);
    if (!isNaN(mins) && mins > 0) {
      return new Date(now.getTime() + mins * 60 * 1000).toISOString();
    }
  }

  // "in X seconds / secs / s"
  const inSecMatch = combined.match(/\bin\s+(\d+)\s*(?:seconds?|secs?|s\b)/i);
  if (inSecMatch) {
    const secs = parseInt(inSecMatch[1], 10);
    if (!isNaN(secs) && secs > 0) {
      return new Date(now.getTime() + secs * 1000).toISOString();
    }
  }

  // "in X hours / hrs / hr / h"
  const inHourMatch = combined.match(/\bin\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr|h\b)/i);
  if (inHourMatch) {
    const hrs = parseFloat(inHourMatch[1]);
    if (!isNaN(hrs) && hrs > 0) {
      return new Date(now.getTime() + Math.round(hrs * 60 * 60 * 1000)).toISOString();
    }
  }

  // "in X days"
  const inDayMatch = combined.match(/\bin\s+(\d+)\s*(?:days?|d\b)/i);
  if (inDayMatch) {
    const days = parseInt(inDayMatch[1], 10);
    if (!isNaN(days) && days > 0) {
      return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  // Specific ISO string inside timing
  if (timing && !isNaN(Date.parse(timing))) {
    const parsed = new Date(timing);
    if (parsed.getTime() > now.getTime()) {
      return parsed.toISOString();
    }
  }

  return null;
}

// Background Reminder Push Dispatcher
let isDispatcherRunning = false;
async function dispatchDueReminders(): Promise<void> {
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
setInterval(() => {
  dispatchDueReminders().catch(() => {});
}, 10000);

// Helper to parse stored topics and retrieval metadata
function parseStoredTopicsAndMetadata(rawTopics: string | null, fallbackKind: string) {
  let topics: string[] = [];
  let contexts: string[] = [];
  let retrieval_cues: string[] = [];
  let intent: string = fallbackKind || 'remember';

  if (rawTopics) {
    try {
      const parsed = JSON.parse(rawTopics);
      if (Array.isArray(parsed)) {
        // Legacy raw topic array record - keep topics, contexts and retrieval_cues remain empty for legacy
        topics = parsed.filter((t: any) => typeof t === 'string');
      } else if (parsed && typeof parsed === 'object') {
        // New metadata structure: { topics, contexts, retrieval_cues, intent }
        topics = Array.isArray(parsed.topics) ? parsed.topics.filter((t: any) => typeof t === 'string') : [];
        contexts = Array.isArray(parsed.contexts) ? parsed.contexts.filter((c: any) => typeof c === 'string') : [];
        retrieval_cues = Array.isArray(parsed.retrieval_cues) ? parsed.retrieval_cues.filter((r: any) => typeof r === 'string') : [];
        intent = typeof parsed.intent === 'string' && parsed.intent.trim() ? parsed.intent : (fallbackKind || 'remember');
      }
    } catch {
      topics = [];
    }
  }

  return { topics, contexts, retrieval_cues, intent };
}

// Helper to parse stored resurfacing timing and absolute dates
function parseStoredResurfacing(rawTiming: string | null, rawMode: string | null) {
  let timing = rawTiming || 'Unscheduled';
  let mode = rawMode || 'none';
  let original_time_expression: string | null = null;
  let resolved_datetime: string | null = null;
  let event_time_expression: string | null = null;
  let event_datetime: string | null = null;
  let reminder_time_expression: string | null = null;
  let reminder_datetime: string | null = null;

  if (rawTiming) {
    if (rawTiming.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawTiming);
        timing = parsed.timing || 'Unscheduled';
        mode = parsed.mode || rawMode || 'none';
        original_time_expression = parsed.original_time_expression || null;
        resolved_datetime = parsed.resolved_datetime || null;
        event_time_expression = parsed.event_time_expression || null;
        event_datetime = parsed.event_datetime || null;
        reminder_time_expression = parsed.reminder_time_expression || null;
        reminder_datetime = parsed.reminder_datetime || null;
      } catch {
        timing = rawTiming;
      }
    } else {
      // Legacy unformatted timing string.
      // Contextual phrases (e.g. "When looking for glasses", "Contextual / On retrieval", "Unscheduled")
      // MUST NOT be copied into original_time_expression.
      timing = rawTiming;
      const isSituationalOrContextual = /^(when|if|whenever|in case|after)\s+/i.test(rawTiming) ||
        /^(contextual|unscheduled|review soon|on retrieval)/i.test(rawTiming);
      const isDateBasedMode = mode === 'date_based' || /^(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|in \d+|\d+)/i.test(rawTiming);

      if (isDateBasedMode && !isSituationalOrContextual) {
        original_time_expression = rawTiming;
      } else {
        original_time_expression = null;
      }
    }
  }

  return {
    resurfacing: { mode, timing },
    original_time_expression,
    resolved_datetime,
    event_time_expression,
    event_datetime,
    reminder_time_expression,
    reminder_datetime,
  };
}

// Read memories from Bunny Database (durable source of truth)
async function readMemories(): Promise<any[]> {
  try {
    await initBunnyDb();
    const results = await executeBunnySql([{
      sql: 'SELECT id, originalText, createdAt, isDone, content, kind, status, people, places, topics, resurfacingMode, resurfacingTiming FROM memories ORDER BY createdAt DESC;'
    }]);

    if (!results[0] || !results[0].rows) return [];

    return results[0].rows.map((row: any) => {
      const meta = parseStoredTopicsAndMetadata(row.topics, row.kind);
      const timeMeta = parseStoredResurfacing(row.resurfacingTiming, row.resurfacingMode);

      return {
        id: row.id,
        originalText: row.originalText || '',
        createdAt: row.createdAt,
        isDone: Boolean(Number(row.isDone)),
        interpretation: {
          content: row.content,
          kind: row.kind,
          intent: meta.intent,
          status: row.status,
          people: row.people ? JSON.parse(row.people) : [],
          places: row.places ? JSON.parse(row.places) : [],
          topics: meta.topics,
          contexts: meta.contexts,
          retrieval_cues: meta.retrieval_cues,
          original_time_expression: timeMeta.original_time_expression,
          resolved_datetime: timeMeta.resolved_datetime,
          event_time_expression: timeMeta.event_time_expression,
          event_datetime: timeMeta.event_datetime,
          reminder_time_expression: timeMeta.reminder_time_expression,
          reminder_datetime: timeMeta.reminder_datetime,
          resurfacing: timeMeta.resurfacing,
        },
      };
    });
  } catch (err) {
    console.error('[Bunny DB] Error reading memories from database:', err);
    return [];
  }
}

// Insert memory records into Bunny Database and schedule reminders if timed
async function insertMemories(items: any[]): Promise<void> {
  await initBunnyDb();
  const stmts: Array<{ sql: string; args: any[] }> = [];
  const reminderStmts: Array<{ sql: string; args: any[] }> = [];

  for (const item of items) {
    const metaTopicsObj = {
      topics: Array.isArray(item.interpretation.topics) ? item.interpretation.topics : [],
      contexts: Array.isArray(item.interpretation.contexts) ? item.interpretation.contexts : [],
      retrieval_cues: Array.isArray(item.interpretation.retrieval_cues) ? item.interpretation.retrieval_cues : [],
      intent: item.interpretation.intent || item.interpretation.kind || 'remember',
    };

    const metaTimingObj = {
      timing: item.interpretation.resurfacing?.timing || 'Unscheduled',
      mode: item.interpretation.resurfacing?.mode || 'none',
      original_time_expression: item.interpretation.original_time_expression || null,
      resolved_datetime: item.interpretation.resolved_datetime || null,
      event_time_expression: item.interpretation.event_time_expression || null,
      event_datetime: item.interpretation.event_datetime || null,
      reminder_time_expression: item.interpretation.reminder_time_expression || null,
      reminder_datetime: item.interpretation.reminder_datetime || null,
    };

    stmts.push({
      sql: `INSERT INTO memories (id, originalText, createdAt, isDone, content, kind, status, people, places, topics, resurfacingMode, resurfacingTiming)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        item.id,
        item.originalText,
        item.createdAt,
        item.isDone ? 1 : 0,
        item.interpretation.content,
        item.interpretation.kind,
        item.interpretation.status,
        JSON.stringify(item.interpretation.people || []),
        JSON.stringify(item.interpretation.places || []),
        JSON.stringify(metaTopicsObj),
        item.interpretation.resurfacing?.mode || 'none',
        JSON.stringify(metaTimingObj),
      ]
    });

    // Check if memory has a scheduled reminder timestamp
    let remindAt: string | null = null;
    const candidateTimestamp = item.interpretation.reminder_datetime || item.interpretation.resolved_datetime;

    if (candidateTimestamp && !isNaN(Date.parse(candidateTimestamp))) {
      remindAt = new Date(candidateTimestamp).toISOString();
    } else {
      // Legacy fallback
      remindAt = parseReminderTriggerTime(
        item.originalText,
        item.interpretation.resurfacing?.timing || '',
        new Date(item.createdAt)
      );
    }

    if (remindAt) {
      console.log(`[Scheduler] Scheduling reminder for "${item.interpretation.content}" at ${remindAt}`);
      reminderStmts.push({
        sql: `INSERT INTO scheduled_reminders (id, memoryId, title, body, remindAt, notified, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?);`,
        args: [
          `remind_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          item.id,
          'Ezzymigo Reminder',
          item.interpretation.content,
          remindAt,
          0,
          new Date().toISOString(),
        ]
      });
    }
  }

  await executeBunnySql([...stmts, ...reminderStmts]);
}

// Toggle memory Done status in Bunny Database
async function toggleMemoryInDb(id: string): Promise<any | null> {
  await initBunnyDb();
  const list = await executeBunnySql([{
    sql: 'SELECT * FROM memories WHERE id = ?;',
    args: [id]
  }]);

  if (!list[0] || !list[0].rows || list[0].rows.length === 0) {
    return null;
  }

  const row = list[0].rows[0];
  const newIsDone = Number(row.isDone) ? 0 : 1;
  const newStatus = newIsDone ? 'done' : 'active';

  await executeBunnySql([{
    sql: 'UPDATE memories SET isDone = ?, status = ? WHERE id = ?;',
    args: [newIsDone, newStatus, id]
  }]);

  const meta = parseStoredTopicsAndMetadata(row.topics, row.kind);
  const timeMeta = parseStoredResurfacing(row.resurfacingTiming, row.resurfacingMode);

  return {
    id: row.id,
    originalText: row.originalText,
    createdAt: row.createdAt,
    isDone: Boolean(newIsDone),
    interpretation: {
      content: row.content,
      kind: row.kind,
      intent: meta.intent,
      status: newStatus,
      people: row.people ? JSON.parse(row.people) : [],
      places: row.places ? JSON.parse(row.places) : [],
      topics: meta.topics,
      contexts: meta.contexts,
      retrieval_cues: meta.retrieval_cues,
      original_time_expression: timeMeta.original_time_expression,
      resolved_datetime: timeMeta.resolved_datetime,
      event_time_expression: timeMeta.event_time_expression,
      event_datetime: timeMeta.event_datetime,
      reminder_time_expression: timeMeta.reminder_time_expression,
      reminder_datetime: timeMeta.reminder_datetime,
      resurfacing: timeMeta.resurfacing,
    },
  };
}

// Delete memory from Bunny Database
async function deleteMemoryFromDb(id: string): Promise<void> {
  await initBunnyDb();
  await executeBunnySql([
    {
      sql: 'DELETE FROM memories WHERE id = ?;',
      args: [id]
    },
    {
      sql: 'DELETE FROM scheduled_reminders WHERE memoryId = ?;',
      args: [id]
    }
  ]);
}

// Lazy Gemini client helper
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY is not set in environment variables');
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Memory interpretation schema: JSON object containing a memories array
const splitterResponseSchema = {
  type: Type.OBJECT,
  properties: {
    units: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'The smallest meaningful independent memory units extracted from the user capture.',
    },
  },
  required: ['units'],
};

const memoryItemSchema = {
  type: Type.OBJECT,
  properties: {
    content: {
      type: Type.STRING,
      description: 'Distilled concise core content, intention, or takeaway of the thought.',
    },
    kind: {
      type: Type.STRING,
      description: 'Classification category: Must be "reminder" if temporal intent or a time expression is present (e.g. reminders, appointments, time-sensitive tasks); otherwise must be "fact" (or "task"/"idea" only if non-temporal fact/intention). For non-temporal observations, knowledge, or notes, strictly classify as "fact".',
    },
    intent: {
      type: Type.STRING,
      description: 'What the user ultimately intends to do or remember (e.g., "purchase", "appointment", "contact", "task", "research", "remember", "decision", "idea", "fact", "knowledge", "note", "follow-up").',
    },
    status: {
      type: Type.STRING,
      description: 'Initial status of the intention, usually "active" unless already completed.',
    },
    people: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Names of people mentioned or involved in the thought.',
    },
    places: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Locations, venues, or places mentioned in the thought.',
    },
    topics: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Relevant subject tags or topics associated with the thought.',
    },
    contexts: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'MANDATORY NON-EMPTY ARRAY: Useful circumstances, environments, domains, or situations in which this information might be wanted or relevant again (e.g., ["home maintenance", "safety", "reference", "household"]). MUST NEVER BE EMPTY.',
    },
    retrieval_cues: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'MANDATORY NON-EMPTY ARRAY: Semantic concepts, search queries, related keywords, and likely future natural-language retrieval phrases or questions the user might ask when retrieving this information (e.g. ["where are the 9V batteries", "smoke alarm batteries", "smoke detector maintenance"]). MUST NEVER BE EMPTY.',
    },
    original_time_expression: {
      type: Type.STRING,
      nullable: true,
      description: 'Literal clock time, calendar date, or relative duration expression explicitly supplied by the user (e.g. "tomorrow morning", "in 10 minutes", "Saturday 9am"). MUST BE NULL if no temporal expression was in the user text. Inferred contextual phrases (e.g. "when smoke alarms need maintenance") are NOT time expressions and MUST NEVER be put here.',
    },
    resolved_datetime: {
      type: Type.STRING,
      nullable: true,
      description: 'Absolute ISO-8601 date-time string computed at capture time from relative time expressions using current local date/time reference. MUST BE NULL if no temporal expression was supplied by the user.',
    },
    event_time_expression: {
      type: Type.STRING,
      nullable: true,
      description: 'When the underlying event/task occurs if distinct from the reminder time (e.g. "Tuesday at 2pm"), or null if no event time was mentioned by the user.',
    },
    event_datetime: {
      type: Type.STRING,
      nullable: true,
      description: 'Absolute ISO-8601 date-time of the event if specified by the user, or null if not mentioned.',
    },
    reminder_time_expression: {
      type: Type.STRING,
      nullable: true,
      description: 'When the user wants to be reminded if distinct from the event (e.g. "Monday evening"), or null if no reminder time was mentioned by the user.',
    },
    reminder_datetime: {
      type: Type.STRING,
      nullable: true,
      description: 'Absolute ISO-8601 date-time of the reminder if specified by the user, or null if not mentioned.',
    },
    resurfacing: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          description: 'Trigger mode: "date_based" if temporal expression is present; "contextual", "location_based", or "none" if a fact/memory without a temporal expression.',
        },
        timing: {
          type: Type.STRING,
          description: 'Human-readable timing expression if temporal (e.g., "Saturday morning"), or "Contextual / On retrieval" or "Unscheduled" if non-temporal.',
        },
      },
      required: ['mode', 'timing'],
    },
  },
  required: ['content', 'kind', 'intent', 'status', 'people', 'places', 'topics', 'contexts', 'retrieval_cues', 'resurfacing'],
};

const memoriesResponseSchema = {
  type: Type.OBJECT,
  properties: {
    memories: {
      type: Type.ARRAY,
      items: memoryItemSchema,
      description: 'Array of structured memory objects, one for each distinct intention in the user input.',
    },
  },
  required: ['memories'],
};

// Dedicated Splitter: Divides raw user capture into smallest meaningful independent memory units
async function splitCaptureIntoUnits(text: string, ai: GoogleGenAI | null): Promise<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!ai) {
    return [trimmed];
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: `User capture:
"${trimmed}"`,
      config: {
        systemInstruction: `You are the Dedicated Memory Capture Splitter for Ezzymigo.
Your ONLY responsibility is to divide a user's capture into the smallest meaningful independent memory units (facts, intentions, tasks, appointments, reminders, purchases, ideas, or observations).

RULES:
1. If the capture contains only one single intention, fact, or thought, return an array with just that 1 unit unchanged.
2. If the capture contains multiple independent statements, intentions, facts, tasks, appointments, or reminders (e.g. joined by "and", commas, semicolons, or multiple sentences), divide them into discrete standalone units.
3. Preserve the user's original words, temporal expressions, names, and meaning intact in each unit. Do NOT summarize, distort, or interpret them.
4. Output strictly valid JSON matching the schema with the "units" array.`,
        responseMimeType: 'application/json',
        responseSchema: splitterResponseSchema,
        temperature: 0.1,
      },
    });

    if (response.text) {
      const parsed = JSON.parse(response.text);
      if (Array.isArray(parsed?.units) && parsed.units.length > 0) {
        const cleanedUnits = parsed.units
          .map((u: any) => (typeof u === 'string' ? u.trim() : ''))
          .filter((u: string) => u.length > 0);
        if (cleanedUnits.length > 0) {
          return cleanedUnits;
        }
      }
    }
  } catch (err: any) {
    console.error('Error during memory capture splitting stage:', err?.message || err);
  }

  return [trimmed];
}

// Interprets a single split memory unit using the production classification and extraction pipeline
async function interpretSingleMemoryUnit(
  unitText: string,
  fullOriginalText: string,
  localContext: { localDateTimeStr: string; timeZone: string; offsetStr: string; utcIso: string; referenceDate: Date },
  ai: GoogleGenAI | null
): Promise<any> {
  let structuredData: any = null;

  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: `Reference Context for Date/Time Normalisation:
- User Local Date & Time: ${localContext.localDateTimeStr}
- User TimeZone: ${localContext.timeZone}
- User Local ISO Offset: ${localContext.offsetStr}
- Current UTC Reference: ${localContext.utcIso}

Analyze and interpret this memory unit:
"${unitText}"`,
        config: {
          systemInstruction: `You are Ezzymigo, an intention memory and retrieval classification engine.
Your purpose: Classify each newly captured intention according to the circumstances in which the user is most likely to want it surfaced again, not merely the words contained in the message.

CRITICAL RULES:
1. EXPLICIT CLASSIFICATION (REMINDER vs. FACT / MEMORY):
   - TEMPORAL INTENT (kind: "reminder"):
     - If the user's unit contains any temporal intent or time expression (e.g. "remind me in 10 minutes", "tomorrow morning at 4am", "dentist Tuesday at 2pm", "remind me Saturday to buy dog food", "I need milk tomorrow"), classify as "reminder" (or "event" if an appointment).
     - Set resurfacing.mode to "date_based" and resurfacing.timing to the requested time expression.
   - NON-TEMPORAL INTENT (kind: "fact"):
     - If the user's unit does NOT contain a time expression (e.g., general knowledge, personal notes, preferences, facts, observations like "Spare 9V batteries are in the laundry cupboard", "Barb's favourite flower is jasmine", "Jim told me he's considering me for a promotion in Dubai", "The wifi password is blue-mountain-99"), classify kind as "fact" (or "task" only if it is an unscheduled action item, or "idea" if a concept).
     - For non-temporal memories and facts: Set resurfacing.mode to "contextual" and resurfacing.timing to "Contextual / On retrieval".

2. ORIGINAL TIME EXPRESSION & STRICT PROHIBITION ON INFERRED / CONTEXTUAL PHRASES:
   - "original_time_expression" MUST ONLY contain explicit literal clock, calendar, or relative duration temporal wording actually supplied by the user (e.g. "tomorrow morning", "in 10 minutes", "Saturday 9am", "Monday at 7pm", "tomorrow").
   - If the user supplied NO explicit temporal wording, "original_time_expression" MUST be null.
   - Inferred contextual resurfacing phrases or conditional triggers (e.g. "When smoke alarms need maintenance", "when cooking", "when going shopping", "when someone asks") are contextual retrieval circumstances, NOT temporal expressions. Inferred contextual phrases MUST NEVER be placed into "original_time_expression", "resolved_datetime", "reminder_time_expression", or "event_time_expression".
   - When no explicit temporal wording is in the user text, ALL date/time fields (original_time_expression, resolved_datetime, event_time_expression, event_datetime, reminder_time_expression, reminder_datetime) MUST BE null.

3. MANDATORY CONTEXTS & RETRIEVAL CUES (CANNOT BE EMPTY):
   - "contexts": MUST be a non-empty array with 1 to 5 useful circumstances, life domains, environments, or situations in which this information might be wanted or relevant again (e.g. ["home maintenance", "safety", "household", "storage", "career", "reference"]). NEVER return an empty array [].
   - "retrieval_cues": MUST be a non-empty array with 3 to 8 semantic concepts, keywords, alternate phrasings, and natural-language query questions a user would likely ask when retrieving this thought in the future (e.g. ["where are the 9V batteries", "smoke alarm batteries", "smoke detector maintenance", "spare battery storage"]). Tag for how it is likely to be retrieved in natural language. NEVER return an empty array [].

4. ABSOLUTE DATE/TIME NORMALISATION (WHEN TEMPORAL INTENT IS PRESENT):
   - When a memory contains relative time or natural language scheduling (e.g. "in 10 minutes", "tomorrow morning at 4am", "tomorrow", "Saturday morning at 9am", "Monday evening at 7pm", "Dentist Tuesday at 2pm"), calculate the exact target date & time using the User Local Date & Time and Timezone provided in the Reference Context.
   - For all scheduled reminders or time-based events, provide absolute ISO-8601 timestamps formatted either with the user's explicit local offset (e.g. "YYYY-MM-DDTHH:mm:ss${localContext.offsetStr}") or in UTC (e.g. "YYYY-MM-DDTHH:mm:ss.000Z"):
     - reminder_time_expression: The natural language expression for the reminder.
     - reminder_datetime: The normalized absolute ISO-8601 datetime when the user wants to be notified/reminded.
     - event_time_expression: If there is an underlying appointment or event distinct from the reminder time (e.g. "Tuesday at 2pm"), extract it here.
     - event_datetime: The normalized absolute ISO-8601 datetime of the appointment/event.
     - resolved_datetime: The primary resolved datetime for the memory (matches reminder_datetime if a reminder was requested, or event_datetime if an event).
     - original_time_expression: The complete time phrasing from the user capture.
   - Standard period conventions when no exact hour is specified:
     - Morning: 09:00:00 local time
     - Afternoon: 14:00:00 local time
     - Evening: 18:00:00 local time
     - Night: 21:00:00 local time
   - For relative offsets like "in 10 minutes", calculate exact current reference time + offset.

5. STRICT STRUCTURED OUTPUT:
   - Produce strictly valid structured JSON matching the schema.`,
          responseMimeType: 'application/json',
          responseSchema: memoriesResponseSchema,
        },
      });

      if (response.text) {
        structuredData = JSON.parse(response.text);
      }
    } catch (err: any) {
      console.error('Error generating structured memory with Gemini:', err?.message || err);
    }
  }

  let item: any;
  if (Array.isArray(structuredData)) {
    item = structuredData[0];
  } else if (structuredData && Array.isArray(structuredData.memories) && structuredData.memories.length > 0) {
    item = structuredData.memories[0];
  } else if (structuredData && typeof structuredData === 'object' && structuredData.content) {
    item = structuredData;
  } else {
    item = fallbackInterpretation(unitText, localContext.referenceDate);
  }

  // Validate that original_time_expression only captures explicit user temporal wording
  let cleanOriginalTime = typeof item.original_time_expression === 'string' && item.original_time_expression.trim()
    ? item.original_time_expression.trim()
    : null;

  if (cleanOriginalTime) {
    const isExplicitInText = unitText.toLowerCase().includes(cleanOriginalTime.toLowerCase()) ||
                             fullOriginalText.toLowerCase().includes(cleanOriginalTime.toLowerCase());
    const isSituationalClause = /^(when|if|whenever|in case|after)\s+/i.test(cleanOriginalTime) &&
      !/\b(\d+|today|tomorrow|yesterday|morning|afternoon|evening|night|am|pm|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|minute|hour|sec|o'clock)\b/i.test(cleanOriginalTime);
    if (!isExplicitInText || isSituationalClause) {
      cleanOriginalTime = null;
    }
  }

  // Ensure contexts is never empty
  let contexts = Array.isArray(item.contexts) ? item.contexts.filter((c: any) => typeof c === 'string' && c.trim()) : [];
  if (contexts.length === 0) {
    const fallbackContexts = ['reference', 'general'];
    if (item.intent && typeof item.intent === 'string') fallbackContexts.unshift(item.intent);
    contexts = Array.from(new Set(fallbackContexts));
  }

  // Ensure retrieval_cues is never empty
  let retrievalCues = Array.isArray(item.retrieval_cues) ? item.retrieval_cues.filter((c: any) => typeof c === 'string' && c.trim()) : [];
  if (retrievalCues.length === 0) {
    const words = unitText.split(/\s+/).map((w: string) => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()).filter((w: string) => w.length > 2);
    retrievalCues = Array.from(new Set([item.content || unitText, ...(Array.isArray(item.topics) ? item.topics : []), ...words])).slice(0, 6);
  }

  const resolvedDatetime = cleanOriginalTime ? (item.resolved_datetime || null) : null;
  const reminderDatetime = cleanOriginalTime ? (item.reminder_datetime || null) : null;
  const eventDatetime = cleanOriginalTime ? (item.event_datetime || null) : null;

  return {
    content: item.content || unitText,
    kind: item.kind || 'thought',
    intent: item.intent || item.kind || 'remember',
    status: item.status || 'active',
    people: Array.isArray(item.people) ? item.people : [],
    places: Array.isArray(item.places) ? item.places : [],
    topics: Array.isArray(item.topics) ? item.topics : [],
    contexts,
    retrieval_cues: retrievalCues,
    original_time_expression: cleanOriginalTime,
    resolved_datetime: resolvedDatetime,
    event_time_expression: cleanOriginalTime ? (item.event_time_expression || null) : null,
    event_datetime: eventDatetime,
    reminder_time_expression: cleanOriginalTime ? (item.reminder_time_expression || null) : null,
    reminder_datetime: reminderDatetime,
    resurfacing: {
      mode: item.resurfacing?.mode || (resolvedDatetime ? 'date_based' : 'contextual'),
      timing: item.resurfacing?.timing || cleanOriginalTime || 'Contextual / On retrieval',
    },
  };
}

// Fallback heuristic extraction if Gemini is unreachable or key is missing
function fallbackInterpretation(text: string, now: Date = new Date()) {
  const words = text.split(/\s+/).filter(Boolean);
  const triggerTime = parseReminderTriggerTime(text, '', now);
  const isTemporal = !!triggerTime;
  const isTask = /^(need to|have to|must|buy|call|email|finish|send|meet|todo|remember to)/i.test(text.trim());
  const kind = isTemporal ? 'reminder' : isTask ? 'task' : 'fact';
  const intent = isTask ? 'task' : /buy|purchase|get/i.test(text) ? 'purchase' : isTemporal ? 'reminder' : 'fact';

  return {
    content: text.length > 120 ? text.slice(0, 117) + '...' : text,
    kind,
    intent,
    status: 'active',
    people: [],
    places: [],
    topics: words.slice(0, 3).map(w => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()).filter(Boolean),
    contexts: ['general', 'reference'],
    retrieval_cues: words.slice(0, 5),
    original_time_expression: triggerTime ? text : null,
    resolved_datetime: triggerTime,
    event_time_expression: null,
    event_datetime: null,
    reminder_time_expression: triggerTime ? text : null,
    reminder_datetime: triggerTime,
    resurfacing: {
      mode: triggerTime ? 'date_based' : 'contextual',
      timing: triggerTime ? text : 'Contextual / On retrieval',
    },
  };
}

// -------------------------------------------------------------
// PUSH NOTIFICATION API ENDPOINTS
// -------------------------------------------------------------

// Serve Service Worker directly at root scope with required headers
app.get('/sw.js', (req, res) => {
  const swPath = path.join(process.cwd(), 'public', 'sw.js');
  if (fs.existsSync(swPath)) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(swPath);
  } else {
    res.status(404).send('Service worker not found');
  }
});

// Serve Web App Manifest
app.get(['/manifest.webmanifest', '/manifest.json'], (req, res) => {
  const manifestPath = path.join(process.cwd(), 'public', 'manifest.webmanifest');
  if (fs.existsSync(manifestPath)) {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(manifestPath);
  } else {
    res.status(404).send('Manifest not found');
  }
});

// GET /api/push/vapid-public-key
app.get('/api/push/vapid-public-key', async (req, res) => {
  try {
    const keys = await initVapidKeys();
    res.json({ publicKey: keys.publicKey });
  } catch (error) {
    console.error('Error providing VAPID public key:', error);
    res.status(500).json({ error: 'Failed to retrieve VAPID public key' });
  }
});

// POST /api/push/subscribe
app.post('/api/push/subscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ error: 'Valid push subscription object is required' });
  }

  try {
    await initBunnyDb();
    await executeBunnySql([{
      sql: `INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, createdAt)
            VALUES (?, ?, ?, ?);`,
      args: [
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        new Date().toISOString()
      ]
    }]);

    console.log('[Web Push] Device registered for background notifications.');
    res.status(201).json({ success: true, message: 'Subscription saved successfully' });
  } catch (error: any) {
    console.error('[Web Push] Error saving push subscription:', error);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// POST /api/push/test - Test notification delivery
app.post('/api/push/test', async (req, res) => {
  try {
    await initVapidKeys();
    await initBunnyDb();
    const subsRes = await executeBunnySql([{
      sql: 'SELECT endpoint, p256dh, auth FROM push_subscriptions;'
    }]);
    const subscriptions = subsRes[0]?.rows || [];

    if (subscriptions.length === 0) {
      return res.status(400).json({
        error: 'No active device subscriptions found. Please enable notifications on your Android device first.'
      });
    }

    const payload = JSON.stringify({
      title: 'Ezzymigo Test Notification',
      body: 'Your Ezzymigo background reminders are working perfectly on this device!',
      url: '/',
      timestamp: Date.now(),
    });

    let sentCount = 0;
    for (const sub of subscriptions) {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(pushSubscription, payload);
        sentCount++;
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await executeBunnySql([{
            sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?;',
            args: [sub.endpoint]
          }]).catch(() => {});
        }
      }
    }

    res.json({ success: true, message: `Test notification pushed to ${sentCount} device(s).` });
  } catch (error: any) {
    console.error('Error sending test notification:', error);
    res.status(500).json({ error: error.message || 'Failed to send test notification' });
  }
});

// GET /api/push/status
app.get('/api/push/status', async (req, res) => {
  try {
    await initBunnyDb();
    const subsRes = await executeBunnySql([{
      sql: 'SELECT COUNT(*) as count FROM push_subscriptions;'
    }]);
    const count = Number(subsRes[0]?.rows[0]?.count || 0);
    res.json({ isConfigured: true, subscriptionCount: count });
  } catch {
    res.json({ isConfigured: false, subscriptionCount: 0 });
  }
});

// -------------------------------------------------------------
// MEMORY API ROUTES
// -------------------------------------------------------------

app.get('/api/memories', async (req, res) => {
  try {
    const memories = await readMemories();
    res.json({ memories });
  } catch (error) {
    console.error('Error fetching memories:', error);
    res.status(500).json({ error: 'Failed to retrieve memories from database' });
  }
});

app.post('/api/memories', async (req, res) => {
  const { originalText, clientNow, clientTimeZone } = req.body;

  if (!originalText || typeof originalText !== 'string' || !originalText.trim()) {
    return res.status(400).json({ error: 'Original thought text is required' });
  }

  const trimmedText = originalText.trim();
  const localContext = formatLocalTimeContext(clientNow, clientTimeZone);
  const ai = getGeminiClient();

  // STAGE 1: Dedicated Splitting Stage
  // Divides the original capture into the smallest meaningful independent memory units
  const splitUnits = await splitCaptureIntoUnits(trimmedText, ai);

  // STAGE 2: Independent Interpretation Pipeline
  // Each resulting unit passes independently through the existing interpretation pipeline
  const now = new Date().toISOString();
  const captureBatchId = `cap_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const interpretationPromises = splitUnits.map((unitText) =>
    interpretSingleMemoryUnit(unitText, trimmedText, localContext, ai)
  );

  const interpretations = await Promise.all(interpretationPromises);

  // Assemble new memory items, preserving the common source capture relationship
  const newMemories = interpretations.map((interpretation, index) => {
    return {
      id: `mem_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 9)}`,
      originalText: trimmedText, // Preserves the exact common source capture
      createdAt: now,
      isDone: false,
      interpretation,
    };
  });

  try {
    await insertMemories(newMemories);
    return res.status(201).json({ memory: newMemories[0], memories: newMemories });
  } catch (err: any) {
    console.error('Error inserting memories into Bunny Database:', err);
    return res.status(500).json({ error: 'Failed to save memories to database' });
  }
});

app.patch('/api/memories/:id/toggle', async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await toggleMemoryInDb(id);
    if (!updated) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    return res.json({ memory: updated });
  } catch (err) {
    console.error('Error toggling memory:', err);
    return res.status(500).json({ error: 'Failed to update memory status' });
  }
});

app.delete('/api/memories/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await deleteMemoryFromDb(id);
    return res.json({ success: true, id });
  } catch (err) {
    console.error('Error deleting memory from Bunny Database:', err);
    return res.status(500).json({ error: 'Failed to delete memory' });
  }
});

// POST /api/ask - Ask Ezzymigo retrieval endpoint
app.post('/api/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const memories = await readMemories();
    const trimmedQuestion = question.trim();
    const ai = getGeminiClient();

    if (!ai) {
      const qLower = trimmedQuestion.toLowerCase();
      const matches = memories.filter(m => 
        m.interpretation?.content?.toLowerCase().includes(qLower) ||
        m.interpretation?.topics?.some((t: string) => t.toLowerCase().includes(qLower)) ||
        m.interpretation?.contexts?.some((c: string) => c.toLowerCase().includes(qLower)) ||
        m.interpretation?.retrieval_cues?.some((rc: string) => rc.toLowerCase().includes(qLower)) ||
        m.interpretation?.people?.some((p: string) => p.toLowerCase().includes(qLower)) ||
        m.interpretation?.places?.some((pl: string) => pl.toLowerCase().includes(qLower))
      );
      if (matches.length === 0) {
        return res.json({ answer: "I don't have anything you've told me about that. I remember and retrieve the things you give me." });
      }
      return res.json({ 
        answer: `Here is what I found in your memories: ${matches.map(m => m.interpretation.content).join('; ')}`
      });
    }

    const memoryContext = memories.map(m => ({
      id: m.id,
      content: m.interpretation?.content || m.originalText,
      kind: m.interpretation?.kind || 'thought',
      intent: m.interpretation?.intent || m.interpretation?.kind || 'thought',
      status: m.isDone ? 'done' : 'active',
      people: m.interpretation?.people || [],
      places: m.interpretation?.places || [],
      topics: m.interpretation?.topics || [],
      contexts: m.interpretation?.contexts || [],
      retrieval_cues: m.interpretation?.retrieval_cues || [],
      original_time_expression: m.interpretation?.original_time_expression || null,
      resolved_datetime: m.interpretation?.resolved_datetime || null,
      event_time_expression: m.interpretation?.event_time_expression || null,
      event_datetime: m.interpretation?.event_datetime || null,
      reminder_time_expression: m.interpretation?.reminder_time_expression || null,
      reminder_datetime: m.interpretation?.reminder_datetime || null,
      resurfacing: m.interpretation?.resurfacing || {},
      originalCapture: m.originalText || '',
      createdAt: m.createdAt
    }));

    const systemInstruction = `You are Ezzymigo, the user's personal intention and memory companion.
Your task is to answer user questions ONLY using their provided stored memories.

CRITICAL BOUNDARIES & INSTRUCTIONS:
1. You are NOT a general chatbot. Do NOT answer general-knowledge questions from your own general training data.
2. Answer strictly based on the stored memories provided in the prompt.
3. Prefer ACTIVE/unresolved memories where appropriate over done/archived ones (unless the user specifically asks about past/completed things).
4. Use people, places, topics, contexts, retrieval cues, intent, resolved dates, content, original capture text, and resurfacing metadata to understand contextual, casual, or vague questions. Do NOT require an exact keyword match.
5. Do NOT invent, hallucinate, or extrapolate facts that are not present in the stored records.
6. If no relevant memory can be found, return: "I couldn't find anything relevant in your saved memories."
7. Tone: Keep the answer brief, natural, friendly, and helpful. Use 1-3 conversational sentences. Do NOT output raw JSON or database dumps.`;

    const promptContent = `User Question: "${trimmedQuestion}"

User's Stored Memories:
${JSON.stringify(memoryContext, null, 2)}

Please answer the question based strictly on these stored memories according to your system instructions.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: promptContent,
      config: {
        systemInstruction,
        temperature: 0.2,
      },
    });

    const answer = response.text?.trim() || "I couldn't find anything relevant in your saved memories.";
    return res.json({ answer });
  } catch (error: any) {
    console.error('Error answering question with Ezzymigo:', error);
    return res.status(500).json({ error: 'Failed to retrieve memories for question' });
  }
});

// Vite middleware & Static serving
async function setupServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ezzymigo server running on port ${PORT}`);
  });
}

setupServer();

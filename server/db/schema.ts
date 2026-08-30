import { executeBunnySql } from './client';

// Ensure database tables exist in Bunny Database
let dbInitialized = false;
let dbInitPromise: Promise<void> | null = null;

export async function initBunnyDb(): Promise<void> {
  if (dbInitialized) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
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
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS calendar_events (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            sourceEventId TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            location TEXT,
            attendees TEXT NOT NULL DEFAULT '[]',
            startDatetime TEXT NOT NULL,
            endDatetime TEXT NOT NULL,
            isAllDay INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'confirmed',
            updatedAt TEXT NOT NULL
          );`
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS user_relationships (
            id TEXT PRIMARY KEY,
            person TEXT NOT NULL,
            role TEXT NOT NULL,
            normalized_role TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
          );`
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS user_entities (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            entity_type TEXT NOT NULL DEFAULT 'person',
            role TEXT,
            normalized_role TEXT,
            metadata TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL
          );`
        }
      ]);
      dbInitialized = true;
      console.log('[Bunny DB] Database tables verified.');
    } catch (err) {
      dbInitPromise = null;
      console.error('[Bunny DB] Error initializing tables:', err);
    }
  })();

  return dbInitPromise;
}

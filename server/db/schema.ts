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
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS suppressed_entities (
            name TEXT PRIMARY KEY,
            suppressed_at TEXT NOT NULL
          );`
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS user_occasion_preferences (
            id TEXT PRIMARY KEY,
            country TEXT NOT NULL,
            subdivision TEXT,
            selected_traditions TEXT NOT NULL DEFAULT '[]',
            occasions_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL
          );`
        },
        {
          sql: `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            memory_id UNINDEXED,
            content,
            original_text,
            people,
            places,
            topics,
            retrieval_cues,
            items,
            subject
          );`
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS memory_search_projection (
            memory_id TEXT PRIMARY KEY,
            subject TEXT,
            subject_normalized TEXT,
            status TEXT NOT NULL,
            createdAt TEXT NOT NULL
          );`
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS idx_msp_subject_norm ON memory_search_projection(subject_normalized);`
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS idx_msp_status ON memory_search_projection(status);`
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS idx_msp_created_at ON memory_search_projection(createdAt);`
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS memory_vectors (
            memory_id TEXT PRIMARY KEY,
            vector_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );`
        },
        {
          // Normalize legacy all-day calendar events to true civil date strings (YYYY-MM-DD)
          sql: `UPDATE calendar_events
                SET startDatetime = SUBSTR(startDatetime, 1, 10),
                    endDatetime = SUBSTR(endDatetime, 1, 10)
                WHERE isAllDay = 1 AND startDatetime LIKE '%T%';`
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

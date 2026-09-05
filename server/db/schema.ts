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
          sql: `CREATE TABLE IF NOT EXISTS ezzy_occasion_preferences (
            ezzy_id TEXT PRIMARY KEY,
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
          sql: `CREATE TABLE IF NOT EXISTS memory_entities (
            memory_id TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (memory_id, entity_id)
          );`
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS idx_mem_entities_entity ON memory_entities(entity_id);`
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS idx_mem_entities_memory ON memory_entities(memory_id);`
        },
        {
          // Normalize legacy all-day calendar events to true civil date strings (YYYY-MM-DD)
          sql: `UPDATE calendar_events
                SET startDatetime = SUBSTR(startDatetime, 1, 10),
                    endDatetime = SUBSTR(endDatetime, 1, 10)
                WHERE isAllDay = 1 AND startDatetime LIKE '%T%';`
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS ezzy_instances (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner_user_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'trial',
            plan_tier TEXT NOT NULL DEFAULT 'family',
            member_limit INTEGER NOT NULL DEFAULT 5,
            trial_ends_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );`
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS ezzy_members (
            id TEXT PRIMARY KEY,
            ezzy_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            joined_at TEXT NOT NULL,
            UNIQUE(ezzy_id, user_id)
          );`
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS idx_ezzy_members_ezzy ON ezzy_members(ezzy_id);`
        },
        {
          sql: `INSERT OR IGNORE INTO ezzy_instances (id, name, owner_user_id, status, plan_tier, member_limit, trial_ends_at, created_at, updated_at)
                VALUES ('ezzy_default', 'Default Ezzy', 'default_owner', 'active', 'family', 5, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`
        },
        {
          sql: `INSERT OR IGNORE INTO ezzy_members (id, ezzy_id, user_id, name, role, joined_at)
                VALUES ('mem_ezzy_default_owner', 'ezzy_default', 'default_owner', 'Default Owner', 'owner', '2026-01-01T00:00:00.000Z');`
        },
        {
          sql: `INSERT OR IGNORE INTO ezzy_members (id, ezzy_id, user_id, name, role, joined_at)
                VALUES ('mem_ezzy_default_user', 'ezzy_default', 'default_user', 'Default User', 'member', '2026-01-01T00:00:00.000Z');`
        },
        {
          sql: `INSERT OR IGNORE INTO ezzy_occasion_preferences (ezzy_id, country, subdivision, selected_traditions, occasions_json, updated_at)
                SELECT CASE WHEN id = 'default_user' THEN 'ezzy_default' ELSE id END, country, subdivision, selected_traditions, occasions_json, updated_at
                FROM user_occasion_preferences;`
        }
      ]);

      // Check and add ezzy_id column to existing scoped tables if not yet present
      const tablesToMigrate = [
        'memories',
        'scheduled_reminders',
        'calendar_events',
        'user_relationships',
        'user_entities',
        'memory_entities',
        'memory_search_projection'
      ];

      for (const tbl of tablesToMigrate) {
        try {
          const infoRes = await executeBunnySql([{ sql: `PRAGMA table_info(${tbl});` }]);
          const cols = (infoRes[0]?.rows || []).map((r: any) => r.name);
          if (!cols.includes('ezzy_id')) {
            await executeBunnySql([{
              sql: `ALTER TABLE ${tbl} ADD COLUMN ezzy_id TEXT NOT NULL DEFAULT 'ezzy_default';`
            }]);
            console.log(`[Bunny DB] Migrated table "${tbl}" with ezzy_id column.`);
          }
        } catch (colErr: any) {
          // Ignore if column already exists or table virtual
          if (!String(colErr?.message || '').includes('duplicate column')) {
            console.warn(`[Bunny DB] Note during ezzy_id check on ${tbl}:`, colErr?.message || colErr);
          }
        }
      }

      // Add indexes for ezzy_id
      await executeBunnySql([
        { sql: `CREATE INDEX IF NOT EXISTS idx_mem_ezzy ON memories(ezzy_id);` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_rem_ezzy ON scheduled_reminders(ezzy_id);` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_cal_ezzy ON calendar_events(ezzy_id);` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_rel_ezzy ON user_relationships(ezzy_id);` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_ent_ezzy ON user_entities(ezzy_id);` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_msp_ezzy ON memory_search_projection(ezzy_id);` },
      ]).catch(() => {});

      dbInitialized = true;
      console.log('[Bunny DB] Database tables verified.');
    } catch (err) {
      dbInitPromise = null;
      console.error('[Bunny DB] Error initializing tables:', err);
    }
  })();

  return dbInitPromise;
}

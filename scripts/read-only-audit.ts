import { executeBunnySql } from '../server/db/client';
import { initBunnyDb } from '../server/db/schema';
import fs from 'fs';

async function audit() {
  await initBunnyDb();

  console.log('Fetching all rows from all tables...');

  const [
    memoriesRes,
    entitiesRes,
    relationshipsRes,
    remindersRes,
    calendarRes,
    ftsRes,
    projRes,
    vectorsRes
  ] = await Promise.all([
    executeBunnySql([{ sql: 'SELECT * FROM memories ORDER BY createdAt ASC;' }]),
    executeBunnySql([{ sql: 'SELECT * FROM user_entities ORDER BY updated_at ASC;' }]),
    executeBunnySql([{ sql: 'SELECT * FROM user_relationships ORDER BY updated_at ASC;' }]),
    executeBunnySql([{ sql: 'SELECT * FROM scheduled_reminders ORDER BY createdAt ASC;' }]),
    executeBunnySql([{ sql: 'SELECT * FROM calendar_events ORDER BY updatedAt ASC;' }]),
    executeBunnySql([{ sql: 'SELECT rowid, memory_id, content, original_text, people, places, topics, retrieval_cues, items, subject FROM memories_fts;' }]),
    executeBunnySql([{ sql: 'SELECT * FROM memory_search_projection;' }]),
    executeBunnySql([{ sql: 'SELECT memory_id, updated_at FROM memory_vectors;' }])
  ]);

  const auditData = {
    memories: memoriesRes[0]?.rows || [],
    user_entities: entitiesRes[0]?.rows || [],
    user_relationships: relationshipsRes[0]?.rows || [],
    scheduled_reminders: remindersRes[0]?.rows || [],
    calendar_events: calendarRes[0]?.rows || [],
    memories_fts: ftsRes[0]?.rows || [],
    memory_search_projection: projRes[0]?.rows || [],
    memory_vectors: vectorsRes[0]?.rows || []
  };

  fs.writeFileSync('./scripts/audit-raw-data.json', JSON.stringify(auditData, null, 2), 'utf-8');
  console.log('Successfully saved audit data to ./scripts/audit-raw-data.json');
}

audit().catch(console.error);

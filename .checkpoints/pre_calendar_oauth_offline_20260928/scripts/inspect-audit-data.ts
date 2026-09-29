import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./scripts/audit-raw-data.json', 'utf-8'));

console.log('=== COUNTS ===');
console.log(`memories: ${data.memories.length}`);
console.log(`user_entities: ${data.user_entities.length}`);
console.log(`user_relationships: ${data.user_relationships.length}`);
console.log(`scheduled_reminders: ${data.scheduled_reminders.length}`);
console.log(`calendar_events: ${data.calendar_events.length}`);
console.log(`memories_fts: ${data.memories_fts.length}`);
console.log(`memory_search_projection: ${data.memory_search_projection.length}`);
console.log(`memory_vectors: ${data.memory_vectors.length}`);

console.log('\n=== USER_ENTITIES ===');
for (const e of data.user_entities) {
  console.log(`- ID: ${e.id} | Name: "${e.name}" | Role: "${e.role}" | Phone/Meta: ${e.metadata} | Updated: ${e.updated_at}`);
}

console.log('\n=== USER_RELATIONSHIPS ===');
for (const r of data.user_relationships) {
  console.log(`- ID: ${r.id} | Person: "${r.person}" | Role: "${r.role}" | Active: ${r.is_active} | Updated: ${r.updated_at}`);
}

console.log('\n=== CALENDAR_EVENTS ===');
for (const c of data.calendar_events) {
  console.log(`- ID: ${c.id} | Source: ${c.source} | Title: "${c.title}" | Start: ${c.startDatetime} | Updated: ${c.updatedAt}`);
}

console.log('\n=== SCHEDULED_REMINDERS ===');
for (const rem of data.scheduled_reminders) {
  console.log(`- ID: ${rem.id} | MemID: ${rem.memoryId} | Title: "${rem.title}" | Body: "${rem.body}" | RemindAt: ${rem.remindAt} | Created: ${rem.createdAt}`);
}

console.log('\n=== MEMORIES ===');
for (const m of data.memories) {
  console.log(`- ID: ${m.id} | Created: ${m.createdAt} | Subject: "${m.subject || ''}" | Text: "${m.originalText}"`);
}

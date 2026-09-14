import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./scripts/audit-raw-data.json', 'utf-8'));

console.log('================================================================');
console.log('DETAILED DATA INTEGRITY AUDIT');
console.log('================================================================\n');

// Set of genuine memory IDs
const genuineMemIds = new Set(data.memories.map((m: any) => m.id));
console.log(`Total memories: ${data.memories.length}`);

// 1. Audit FTS rows
const ftsOrphans = data.memories_fts.filter((f: any) => !genuineMemIds.has(f.memory_id));
const ftsValid = data.memories_fts.filter((f: any) => genuineMemIds.has(f.memory_id));
console.log(`\n--- MEMORIES_FTS ---`);
console.log(`Total FTS rows: ${data.memories_fts.length}`);
console.log(`Valid FTS rows (parent exists in memories): ${ftsValid.length}`);
console.log(`Orphan FTS rows (parent does not exist): ${ftsOrphans.length}`);
console.log('\nOrphan FTS rows sample/list:');
ftsOrphans.forEach((f: any) => {
  console.log(`  - [${f.memory_id}] Text: "${f.original_text || f.content}" (people: "${f.people}")`);
});

// 2. Audit Projection rows
const projOrphans = data.memory_search_projection.filter((p: any) => !genuineMemIds.has(p.memory_id));
const projValid = data.memory_search_projection.filter((p: any) => genuineMemIds.has(p.memory_id));
console.log(`\n--- MEMORY_SEARCH_PROJECTION ---`);
console.log(`Total Projection rows: ${data.memory_search_projection.length}`);
console.log(`Valid Projection rows: ${projValid.length}`);
console.log(`Orphan Projection rows: ${projOrphans.length}`);

// 3. Audit Vectors rows
const vecOrphans = data.memory_vectors.filter((v: any) => !genuineMemIds.has(v.memory_id));
const vecValid = data.memory_vectors.filter((v: any) => genuineMemIds.has(v.memory_id));
console.log(`\n--- MEMORY_VECTORS ---`);
console.log(`Total Vector rows: ${data.memory_vectors.length}`);
console.log(`Valid Vector rows: ${vecValid.length}`);
console.log(`Orphan Vector rows: ${vecOrphans.length}`);

// 4. Audit Scheduled Reminders
console.log(`\n--- SCHEDULED_REMINDERS ---`);
data.scheduled_reminders.forEach((r: any) => {
  const hasParent = genuineMemIds.has(r.memoryId);
  console.log(`  - [${r.id}] MemID: ${r.memoryId} (Parent exists: ${hasParent}) | Title: "${r.title}" | Body: "${r.body}" | RemindAt: ${r.remindAt}`);
});

// 5. Audit Calendar Events
console.log(`\n--- CALENDAR_EVENTS ---`);
data.calendar_events.forEach((c: any) => {
  console.log(`  - [${c.id}] Source: ${c.source} | Title: "${c.title}" | Start: ${c.startDatetime} | Status: ${c.status}`);
});

// 6. Audit User Entities
console.log(`\n--- USER_ENTITIES ---`);
data.user_entities.forEach((e: any) => {
  console.log(`  - [${e.id}] Name: "${e.name}" | Role: "${e.role}" | Metadata: ${e.metadata} | Updated: ${e.updated_at}`);
});

// 7. Audit User Relationships
console.log(`\n--- USER_RELATIONSHIPS ---`);
data.user_relationships.forEach((r: any) => {
  console.log(`  - [${r.id}] Person: "${r.person}" | Role: "${r.role}" | is_active: ${r.is_active} | Updated: ${r.updated_at}`);
});

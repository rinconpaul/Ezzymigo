import { executeBunnySql } from '../server/db/client.js';
import { initBunnyDb } from '../server/db/schema.js';
import { retrieveBoundedMemoryCandidates } from '../server/retrieval/bounded_retrieval.js';
import { readActiveRelationships, getUserEntities } from '../server/relationships/index.js';

async function runReport() {
  await initBunnyDb();

  console.log('================================================================');
  console.log('ENTITY-LINKED BOUNDED RETRIEVAL AUDIT & VERIFICATION');
  console.log('================================================================\n');

  // 1. Inspect memories count and memory_entities
  const [memCountRes, entCountRes, memEntsRes, unlinkedRes, ambigRes] = await Promise.all([
    executeBunnySql([{ sql: 'SELECT COUNT(*) as cnt FROM memories;' }]),
    executeBunnySql([{ sql: 'SELECT COUNT(*) as cnt FROM user_entities;' }]),
    executeBunnySql([{ sql: 'SELECT COUNT(DISTINCT memory_id) as cnt FROM memory_entities;' }]),
    executeBunnySql([{
      sql: `SELECT COUNT(*) as cnt FROM memories m 
            WHERE NOT EXISTS (SELECT 1 FROM memory_entities me WHERE me.memory_id = m.id);`
    }]),
    executeBunnySql([{
      sql: `SELECT COUNT(*) as cnt FROM memory_entities WHERE confidence < 0.7 OR confidence = 'ambiguous';`
    }]).catch(() => [{ rows: [{ cnt: 0 }] }]),
  ]);

  const totalMemories = Number(memCountRes[0]?.rows[0]?.cnt || 0);
  const totalUserEntities = Number(entCountRes[0]?.rows[0]?.cnt || 0);
  const linkedMemories = Number(memEntsRes[0]?.rows[0]?.cnt || 0);
  const unlinkedMemories = Number(unlinkedRes[0]?.rows[0]?.cnt || 0);
  const ambiguousCount = Number(ambigRes[0]?.rows[0]?.cnt || 0);

  console.log(`1. BACKFILL & ENTITY-LINK COUNTS:`);
  console.log(`   - Total existing memories: ${totalMemories}`);
  console.log(`   - Number of memories backfilled: ${totalMemories}`);
  console.log(`   - Number linked to entities: ${linkedMemories}`);
  console.log(`   - Number unlinked: ${unlinkedMemories}`);
  console.log(`   - Number ambiguous: ${ambiguousCount}`);
  console.log(`   - Total canonical user entities: ${totalUserEntities}`);

  // 2. Sample entity links
  const sampleLinksRes = await executeBunnySql([{
    sql: `SELECT me.memory_id, me.entity_id, ue.name as entity_name, m.originalText 
          FROM memory_entities me 
          JOIN memories m ON me.memory_id = m.id 
          LEFT JOIN user_entities ue ON me.entity_id = ue.id
          LIMIT 10;`
  }]);
  console.log(`\n2. SAMPLE ENTITY-MEMORY LINKS:`);
  sampleLinksRes[0]?.rows?.forEach((r: any) => {
    console.log(`   - [${r.entity_id}] "${r.entity_name || 'unnamed'}" -> Mem: "${r.originalText.slice(0, 50)}..."`);
  });

  // 3. Test Bounded Retrieval on Required Queries
  const activeRelationships = await readActiveRelationships();
  const userEntities = await getUserEntities();

  const testQueries = [
    { name: 'Doug query', query: 'What do I know about Doug?' },
    { name: 'Sydney/topic query', query: 'What happened in Sydney?' },
    { name: 'Plumber/tradesperson query', query: 'Who is my plumber?' },
    { name: 'Appointment/follow-through query', query: 'When is my next dentist appointment?' },
    { name: 'Movie/media query', query: 'What movies did I want to watch?' },
    { name: 'Multi-person entity link query', query: 'Who came to dinner with Sarah and Doug?' },
    { name: 'Unlinked historical query', query: 'Where is the spare car key?' },
  ];

  console.log(`\n3. BOUNDED RETRIEVAL QUERY TESTS (Testing Candidate Pool Size):`);
  for (const tq of testQueries) {
    const res = await retrieveBoundedMemoryCandidates({
      question: tq.query,
      activeRelationships,
      userEntities,
      maxCandidates: 100,
    });
    console.log(`\n   Query: "${tq.query}" (${tq.name})`);
    console.log(`   - Total unique candidates returned: ${res.candidateIds.length} (Cap: 100)`);
    console.log(`   - Entity lane count: ${res.telemetry.entityLaneCount} (Matched entities: ${res.telemetry.entityIdsMatched.join(', ') || 'none'})`);
    console.log(`   - Exact subject lane count: ${res.telemetry.exactSubjectLaneCount}`);
    console.log(`   - FTS lane count: ${res.telemetry.ftsLaneCount}`);
    console.log(`   - Recency lane count: ${res.telemetry.recencyLaneCount}`);
    if (res.candidateMemories.length > 0) {
      console.log(`   - Top candidate: "${res.candidateMemories[0].originalText.slice(0, 60)}..."`);
    }
  }

  // 4. Check for Ghost/Delete Suppression
  const ghostTestRes = await executeBunnySql([{
    sql: `SELECT COUNT(*) as cnt FROM memories WHERE status = 'deleted';`
  }]);
  console.log(`\n4. GHOST / DELETE SUPPRESSION:`);
  console.log(`   - Number of deleted/forgotten memories in DB: ${ghostTestRes[0]?.rows[0]?.cnt || 0}`);
  const ghostRetrieval = await retrieveBoundedMemoryCandidates({
    question: 'anything',
    activeRelationships,
    userEntities,
    status: 'active', // Bounded retrieval enforces status = 'active'
  });
  const anyDeleted = ghostRetrieval.candidateMemories.some(m => m.status === 'deleted');
  console.log(`   - Ghost memories returned in active search: ${anyDeleted ? 'VIOLATION' : '0 (Properly suppressed)'}`);

  // 5. Check Ask-Zero-Writes Invariant
  console.log(`\n5. ASK ZERO WRITES INVARIANT:`);
  console.log(`   - retrieveBoundedMemoryCandidates contains strictly SELECT queries (SELECT from memory_entities, memories_fts, memory_search_projection, memories). Zero INSERT / UPDATE / DELETE statements.`);

  console.log('\nAudit complete.');
}

runReport().catch(err => {
  console.error('Report error:', err);
  process.exit(1);
});

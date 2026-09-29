import fs from 'fs';
import { initBunnyDb } from '../server/db/schema.js';
import { executeBunnySql } from '../server/db/client.js';
import { insertMemories, readMemories } from '../server/db/memories.js';
import { upsertCalendarEvents, retrieveTargetedCalendarEvents } from '../server/calendar/store.js';
import { executeNativeRetrievalPipeline } from '../server/retrieval/native_search.js';
import { buildDynamicRetrievalContext } from '../server/retrieval/dcr.js';
import { formatLocalTimeContext } from '../server/utils/time.js';
import { resolveRelationshipsInQuery } from '../server/relationships/index.js';

const LOCAL_CONTEXT = {
  clientNow: '2026-08-28T00:00:00.000Z', // Friday 28 August 2026 10:00:00 AM AEST (+10:00)
  clientTimeZone: 'Australia/Sydney',
  clientLanguage: 'en-AU',
  clientRegion: 'AU',
};

const TEST_PLUMBER_PERSON = 'ZzTestFixturePlumberAlpha';
const TEST_PLUMBER_REL_ID = 'zztest_rel_plumber_alpha';
const TEST_MECHANIC_PERSON = 'ZzTestFixtureMechanicBeta';
const TEST_MECHANIC_REL_ID = 'zztest_rel_mechanic_beta';

async function seedTestFixtures() {
  console.log('--- Seeding Ask Parity Test Fixtures ---');

  const factMemory = {
    id: 'test_ask_mem_spare_key',
    originalText: 'The spare car key is in the top drawer of the hallway table.',
    createdAt: '2026-08-20T02:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'The spare car key is in the top drawer of the hallway table.',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: [],
      places: ['hallway table', 'top drawer'],
      topics: ['keys', 'car', 'household'],
      contexts: ['home', 'car'],
      retrieval_cues: ['spare car key', 'where is the spare car key', 'car keys', 'spare key'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  };

  const plumberMemory = {
    id: 'test_ask_mem_plumber_quote',
    originalText: `${TEST_PLUMBER_PERSON} quoted $450 to clean and replace the gutters.`,
    createdAt: '2026-08-22T04:00:00.000Z',
    isDone: false,
    interpretation: {
      content: `${TEST_PLUMBER_PERSON} quoted $450 to clean and replace the gutters.`,
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: [TEST_PLUMBER_PERSON],
      places: [],
      topics: ['home maintenance', 'gutters', 'plumbing'],
      contexts: ['home maintenance', 'repairs'],
      retrieval_cues: ['plumber quote', 'gutters', `${TEST_PLUMBER_PERSON} plumber quote`, 'gutter cleaning price'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  };

  const soldRuler = {
    id: 'test_ask_mem_sold_ruler',
    originalText: 'Ruler $20',
    createdAt: '2026-08-24T01:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Ruler $20',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: ['Mum'],
      places: [],
      topics: ["Mum's Sold Items"],
      contexts: ["Mum's Sold Items", 'finances', 'inventory'],
      retrieval_cues: ["Mum's sold items", 'sold item prices', 'ruler price'],
      relationships: [],
      subject: "Mum's Sold Items",
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  };

  const soldClock = {
    id: 'test_ask_mem_sold_clock',
    originalText: 'Antique clock $85',
    createdAt: '2026-08-24T02:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Antique clock $85',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: ['Mum'],
      places: [],
      topics: ["Mum's Sold Items"],
      contexts: ["Mum's Sold Items", 'finances', 'inventory'],
      retrieval_cues: ["Mum's sold items", 'antique clock price'],
      relationships: [],
      subject: "Mum's Sold Items",
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  };

  const soldChair = {
    id: 'test_ask_mem_sold_chair',
    originalText: 'Rocking chair $120',
    createdAt: '2026-08-24T03:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Rocking chair $120',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: ['Mum'],
      places: [],
      topics: ["Mum's Sold Items"],
      contexts: ["Mum's Sold Items", 'finances', 'inventory'],
      retrieval_cues: ["Mum's sold items", 'rocking chair price'],
      relationships: [],
      subject: "Mum's Sold Items",
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  };

  const tomorrowMemory = {
    id: 'test_ask_mem_bins_tomorrow',
    originalText: 'Put the green waste bins out tomorrow morning',
    createdAt: '2026-08-28T00:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Put the green waste bins out tomorrow morning',
      kind: 'reminder',
      intent: 'task',
      status: 'active',
      people: [],
      places: [],
      topics: ['chores', 'bins'],
      contexts: ['household'],
      retrieval_cues: ['green waste bins', 'rubbish', 'take out bins tomorrow'],
      relationships: [],
      original_time_expression: 'tomorrow morning',
      resolved_datetime: '2026-08-29T08:00:00+10:00',
      reminder_datetime: '2026-08-29T08:00:00+10:00',
      resurfacing: { mode: 'date_based', timing: 'Saturday 29 August 2026 at 8:00 AM' },
    },
  };

  const distractorMemory = {
    id: 'test_ask_mem_lawn_next_week',
    originalText: 'Mow the back lawn next Friday',
    createdAt: '2026-08-28T00:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Mow the back lawn next Friday',
      kind: 'reminder',
      intent: 'task',
      status: 'active',
      people: [],
      places: [],
      topics: ['gardening'],
      contexts: ['home maintenance'],
      retrieval_cues: ['mow lawn', 'lawn mowing'],
      relationships: [],
      original_time_expression: 'next Friday',
      resolved_datetime: '2026-09-04T10:00:00+10:00',
      reminder_datetime: '2026-09-04T10:00:00+10:00',
      resurfacing: { mode: 'date_based', timing: 'Friday 4 September 2026 at 10:00 AM' },
    },
  };

  const yesterdayMemory = {
    id: 'test_ask_mem_bunnings_yesterday',
    originalText: 'Bought 2 bags of compost at Bunnings yesterday afternoon for $24',
    createdAt: '2026-08-28T00:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Bought 2 bags of compost at Bunnings yesterday afternoon for $24',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: [],
      places: ['Bunnings'],
      topics: ['gardening', 'shopping'],
      contexts: ['gardening', 'shopping'],
      retrieval_cues: ['compost', 'Bunnings compost', 'yesterday afternoon purchase'],
      relationships: [],
      original_time_expression: 'yesterday afternoon',
      resolved_datetime: '2026-08-27T14:00:00+10:00',
      resurfacing: { mode: 'date_based', timing: 'Thursday 27 August 2026 at 2:00 PM' },
    },
  };

  const waElectionMemory = {
    id: 'test_ask_mem_wa_election',
    originalText: 'Roger Cook and WA Labor won the WA state election with a strong majority.',
    createdAt: '2026-08-15T00:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Roger Cook and WA Labor won the WA state election with a strong majority.',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: ['Roger Cook'],
      places: ['Western Australia'],
      topics: ['politics', 'election'],
      contexts: ['news', 'politics'],
      retrieval_cues: ['WA election', 'who won WA election', 'Western Australia election result'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  };

  await insertMemories([
    factMemory,
    plumberMemory,
    soldRuler,
    soldClock,
    soldChair,
    tomorrowMemory,
    distractorMemory,
    yesterdayMemory,
    waElectionMemory,
  ]);

  const nowIso = new Date().toISOString();
  await executeBunnySql([
    {
      sql: `INSERT INTO user_relationships (id, person, role, normalized_role, is_active, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              person = excluded.person,
              role = excluded.role,
              normalized_role = excluded.normalized_role,
              is_active = excluded.is_active,
              updated_at = excluded.updated_at;`,
      args: [TEST_PLUMBER_REL_ID, TEST_PLUMBER_PERSON, 'plumber', 'plumber', 1, nowIso]
    },
    {
      sql: `INSERT INTO user_relationships (id, person, role, normalized_role, is_active, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              person = excluded.person,
              role = excluded.role,
              normalized_role = excluded.normalized_role,
              is_active = excluded.is_active,
              updated_at = excluded.updated_at;`,
      args: [TEST_MECHANIC_REL_ID, TEST_MECHANIC_PERSON, 'mechanic', 'mechanic', 0, nowIso]
    }
  ]);

  await upsertCalendarEvents([
    {
      id: 'test_ask_cal_drmarning',
      source: 'google_calendar',
      source_event_id: 'src_drmarning_99',
      title: 'Dr Marning',
      description: 'Routine checkup and consultation',
      location: '6296 2266 Clinic',
      attendees: ['user@example.com', 'drmarning@clinic.com'],
      start_datetime: '2026-09-07T15:30:00+10:00',
      end_datetime: '2026-09-07T16:15:00+10:00',
      is_all_day: false,
      status: 'confirmed',
      updated_at: '2026-08-28T09:00:00Z',
    },
    {
      id: 'test_ask_cal_dentist',
      source: 'google_calendar',
      source_event_id: 'src_dentist_88',
      title: 'Dentist Checkup',
      description: 'Clean and scale',
      location: 'Dental Surgery',
      attendees: [],
      start_datetime: '2026-09-14T10:00:00+10:00',
      end_datetime: '2026-09-14T11:00:00+10:00',
      is_all_day: false,
      status: 'confirmed',
      updated_at: '2026-08-28T09:00:00Z',
    }
  ]);

  console.log('✅ Fixtures seeded.');
}

async function cleanupTestFixtures() {
  console.log('--- Cleaning up Test Fixtures ---');
  await executeBunnySql([
    { sql: `DELETE FROM memories WHERE id LIKE 'test_ask_%';` },
    { sql: `DELETE FROM memories_fts WHERE memory_id LIKE 'test_ask_%';` },
    { sql: `DELETE FROM memory_search_projection WHERE memory_id LIKE 'test_ask_%';` },
    { sql: `DELETE FROM calendar_events WHERE id LIKE 'test_ask_%';` },
    { sql: `DELETE FROM user_relationships WHERE id IN (?, ?);`, args: [TEST_PLUMBER_REL_ID, TEST_MECHANIC_REL_ID] },
    { sql: `DELETE FROM scheduled_reminders WHERE memoryId LIKE 'test_ask_%';` },
    { sql: `DELETE FROM user_entities WHERE name IN (?, ?);`, args: [TEST_PLUMBER_PERSON, TEST_MECHANIC_PERSON] }
  ]);
  console.log('✅ Test fixtures cleaned up.');
}

async function queryAskEndpoint(question: string) {
  const t0 = Date.now();
  const res = await fetch('http://localhost:3000/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      clientNow: LOCAL_CONTEXT.clientNow,
      clientTimeZone: LOCAL_CONTEXT.clientTimeZone,
      clientLanguage: LOCAL_CONTEXT.clientLanguage,
      clientRegion: LOCAL_CONTEXT.clientRegion,
    }),
  });

  const totalTime = Date.now() - t0;
  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return { body, totalTime };
}

async function runDetailedShadowHarness() {
  await initBunnyDb();

  const queries = [
    { num: 1, text: 'Where is the spare car key?', desc: 'Case 1: Direct fact retrieval' },
    { num: 2, text: 'Who is my plumber?', desc: 'Case 2a: Relationship Identity' },
    { num: 3, text: 'What did my plumber quote for the gutters?', desc: 'Case 2b: Relationship fact' },
    { num: 4, text: 'When am I seeing Dr Marning?', desc: 'Case 3: Calendar-Specific' },
    { num: 5, text: 'What appointments have I got coming up?', desc: 'Case 4: Generic schedule' },
    { num: 6, text: "What’s in Mum’s sold items?", desc: 'Case 5: List retrieval' },
    { num: 7, text: "How much have I sold Mum’s items for altogether?", desc: 'Case 6: List reasoning' },
    { num: 8, text: 'What do I need to do tomorrow?', desc: 'Case 7: Temporal memory' },
    { num: 9, text: 'What did I buy at Bunnings yesterday afternoon?', desc: 'Case 8: Human/contextual time' },
    { num: 10, text: 'Who won the WA election?', desc: 'Case 9: Grounded general question' },
    { num: 11, text: 'Who is the President of France?', desc: 'Case 10: Out of scope' },
    { num: 12, text: 'Who is my mechanic?', desc: 'Case 11: Forgotten relationship' },
  ];

  try {
    await seedTestFixtures();

    const memories = await readMemories();
    const relRows = await executeBunnySql([{ sql: 'SELECT * FROM user_relationships WHERE is_active = 1;' }]);
    const activeRelationships = (relRows[0]?.rows || []).map((r: any) => ({
      id: r.id,
      person: r.person,
      role: r.role,
      normalized_role: r.normalized_role,
      is_active: r.is_active === 1 || r.is_active === true,
      updated_at: r.updated_at,
    }));

    const localContext = formatLocalTimeContext(
      LOCAL_CONTEXT.clientNow,
      LOCAL_CONTEXT.clientTimeZone,
      LOCAL_CONTEXT.clientLanguage,
      LOCAL_CONTEXT.clientRegion
    );

    const shadowRecords: any[] = [];

    for (const q of queries) {
      console.log(`\n======================================================`);
      console.log(`Executing Query #${q.num}: "${q.text}" (${q.desc})`);
      console.log(`======================================================`);

      // 1. Measure Legacy DCR retrieval execution time in isolation
      const legStart = Date.now();
      const targetedCalendar = await retrieveTargetedCalendarEvents({
        question: q.text,
        referenceDate: localContext.referenceDate,
        timeZone: localContext.timeZone,
        resolvedEntities: [],
        activeRelationships,
      });
      const legacyResult = buildDynamicRetrievalContext(
        q.text,
        memories,
        targetedCalendar.events,
        activeRelationships,
        localContext
      );
      const legDuration = Date.now() - legStart;
      const legacyIds = legacyResult.candidateMemories.map(m => m.id);

      // 2. Execute Native Retrieval Pipeline in isolation to collect exact telemetry
      const nativeResult = await executeNativeRetrievalPipeline({
        question: q.text,
        nowIso: localContext.referenceDate.toISOString(),
        activeRoleLabels: activeRelationships.map(r => r.role),
        legacyCandidateIds: legacyIds,
      });
      const t = nativeResult.telemetry;

      // 3. Execute Real /api/ask HTTP Request
      const askHttp = await queryAskEndpoint(q.text);

      const record = {
        query_num: q.num,
        query: q.text,
        desc: q.desc,
        legacy_candidate_ids: t.legacy_ids,
        native_candidate_ids: t.native_ids,
        intersection_ids: t.intersection_ids,
        legacy_only_ids: t.legacy_only_ids,
        native_only_ids: t.native_only_ids,
        native_route: t.stage_route,
        stage_c_triggered: t.stage_c_triggered,
        stage_c_reason: t.stage_c_reason,
        stage_a_exact_subject_count: t.stage_a_count,
        stage_b_fts_count: t.stage_b_count,
        stage_c_fts_count: t.stage_c_count,
        final_native_hydrated_count: t.native_hydrated_count,
        legacy_retrieval_ms: legDuration,
        native_timings: {
          stage_a_ms: t.timings.stage_a_ms,
          stage_b_ms: t.timings.stage_b_ms,
          stage_c_ms: t.timings.stage_c_ms,
          hydration_ms: t.timings.hydration_ms,
          total_native_ms: t.timings.total_native_ms,
        },
        gemini_calls: t.gemini_calls_made,
        api_ask_http: {
          status: 'ok',
          total_http_latency_ms: askHttp.totalTime,
          response_answer: askHttp.body.answer,
          response_memory_ids: askHttp.body.memory_ids,
          response_calendar_ids: askHttp.body.calendar_event_ids,
          is_out_of_scope: askHttp.body.is_out_of_scope,
        }
      };

      shadowRecords.push(record);
      console.log(JSON.stringify(record, null, 2));
    }

    fs.writeFileSync('./scripts/shadow-results.json', JSON.stringify(shadowRecords, null, 2));
    console.log('\n======================================================');
    console.log('======================================================');
    console.log(JSON.stringify(shadowRecords, null, 2));

  } finally {
    await cleanupTestFixtures();
  }
}

runDetailedShadowHarness().catch(err => {
  console.error('Fatal error in shadow harness:', err);
  process.exit(1);
});

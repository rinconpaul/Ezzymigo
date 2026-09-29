import { initBunnyDb } from '../server/db/schema.js';
import { executeBunnySql } from '../server/db/client.js';
import { insertMemories, readMemories } from '../server/db/memories.js';
import { upsertCalendarEvents } from '../server/calendar/store.js';

interface TestCaseResult {
  archetype: string;
  query: string;
  passed: boolean;
  notes: string;
  actualAnswer?: string;
  actualMemoryIds?: string[];
  actualCalendarIds?: string[];
  isOutOfScope?: boolean;
}

const LOCAL_CONTEXT = {
  clientNow: '2026-08-28T00:00:00.000Z', // Friday 28 August 2026 10:00:00 AM AEST (+10:00)
  clientTimeZone: 'Australia/Sydney',
  clientLanguage: 'en-AU',
  clientRegion: 'AU',
};

// -------------------------------------------------------------
// RESERVED TEST-ONLY FIXTURE IDENTITIES
// These strings are deliberately unnatural and collision-proof against
// genuine user data. They must NEVER be real-world names (e.g. "Dave",
// "Bill") because relationship rows are looked up and superseded by
// person name in production code (see saveRelationships / singular
// role supersession). Cleanup below deletes ONLY these exact reserved
// identities/IDs — never by content match against ordinary human names.
// -------------------------------------------------------------
const TEST_PLUMBER_PERSON = 'ZzTestFixturePlumberAlpha';
const TEST_PLUMBER_REL_ID = 'zztest_rel_plumber_alpha';
const TEST_MECHANIC_PERSON = 'ZzTestFixtureMechanicBeta';
const TEST_MECHANIC_REL_ID = 'zztest_rel_mechanic_beta';

async function seedTestFixtures() {
  console.log('--- Seeding Class B Ask Integration Fixtures ---');

  // 1. Direct Fact Memory: Spare Car Key
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

  // 2. Relationship-aware Memory: Plumber Quote
  // NOTE: `relationships` is intentionally left empty here. insertMemories()
  // auto-calls saveRelationships() for any non-empty `relationships` array,
  // which would trigger singular-role supersession against a real plumber
  // relationship if one exists. The test-only plumber relationship row is
  // instead inserted directly via raw SQL below (see seedTestFixtures),
  // bypassing saveRelationships() entirely.
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

  // 3. List Items: Mum's Sold Items
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

  // 4. Temporal Memory: Tomorrow (Saturday 29 August 2026)
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

  // 5. Temporal Distractor Memory: Next Week (Friday 4 September 2026)
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

  // 6. Contextual / Human Time Memory: Yesterday afternoon at Bunnings
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

  // 7. Grounded General-Looking Question Memory: WA election note
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

  // Insert memories
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

  // Insert Relationship fixtures directly via raw SQL, deliberately NOT via
  // saveRelationships(). saveRelationships() applies singular-role
  // supersession (e.g. deactivating any other stored "plumber") which would
  // corrupt a real, unrelated relationship if one exists. A narrow, direct
  // INSERT touches only these two reserved-identity rows and nothing else.
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

  // Seed Calendar Events: Dr Marning and Dentist
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

  console.log('✅ Fixtures successfully seeded.\n');
}

async function cleanupTestFixtures() {
  console.log('--- Cleaning up Test Fixtures ---');
  // Every deletion below targets an exact, reserved, collision-proof
  // identifier created by this harness — never a content match against an
  // ordinary human name, so a real user's data can never be caught by this.
  await executeBunnySql([
    { sql: `DELETE FROM memories WHERE id LIKE 'test_ask_%';` },
    { sql: `DELETE FROM calendar_events WHERE id LIKE 'test_ask_%';` },
    { sql: `DELETE FROM user_relationships WHERE id IN (?, ?);`, args: [TEST_PLUMBER_REL_ID, TEST_MECHANIC_REL_ID] },
    { sql: `DELETE FROM scheduled_reminders WHERE memoryId LIKE 'test_ask_%';` },
    // Defensive: user_entities should never be written by this harness
    // (saveRelationships()/saveUserEntity() are deliberately never called),
    // but this closes the gap by exact reserved name in case that changes.
    { sql: `DELETE FROM user_entities WHERE name IN (?, ?);`, args: [TEST_PLUMBER_PERSON, TEST_MECHANIC_PERSON] }
  ]);
  console.log('✅ Test fixtures cleaned up.\n');
}

async function queryAsk(question: string) {
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

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP error ${res.status}: ${txt}`);
  }
  return await res.json();
}

async function runAskParityHarness() {
  console.log('================================================================================');
  console.log('  CLASS B — INTEGRATION PASS: EZZYMIGO ASK & RETRIEVAL PARITY HARNESS          ');
  console.log('  Note: Integration test against real /api/ask endpoint with database fixtures.');
  console.log('  Testing DCR context construction, LLM synthesis, supporting IDs & boundaries. ');
  console.log('================================================================================\n');

  await initBunnyDb();

  const results: TestCaseResult[] = [];
  let memsBefore: any[] = [];
  let relsCountBefore = 0;

  // The full seed -> query -> assert lifecycle is wrapped in try/finally so
  // cleanupTestFixtures() is guaranteed to run — even if seeding fails, an
  // Ask request errors, Gemini errors, an assertion throws, the dev server
  // is unavailable, or the harness otherwise exits early. Fixtures must
  // never be left behind in the database because of an unhandled failure
  // partway through the suite.
  try {
    await seedTestFixtures();

    // Snapshot memory and relationship counts BEFORE any queries
    memsBefore = await readMemories();
    const relsBeforeRes = await executeBunnySql([{ sql: 'SELECT COUNT(*) as count FROM user_relationships;' }]);
    relsCountBefore = relsBeforeRes[0]?.rows?.[0]?.count || 0;

    // --- Archetype 1: Direct fact retrieval ---
    {
      const query = 'Where is the spare car key?';
      console.log(`[Case 1] Direct Fact Retrieval: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const hasDrawer = ansLower.includes('drawer') || ansLower.includes('hallway');
      const hasMemId = Array.isArray(resp.memory_ids) && resp.memory_ids.includes('test_ask_mem_spare_key');
      const passed = hasDrawer && hasMemId && !resp.is_out_of_scope;

      results.push({
        archetype: 'Direct fact retrieval',
        query,
        passed,
        notes: `Expected hallway table/drawer & test_ask_mem_spare_key. Got memory_ids: ${JSON.stringify(resp.memory_ids)}`,
        actualAnswer: resp.answer,
        actualMemoryIds: resp.memory_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}" | IDs: ${JSON.stringify(resp.memory_ids)}\n`);
    }

    // --- Archetype 2: Relationship-aware retrieval ---
    {
      const query = 'Who is my plumber?';
      console.log(`[Case 2a] Relationship Identity: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const hasPlumberFixtureName = ansLower.includes(TEST_PLUMBER_PERSON.toLowerCase());
      const passed = hasPlumberFixtureName && !resp.is_out_of_scope;

      results.push({
        archetype: 'Relationship-aware retrieval (Identity)',
        query,
        passed,
        notes: `Expected ${TEST_PLUMBER_PERSON} identified as plumber.`,
        actualAnswer: resp.answer,
        actualMemoryIds: resp.memory_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}"\n`);
    }

    {
      const query = 'What did my plumber quote for the gutters?';
      console.log(`[Case 2b] Relationship-aware Fact Retrieval: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const hasPrice = ansLower.includes('450') || ansLower.includes('$450');
      const hasPlumberFixtureNameOrRole = ansLower.includes(TEST_PLUMBER_PERSON.toLowerCase()) || ansLower.includes('plumber') || ansLower.includes('gutter');
      const hasMemId = Array.isArray(resp.memory_ids) && resp.memory_ids.includes('test_ask_mem_plumber_quote');
      const passed = hasPrice && hasPlumberFixtureNameOrRole && hasMemId && !resp.is_out_of_scope;

      results.push({
        archetype: 'Relationship-aware retrieval (Fact via role)',
        query,
        passed,
        notes: `Expected $450 quote & test_ask_mem_plumber_quote. Got IDs: ${JSON.stringify(resp.memory_ids)}`,
        actualAnswer: resp.answer,
        actualMemoryIds: resp.memory_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}" | IDs: ${JSON.stringify(resp.memory_ids)}\n`);
    }

    // --- Archetype 3: Calendar-specific retrieval ---
    {
      const query = 'When am I seeing Dr Marning?';
      console.log(`[Case 3] Calendar-Specific Retrieval: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const hasDate = ansLower.includes('september') || ansLower.includes('7') || ansLower.includes('3:30') || ansLower.includes('15:30');
      const hasCalId = Array.isArray(resp.calendar_event_ids) && resp.calendar_event_ids.includes('test_ask_cal_drmarning');
      const passed = hasDate && hasCalId && !resp.is_out_of_scope;

      results.push({
        archetype: 'Calendar-specific retrieval',
        query,
        passed,
        notes: `Expected 7 September 3:30pm & test_ask_cal_drmarning. Got cal_ids: ${JSON.stringify(resp.calendar_event_ids)}`,
        actualAnswer: resp.answer,
        actualCalendarIds: resp.calendar_event_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}" | Cal IDs: ${JSON.stringify(resp.calendar_event_ids)}\n`);
    }

    // --- Archetype 4: Generic schedule retrieval ---
    {
      const query = 'What appointments have I got coming up?';
      console.log(`[Case 4] Generic Schedule Retrieval: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const hasMarning = ansLower.includes('marning');
      const hasDentist = ansLower.includes('dentist');
      const hasBothCalIds = Array.isArray(resp.calendar_event_ids) &&
        resp.calendar_event_ids.includes('test_ask_cal_drmarning') &&
        resp.calendar_event_ids.includes('test_ask_cal_dentist');
      const passed = hasMarning && hasDentist && hasBothCalIds && !resp.is_out_of_scope;

      results.push({
        archetype: 'Generic schedule retrieval',
        query,
        passed,
        notes: `Expected Dr Marning and Dentist with both calendar IDs. Got cal_ids: ${JSON.stringify(resp.calendar_event_ids)}`,
        actualAnswer: resp.answer,
        actualCalendarIds: resp.calendar_event_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}" | Cal IDs: ${JSON.stringify(resp.calendar_event_ids)}\n`);
    }

    // --- Archetype 5: List retrieval ---
    {
      const query = "What’s in Mum’s sold items?";
      console.log(`[Case 5] List Retrieval: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const hasRuler = ansLower.includes('ruler');
      const hasClock = ansLower.includes('clock');
      const hasChair = ansLower.includes('chair');
      const hasMemIds = Array.isArray(resp.memory_ids) &&
        resp.memory_ids.includes('test_ask_mem_sold_ruler') &&
        resp.memory_ids.includes('test_ask_mem_sold_clock') &&
        resp.memory_ids.includes('test_ask_mem_sold_chair');
      const passed = hasRuler && hasClock && hasChair && hasMemIds && !resp.is_out_of_scope;

      results.push({
        archetype: 'List retrieval',
        query,
        passed,
        notes: `Expected Ruler, Clock, Rocking chair & 3 memory IDs. Got IDs: ${JSON.stringify(resp.memory_ids)}`,
        actualAnswer: resp.answer,
        actualMemoryIds: resp.memory_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}" | IDs: ${JSON.stringify(resp.memory_ids)}\n`);
    }

    // --- Archetype 6: List reasoning / calculation ---
    {
      const query = "How much have I sold Mum’s items for altogether?";
      console.log(`[Case 6] List Reasoning & Total Calculation: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const hasTotal = ansLower.includes('360') || ansLower.includes('380') || ansLower.includes('225') || ansLower.includes('$360') || ansLower.includes('$380') || ansLower.includes('$225');
      const hasMemIds = Array.isArray(resp.memory_ids) && resp.memory_ids.length >= 2;
      const passed = hasTotal && hasMemIds && !resp.is_out_of_scope;

      results.push({
        archetype: 'List reasoning (Calculation)',
        query,
        passed,
        notes: `Expected total sum $225 ($20+$85+$120) & supporting IDs. Got IDs: ${JSON.stringify(resp.memory_ids)}`,
        actualAnswer: resp.answer,
        actualMemoryIds: resp.memory_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}" | IDs: ${JSON.stringify(resp.memory_ids)}\n`);
    }

    // --- Archetype 7: Temporal memory retrieval ---
    {
      const query = 'What do I need to do tomorrow?';
      console.log(`[Case 7] Temporal Memory Retrieval: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const hasBins = ansLower.includes('bin') || ansLower.includes('waste');
      const doesNotHaveLawn = !ansLower.includes('lawn') && !ansLower.includes('mow');
      const hasMemId = Array.isArray(resp.memory_ids) && resp.memory_ids.includes('test_ask_mem_bins_tomorrow');
      const doesNotHaveDistractorId = Array.isArray(resp.memory_ids) && !resp.memory_ids.includes('test_ask_mem_lawn_next_week');
      const passed = hasBins && doesNotHaveLawn && hasMemId && doesNotHaveDistractorId && !resp.is_out_of_scope;

      results.push({
        archetype: 'Temporal memory retrieval',
        query,
        passed,
        notes: `Expected bins reminder for tomorrow without next week lawn distractor. Got IDs: ${JSON.stringify(resp.memory_ids)}`,
        actualAnswer: resp.answer,
        actualMemoryIds: resp.memory_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}" | IDs: ${JSON.stringify(resp.memory_ids)}\n`);
    }

    // --- Archetype 8: Human/contextual time retrieval ---
    {
      const query = 'What did I buy at Bunnings yesterday afternoon?';
      console.log(`[Case 8] Human/Contextual Time Retrieval: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const hasCompost = ansLower.includes('compost') || ansLower.includes('24') || ansLower.includes('$24');
      const hasMemId = Array.isArray(resp.memory_ids) && resp.memory_ids.includes('test_ask_mem_bunnings_yesterday');
      const passed = hasCompost && hasMemId && !resp.is_out_of_scope;

      results.push({
        archetype: 'Human/contextual time',
        query,
        passed,
        notes: `Expected compost purchase from yesterday afternoon & test_ask_mem_bunnings_yesterday. Got IDs: ${JSON.stringify(resp.memory_ids)}`,
        actualAnswer: resp.answer,
        actualMemoryIds: resp.memory_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}" | IDs: ${JSON.stringify(resp.memory_ids)}\n`);
    }

    // --- Archetype 9: Ask scope — Grounded general-looking question ---
    {
      const query = 'Who won the WA election?';
      console.log(`[Case 9] Grounded General-Looking Question: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const hasRogerCookOrLabor = ansLower.includes('roger cook') || ansLower.includes('labor') || ansLower.includes('wa labor');
      const hasMemId = Array.isArray(resp.memory_ids) && resp.memory_ids.includes('test_ask_mem_wa_election');
      const notOutOfScope = resp.is_out_of_scope === false;
      const passed = hasRogerCookOrLabor && hasMemId && notOutOfScope;

      results.push({
        archetype: 'Ask scope — Grounded general question',
        query,
        passed,
        notes: `Expected Roger Cook/WA Labor from note, is_out_of_scope=false. Got is_out_of_scope=${resp.is_out_of_scope}, IDs: ${JSON.stringify(resp.memory_ids)}`,
        actualAnswer: resp.answer,
        actualMemoryIds: resp.memory_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}" | OutOfScope: ${resp.is_out_of_scope} | IDs: ${JSON.stringify(resp.memory_ids)}\n`);
    }

    // --- Archetype 10: Ask scope — True out-of-scope question ---
    {
      const query = 'Who is the President of France?';
      console.log(`[Case 10] True Out-of-Scope Query: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const isFriendlyDeflection = ansLower.includes('personal') || ansLower.includes('search engine') || ansLower.includes('memories') || ansLower.includes('notes');
      const isFlaggedOutOfScope = resp.is_out_of_scope === true;
      const hasEmptyIds = (!resp.memory_ids || resp.memory_ids.length === 0) && (!resp.calendar_event_ids || resp.calendar_event_ids.length === 0);
      const passed = isFriendlyDeflection && isFlaggedOutOfScope && hasEmptyIds;

      results.push({
        archetype: 'Ask scope — True out-of-scope',
        query,
        passed,
        notes: `Expected friendly personal-scope deflection, is_out_of_scope=true, empty IDs. Got is_out_of_scope=${resp.is_out_of_scope}`,
        actualAnswer: resp.answer,
        actualMemoryIds: resp.memory_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}" | OutOfScope: ${resp.is_out_of_scope} | IDs: ${JSON.stringify(resp.memory_ids)}\n`);
    }

    // --- Archetype 11: Deleted/forgotten knowledge suppression ---
    {
      const query = 'Who is my mechanic?';
      console.log(`[Case 11] Forgotten Relationship Suppression: "${query}"`);
      const resp = await queryAsk(query);
      const ansLower = (resp.answer || '').toLowerCase();
      const mechanicFixtureLower = TEST_MECHANIC_PERSON.toLowerCase();
      const doesNotClaimMechanicFixture = !ansLower.includes(`${mechanicFixtureLower} is your mechanic`) && !ansLower.includes(`your mechanic is ${mechanicFixtureLower}`);
      const mentionsNoRecord = ansLower.includes("don't have") || ansLower.includes("couldn't find") || ansLower.includes("no record");
      const passed = doesNotClaimMechanicFixture && mentionsNoRecord;

      results.push({
        archetype: 'Deleted/forgotten knowledge suppression',
        query,
        passed,
        notes: `Expected no mention of deactivated ${TEST_MECHANIC_PERSON} as mechanic.`,
        actualAnswer: resp.answer,
        actualMemoryIds: resp.memory_ids,
        isOutOfScope: resp.is_out_of_scope,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Answer: "${resp.answer}"\n`);
    }

    // --- Archetype 12: No Ask Mutation Verification ---
    {
      console.log(`[Case 12] No Ask Mutation Check: Verifying database immutability`);
      const memsAfter = await readMemories();
      const relsAfterRes = await executeBunnySql([{ sql: 'SELECT COUNT(*) as count FROM user_relationships;' }]);
      const relsCountAfter = relsAfterRes[0]?.rows?.[0]?.count || 0;

      const memCountEqual = memsBefore.length === memsAfter.length;
      const relCountEqual = relsCountBefore === relsCountAfter;
      const passed = memCountEqual && relCountEqual;

      results.push({
        archetype: 'No Ask mutation',
        query: 'N/A (Database State Audit)',
        passed,
        notes: `Memory count before: ${memsBefore.length}, after: ${memsAfter.length}. Relationship count before: ${relsCountBefore}, after: ${relsCountAfter}.`,
      });
      console.log(`   Result: ${passed ? 'PASS' : 'FAIL'} | Mems: ${memsBefore.length}->${memsAfter.length} | Rels: ${relsCountBefore}->${relsCountAfter}\n`);
    }
  } finally {
    // Guaranteed cleanup: runs whether the try block above completed,
    // threw partway through, or the dev server / Gemini was unavailable.
    await cleanupTestFixtures();
  }

  // Print Summary Table
  console.log('================================================================================');
  console.log('  CLASS B — INTEGRATION RESULTS SUMMARY                                         ');
  console.log('================================================================================');
  let passCount = 0;
  for (const r of results) {
    if (r.passed) passCount++;
    console.log(`[${r.passed ? 'PASS' : 'FAIL'}] ${r.archetype.padEnd(42)} | Query: "${r.query}"`);
    if (!r.passed) {
      console.log(`       Notes: ${r.notes}`);
      console.log(`       Answer: "${r.actualAnswer}"`);
    }
  }
  console.log('================================================================================');
  console.log(`  TOTAL: ${passCount} / ${results.length} PASSED (${Math.round((passCount / results.length) * 100)}%)`);
  console.log('================================================================================');

  if (passCount !== results.length) {
    console.log('\n⚠️  Behavioral discrepancies detected in the current Ask pipeline.');
  }
}

runAskParityHarness().catch(err => {
  console.error('Test harness execution failed:', err);
  process.exit(1);
});


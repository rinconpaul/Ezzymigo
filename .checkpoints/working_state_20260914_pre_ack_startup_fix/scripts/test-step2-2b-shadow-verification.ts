import { initBunnyDb } from '../server/db/schema';
import { executeBunnySql } from '../server/db/client';
import { insertMemories, deleteMemoryFromDb, readMemories } from '../server/db/memories';
import {
  executeNativeRetrievalPipeline,
  isRetrievalConfident,
  retrieveStageBFts,
  retrieveStageAExactSubject,
  buildFtsQueryExpression,
  extractCandidateTokenSet,
  ScoredCandidate
} from '../server/retrieval/native_search';

const LOCAL_NOW_ISO = '2026-08-28T00:00:00.000Z'; // Friday 28 August 2026 10:00 AM AEST (+10:00)

// Unique test prefixes
const T_PREFIX = 'test_torture_2b_';
const TEST_PLUMBER_PERSON = 'ZzTestFixturePlumberDave';
const TEST_WIFE_PERSON = 'ZzTestFixtureWifeBarb';
const TEST_HANDYMAN_PERSON = 'ZzTestFixtureHandymanSteve';

async function seedTortureFixtures() {
  console.log('--- Seeding Step 2.2B Torture & Verification Fixtures ---');

  // Insert test relationships directly via SQL into user_relationships table
  await executeBunnySql([
    {
      sql: `INSERT INTO user_relationships (id, person, role, normalized_role, is_active, updated_at)
            VALUES (?, ?, ?, ?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET
              person = excluded.person,
              role = excluded.role,
              normalized_role = excluded.normalized_role,
              is_active = excluded.is_active,
              updated_at = excluded.updated_at;`,
      args: [`${T_PREFIX}rel_plumber`, TEST_PLUMBER_PERSON, 'plumber', 'plumber', LOCAL_NOW_ISO],
    },
    {
      sql: `INSERT INTO user_relationships (id, person, role, normalized_role, is_active, updated_at)
            VALUES (?, ?, ?, ?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET
              person = excluded.person,
              role = excluded.role,
              normalized_role = excluded.normalized_role,
              is_active = excluded.is_active,
              updated_at = excluded.updated_at;`,
      args: [`${T_PREFIX}rel_wife`, TEST_WIFE_PERSON, 'wife', 'wife', LOCAL_NOW_ISO],
    },
    {
      sql: `INSERT INTO user_relationships (id, person, role, normalized_role, is_active, updated_at)
            VALUES (?, ?, ?, ?, 1, ?)
            ON CONFLICT(id) DO UPDATE SET
              person = excluded.person,
              role = excluded.role,
              normalized_role = excluded.normalized_role,
              is_active = excluded.is_active,
              updated_at = excluded.updated_at;`,
      args: [`${T_PREFIX}rel_handyman`, TEST_HANDYMAN_PERSON, 'handyman', 'handyman', LOCAL_NOW_ISO],
    },
  ]);

  const fixtures = [
    // 1. Car battery
    {
      id: `${T_PREFIX}car_battery`,
      originalText: 'Bought a new Bosch car battery from Repco for $189 on Saturday.',
      createdAt: '2026-08-22T02:00:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Bought a new Bosch car battery from Repco for $189 on Saturday.',
        kind: 'fact', intent: 'fact', status: 'active',
        people: [], places: ['Repco'],
        topics: ['car', 'maintenance', 'battery', 'auto'],
        contexts: ['vehicle', 'repairs'],
        retrieval_cues: ['car battery', 'repco', 'battery price', 'auto battery'],
        relationships: [],
      }
    },
    // 2. Wifi password
    {
      id: `${T_PREFIX}wifi_pwd`,
      originalText: 'The guest network password is BlueSky882.',
      createdAt: '2026-08-20T03:00:00.000Z',
      isDone: false,
      interpretation: {
        content: 'The guest network password is BlueSky882.',
        kind: 'fact', intent: 'fact', status: 'active',
        people: [], places: ['home'],
        topics: ['wifi', 'network', 'internet', 'router', 'password'],
        contexts: ['home networking', 'guests'],
        retrieval_cues: ['wifi', 'internet code', 'router', 'guest network password', 'wifi password'],
        relationships: [],
      }
    },
    // 3. Vet appointment
    {
      id: `${T_PREFIX}vet_appt`,
      originalText: 'Took Barnaby to the vet for his annual vaccination.',
      createdAt: '2026-08-21T01:00:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Took Barnaby to the vet for his annual vaccination.',
        kind: 'fact', intent: 'fact', status: 'active',
        people: ['Barnaby'], places: ['vet clinic'],
        topics: ['vet', 'dog', 'pet', 'vaccination', 'shots'],
        contexts: ['pet care'],
        retrieval_cues: ['vet', 'barnaby', 'dog vaccination', 'dog shots'],
        relationships: [],
      }
    },
    // 4. Plumber quote
    {
      id: `${T_PREFIX}plumber_quote`,
      originalText: `${TEST_PLUMBER_PERSON} quoted $650 to replace the hot water valve.`,
      createdAt: '2026-08-23T04:00:00.000Z',
      isDone: false,
      interpretation: {
        content: `${TEST_PLUMBER_PERSON} quoted $650 to replace the hot water valve.`,
        kind: 'fact', intent: 'fact', status: 'active',
        people: [TEST_PLUMBER_PERSON], places: ['home'],
        topics: ['plumber', 'plumbing', 'hot water', 'valve', 'quote', 'pipes'],
        contexts: ['home maintenance', 'plumbing'],
        retrieval_cues: ['plumber quote', 'hot water valve', 'pipes'],
        relationships: [],
      }
    },
    // 5. Wife gift
    {
      id: `${T_PREFIX}barb_gift`,
      originalText: `${TEST_WIFE_PERSON} wants the lavender wool sweater for her birthday.`,
      createdAt: '2026-08-24T05:00:00.000Z',
      isDone: false,
      interpretation: {
        content: `${TEST_WIFE_PERSON} wants the lavender wool sweater for her birthday.`,
        kind: 'fact', intent: 'fact', status: 'active',
        people: [TEST_WIFE_PERSON], places: [],
        topics: ['birthday', 'gift', 'sweater', 'wife'],
        contexts: ['family', 'gifts'],
        retrieval_cues: [`${TEST_WIFE_PERSON} gift`, 'wife birthday', 'sweater'],
        relationships: [],
      }
    },
    // 6. Handyman fence
    {
      id: `${T_PREFIX}steve_handyman`,
      originalText: `${TEST_HANDYMAN_PERSON} is coming over on Tuesday to repair the back fence.`,
      createdAt: '2026-08-25T06:00:00.000Z',
      isDone: false,
      interpretation: {
        content: `${TEST_HANDYMAN_PERSON} is coming over on Tuesday to repair the back fence.`,
        kind: 'fact', intent: 'fact', status: 'active',
        people: [TEST_HANDYMAN_PERSON], places: ['back yard'],
        topics: ['handyman', 'fence', 'repair', 'tradesman'],
        contexts: ['home maintenance'],
        retrieval_cues: ['fence repair', 'handyman', 'tradesman'],
        relationships: [],
      }
    },
    // 7, 8: Mum's sold items list cluster
    {
      id: `${T_PREFIX}sold_chair`,
      originalText: 'Rocking chair $120',
      createdAt: '2026-08-20T07:00:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Rocking chair $120',
        kind: 'fact', intent: 'fact', status: 'active',
        people: ['Mum'], places: [],
        subject: "Mum's sold items",
        topics: ["Mum's sold items", 'furniture', 'sales'],
        retrieval_cues: ["Mum's sold items", 'rocking chair'],
        relationships: [],
      }
    },
    {
      id: `${T_PREFIX}sold_clock`,
      originalText: 'Antique clock $85',
      createdAt: '2026-08-20T07:05:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Antique clock $85',
        kind: 'fact', intent: 'fact', status: 'active',
        people: ['Mum'], places: [],
        subject: "Mum's sold items",
        topics: ["Mum's sold items", 'antique clock', 'sales'],
        retrieval_cues: ["Mum's sold items", 'antique clock'],
        relationships: [],
      }
    },
    {
      id: `${T_PREFIX}sold_lamp`,
      originalText: 'Brass desk lamp $45',
      createdAt: '2026-08-20T07:10:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Brass desk lamp $45',
        kind: 'fact', intent: 'fact', status: 'active',
        people: ['Mum'], places: [],
        subject: "Mum's sold items",
        topics: ["Mum's sold items", 'lamp', 'sales'],
        retrieval_cues: ["Mum's sold items", 'brass desk lamp'],
        relationships: [],
      }
    },
    // 9: Camping checklist
    {
      id: `${T_PREFIX}camp_tent`,
      originalText: '4-person dome tent and pegs',
      createdAt: '2026-08-21T08:00:00.000Z',
      isDone: false,
      interpretation: {
        content: '4-person dome tent and pegs',
        kind: 'fact', intent: 'fact', status: 'active',
        people: [], places: [],
        subject: 'Camping Gear Checklist',
        topics: ['Camping Gear Checklist', 'camping', 'tent'],
        retrieval_cues: ['camping gear checklist', 'tent'],
        relationships: [],
      }
    },
    {
      id: `${T_PREFIX}camp_stove`,
      originalText: 'Butane camping stove and spare gas canisters',
      createdAt: '2026-08-21T08:05:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Butane camping stove and spare gas canisters',
        kind: 'fact', intent: 'fact', status: 'active',
        people: [], places: [],
        subject: 'Camping Gear Checklist',
        topics: ['Camping Gear Checklist', 'camping', 'stove'],
        retrieval_cues: ['camping gear checklist', 'stove'],
        relationships: [],
      }
    },
    // 10: Lucy at HRC (3:00pm tokenization)
    {
      id: `${T_PREFIX}lucy_hrc`,
      originalText: 'Received a phone call from Lucy at the Human Rights Commission at approximately 3:00pm today.',
      createdAt: '2026-08-28T05:00:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Received a phone call from Lucy at the Human Rights Commission at approximately 3:00pm today.',
        kind: 'fact', intent: 'fact', status: 'active',
        people: ['Lucy'], places: ['Human Rights Commission'],
        topics: ['Human Rights Commission', 'phone call', 'communication'],
        retrieval_cues: ['Lucy', 'Human Rights Commission', 'phone call 3pm', '3:00pm'],
        relationships: [],
      }
    },
    // 11: Shed paint
    {
      id: `${T_PREFIX}shed_paint`,
      originalText: 'Left 2 tins of Monument grey paint under the workbench in the shed.',
      createdAt: '2026-08-22T09:00:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Left 2 tins of Monument grey paint under the workbench in the shed.',
        kind: 'fact', intent: 'fact', status: 'active',
        people: [], places: ['shed', 'workbench'],
        topics: ['paint', 'Monument grey', 'shed', 'diy'],
        retrieval_cues: ['grey paint', 'shed', 'monument paint'],
        relationships: [],
      }
    },
    // 12: Doctor reschedule
    {
      id: `${T_PREFIX}dr_reschedule`,
      originalText: 'Dr Vance reception rang to change the checkup to next Thursday at 2:30pm.',
      createdAt: '2026-08-23T10:00:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Dr Vance reception rang to change the checkup to next Thursday at 2:30pm.',
        kind: 'fact', intent: 'fact', status: 'active',
        people: ['Dr Vance'], places: ['clinic'],
        topics: ['doctor', 'appointment', 'checkup', 'Dr Vance'],
        retrieval_cues: ['doctor appointment', 'Dr Vance', 'rescheduled checkup'],
        relationships: [],
      }
    },
    // 13: Bunnings compost yesterday
    {
      id: `${T_PREFIX}bunnings_yesterday`,
      originalText: 'Bought 2 bags of compost at Bunnings yesterday afternoon for $24.',
      createdAt: '2026-08-27T04:00:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Bought 2 bags of compost at Bunnings yesterday afternoon for $24.',
        kind: 'fact', intent: 'fact', status: 'active',
        people: [], places: ['Bunnings'],
        topics: ['Bunnings', 'gardening', 'compost', 'purchase'],
        retrieval_cues: ['Bunnings compost', 'yesterday afternoon', '$24 compost'],
        relationships: [],
      }
    },
    // 14: Green waste bins tomorrow
    {
      id: `${T_PREFIX}bins_tomorrow`,
      originalText: 'Put the green waste bins out tomorrow morning.',
      createdAt: '2026-08-27T22:00:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Put the green waste bins out tomorrow morning.',
        kind: 'reminder', intent: 'task', status: 'active',
        people: [], places: [],
        topics: ['chores', 'bins', 'waste', 'green waste'],
        retrieval_cues: ['green waste bins', 'tomorrow morning'],
        relationships: [],
      }
    },
    // 15: Dentist next month
    {
      id: `${T_PREFIX}dentist_sep`,
      originalText: 'Dentist checkup on 14 September at 10:00am.',
      createdAt: '2026-08-25T11:00:00.000Z',
      isDone: false,
      interpretation: {
        content: 'Dentist checkup on 14 September at 10:00am.',
        kind: 'reminder', intent: 'appointment', status: 'active',
        people: ['Dentist'], places: ['dental clinic'],
        topics: ['dentist', 'checkup', 'September appointment'],
        retrieval_cues: ['dentist September', '14 September 10am'],
        relationships: [],
      }
    },
  ];

  await insertMemories(fixtures as any);
  console.log(`✅ Seeded ${fixtures.length} torture verification fixtures.`);
}

async function cleanupTortureFixtures() {
  console.log('--- Cleaning up Step 2.2B Torture Fixtures ---');
  await executeBunnySql([
    { sql: `DELETE FROM user_relationships WHERE id LIKE '${T_PREFIX}%';` },
    { sql: `DELETE FROM memories WHERE id LIKE '${T_PREFIX}%';` },
    { sql: `DELETE FROM memories_fts WHERE memory_id LIKE '${T_PREFIX}%';` },
    { sql: `DELETE FROM memory_search_projection WHERE memory_id LIKE '${T_PREFIX}%';` },
  ]);
  console.log('✅ Torture fixtures cleanly removed.');
}

async function runStep22bVerification() {
  await initBunnyDb();
  await seedTortureFixtures();

  const results: Array<{ section: string; name: string; passed: boolean; details: string }> = [];

  try {
    console.log('\n================================================================================');
    console.log('  SECTION 1: 18-FIXTURE HUMAN INTERACTION TORTURE SUITE                         ');
    console.log('================================================================================');

    const tortureCases = [
      // Category 1: Conversational Paraphrase
      {
        id: 'case_t1',
        category: 'Conversational Paraphrase',
        query: 'What did I end up paying for the auto battery?',
        expectedIds: [`${T_PREFIX}car_battery`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      {
        id: 'case_t2',
        category: 'Conversational Paraphrase',
        query: 'What is the login for visitors to get on the internet?',
        expectedIds: [`${T_PREFIX}wifi_pwd`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      {
        id: 'case_t3',
        category: 'Conversational Paraphrase',
        query: 'When did the dog get his shots?',
        expectedIds: [`${T_PREFIX}vet_appt`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      // Category 2: Role-Mediated Indirection
      {
        id: 'case_t4',
        category: 'Role-Mediated Indirection',
        query: 'What did the guy who fixes the pipes say it would cost?',
        expectedIds: [`${T_PREFIX}plumber_quote`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      {
        id: 'case_t5',
        category: 'Role-Mediated Indirection',
        query: 'What should I get my wife for her birthday?',
        expectedIds: [`${T_PREFIX}barb_gift`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      {
        id: 'case_t6',
        category: 'Role-Mediated Indirection',
        query: 'When is the tradesman coming to do the fence?',
        expectedIds: [`${T_PREFIX}steve_handyman`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      // Category 3: Subject / List Variation
      {
        id: 'case_t7',
        category: 'Subject / List Variation',
        query: 'List out everything we sold for mum',
        expectedIds: [`${T_PREFIX}sold_chair`, `${T_PREFIX}sold_clock`, `${T_PREFIX}sold_lamp`],
        expectedRoute: ['stage_a'],
        exactCluster: true,
      },
      {
        id: 'case_t8',
        category: 'Subject / List Variation',
        query: "What's the grand total from mum's sales so far?",
        expectedIds: [`${T_PREFIX}sold_chair`, `${T_PREFIX}sold_clock`, `${T_PREFIX}sold_lamp`],
        expectedRoute: ['stage_a'],
        exactCluster: true,
      },
      {
        id: 'case_t9',
        category: 'Subject / List Variation',
        query: 'What camping gear is on my list?',
        expectedIds: [`${T_PREFIX}camp_tent`, `${T_PREFIX}camp_stove`],
        expectedRoute: ['stage_a'],
        exactCluster: true,
      },
      // Category 4: Messy Real-World Phrasing
      {
        id: 'case_t10',
        category: 'Messy Real-World Phrasing',
        query: 'Did Lucy from the human rights commission get in touch?',
        expectedIds: [`${T_PREFIX}lucy_hrc`],
        expectedRoute: ['stage_b'],
      },
      {
        id: 'case_t11',
        category: 'Messy Real-World Phrasing',
        query: "Where'd I stick the leftover grey paint again?",
        expectedIds: [`${T_PREFIX}shed_paint`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      {
        id: 'case_t12',
        category: 'Messy Real-World Phrasing',
        query: 'What time was my doctor thing moved to?',
        expectedIds: [`${T_PREFIX}dr_reschedule`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      // Category 5: Temporal & Relative Phrasing
      {
        id: 'case_t13',
        category: 'Temporal & Relative Phrasing',
        query: 'What did I pick up yesterday after lunch?',
        expectedIds: [`${T_PREFIX}bunnings_yesterday`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      {
        id: 'case_t14',
        category: 'Temporal & Relative Phrasing',
        query: 'What chores do I have scheduled for tomorrow?',
        expectedIds: [`${T_PREFIX}bins_tomorrow`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      {
        id: 'case_t15',
        category: 'Temporal & Relative Phrasing',
        query: 'When am I going to the dentist in September?',
        expectedIds: [`${T_PREFIX}dentist_sep`],
        expectedRoute: ['stage_b', 'stage_c'],
      },
      // Category 6: Boundary, Negation & Zero Hits
      {
        id: 'case_t16',
        category: 'Boundary & Negation',
        query: 'Did I buy a lawnmower from Bunnings?',
        expectedIds: [],
        expectedZero: true,
      },
      {
        id: 'case_t17',
        category: 'Out of Scope Knowledge',
        query: 'Who is the Prime Minister of Canada?',
        expectedIds: [],
        expectedZero: true,
      },
      {
        id: 'case_t18',
        category: 'Deleted Knowledge Isolation',
        query: 'What was the old alarm code?',
        expectedIds: [],
        expectedZero: true,
      },
    ];

    for (const tc of tortureCases) {
      const res = await executeNativeRetrievalPipeline({
        question: tc.query,
        nowIso: LOCAL_NOW_ISO,
        activeRoleLabels: ['plumber', 'wife', 'handyman', 'doctor', 'dentist'],
      });

      const t = res.telemetry;
      const returnedIds = t.native_ids;

      let passed = true;
      let notes = '';

      if (tc.expectedZero) {
        // Zero hits expected for non-existent / out of scope targets
        // Ensure no false groundings
        const hasIrrelevantHit = returnedIds.some(id => !tc.expectedIds.includes(id) && id.startsWith(T_PREFIX));
        if (hasIrrelevantHit) {
          passed = false;
          notes = `False positive hit on: ${returnedIds.join(', ')}`;
        } else {
          notes = `Safe zero/empty candidate set. Route: ${t.stage_route}`;
        }
      } else {
        // Critical required-memory recall: 100%
        const missingIds = tc.expectedIds.filter(expId => !returnedIds.includes(expId));
        if (missingIds.length > 0) {
          passed = false;
          notes = `Missing required memory IDs: [${missingIds.join(', ')}]. Returned: [${returnedIds.join(', ')}]`;
        } else {
          notes = `Recalled all ${tc.expectedIds.length} required memories. Route: ${t.stage_route} | Latency: ${t.timings.total_native_ms}ms (Stage C: ${t.stage_c_triggered})`;
        }
      }

      console.log(`[${passed ? 'PASS' : 'FAIL'}] [${tc.category}] "${tc.query}" -> ${notes}`);
      results.push({ section: 'Torture Suite', name: tc.query, passed, details: notes });
    }

    console.log('\n================================================================================');
    console.log('  SECTION 2: SIX CONFIDENCE-GATE PRESSURE CASES                                 ');
    console.log('================================================================================');

    const pressureCases = [
      {
        name: 'Case 1: "Did I buy a lawnmower from Bunnings?" (False-Positive Prevention)',
        query: 'Did I buy a lawnmower from Bunnings?',
        candidates: [
          {
            memory_id: `${T_PREFIX}bunnings_yesterday`,
            content: 'Bought 2 bags of compost at Bunnings yesterday afternoon for $24.',
            original_text: '',
            people: '',
            places: 'Bunnings',
            topics: 'Bunnings compost purchase',
            retrieval_cues: 'Bunnings compost $24',
            items: '',
            subject: '',
            bm25_score: -5.2,
          }
        ],
        expectedConfident: false, // MUST be low confidence because "lawnmower" is missing
        expectedStageC: true,
      },
      {
        name: 'Case 2: "What did I buy at Bunnings?" (Open Query Grounding)',
        query: 'What did I buy at Bunnings?',
        candidates: [
          {
            memory_id: `${T_PREFIX}bunnings_yesterday`,
            content: 'Bought 2 bags of compost at Bunnings yesterday afternoon for $24.',
            original_text: '',
            people: '',
            places: 'Bunnings',
            topics: 'Bunnings compost purchase',
            retrieval_cues: 'Bunnings compost $24',
            items: '',
            subject: '',
            bm25_score: -7.5,
          }
        ],
        expectedConfident: true, // Should be confident because no missing discriminating token
        expectedStageC: false,
      },
      {
        name: 'Case 3: "Did Lucy call me about insurance?" (False-Positive Prevention)',
        query: 'Did Lucy call me about insurance?',
        candidates: [
          {
            memory_id: `${T_PREFIX}lucy_hrc`,
            content: 'Received a phone call from Lucy at the Human Rights Commission at approximately 3:00pm today.',
            original_text: '',
            people: 'Lucy',
            places: 'Human Rights Commission',
            topics: 'Human Rights Commission phone call',
            retrieval_cues: 'Lucy 3pm',
            items: '',
            subject: '',
            bm25_score: -6.1,
          }
        ],
        expectedConfident: false, // MUST be low confidence because "insurance" is missing
        expectedStageC: true,
      },
      {
        name: 'Case 4: "Did Lucy from the Human Rights Commission call me?" (True-Positive Verification)',
        query: 'Did Lucy from the Human Rights Commission call me?',
        candidates: [
          {
            memory_id: `${T_PREFIX}lucy_hrc`,
            content: 'Received a phone call from Lucy at the Human Rights Commission at approximately 3:00pm today.',
            original_text: '',
            people: 'Lucy',
            places: 'Human Rights Commission',
            topics: 'Human Rights Commission phone call',
            retrieval_cues: 'Lucy 3pm',
            items: '',
            subject: '',
            bm25_score: -9.8,
          }
        ],
        expectedConfident: true, // Should be confident because all discriminating tokens match
        expectedStageC: false,
      },
      {
        name: 'Case 5: "Wifi password?" (Retrieval Cue Grounding & Short Query)',
        query: 'Wifi password?',
        candidates: [
          {
            memory_id: `${T_PREFIX}wifi_pwd`,
            content: 'The guest network password is BlueSky882.',
            original_text: '',
            people: '',
            places: '',
            topics: 'wifi network internet router password',
            retrieval_cues: 'wifi internet code router guest network password',
            items: '',
            subject: '',
            bm25_score: -8.0,
          }
        ],
        expectedConfident: true, // Both "wifi" and "password" present in candidate
        expectedStageC: false,
      },
      {
        name: 'Case 6: "What is my yacht registration number?" (Zero-Candidate Safe Guard)',
        query: 'What is my yacht registration number?',
        candidates: [],
        expectedConfident: false,
        expectedStageC: true,
      },
    ];

    for (const pc of pressureCases) {
      const actualConfident = isRetrievalConfident(pc.query, pc.candidates);
      const passed = (actualConfident === pc.expectedConfident);
      const notes = `isRetrievalConfident -> ${actualConfident} (Expected: ${pc.expectedConfident}, Stage C trigger: ${!actualConfident})`;
      console.log(`[${passed ? 'PASS' : 'FAIL'}] ${pc.name} -> ${notes}`);
      results.push({ section: 'Confidence Pressure', name: pc.name, passed, details: notes });
    }

    console.log('\n================================================================================');
    console.log('  SECTION 3: TIME-EXPRESSION & 3:00PM TOKENIZATION TEST CASES                   ');
    console.log('================================================================================');

    const timeCases = [
      { query: 'Who called me at 3pm today?', expectedId: `${T_PREFIX}lucy_hrc` },
      { query: 'Did I get a call around 3:00pm?', expectedId: `${T_PREFIX}lucy_hrc` },
      { query: 'What was the phone call at 3 o’clock?', expectedId: `${T_PREFIX}lucy_hrc` },
    ];

    for (const tc of timeCases) {
      const res = await executeNativeRetrievalPipeline({
        question: tc.query,
        nowIso: LOCAL_NOW_ISO,
      });
      const passed = res.telemetry.native_ids.includes(tc.expectedId);
      const notes = `Query "${tc.query}" -> Recalled: ${passed} (IDs: ${res.telemetry.native_ids.join(', ')})`;
      console.log(`[${passed ? 'PASS' : 'FAIL'}] Time Expression: ${notes}`);
      results.push({ section: 'Time Expression', name: tc.query, passed, details: notes });
    }

    console.log('\n================================================================================');
    console.log('  SECTION 4: EXACT SUBJECT CLUSTER COMPLETENESS & TRUNCATION PROOF               ');
    console.log('================================================================================');

    // Test Case 5 / 6 Cluster completeness for "Mum's sold items"
    const clusterRes = await retrieveStageAExactSubject("What's in Mum's sold items?", 'active');
    const expectedMumItems = [`${T_PREFIX}sold_chair`, `${T_PREFIX}sold_clock`, `${T_PREFIX}sold_lamp`];
    const missingClusterItems = expectedMumItems.filter(id => !clusterRes.includes(id));
    const clusterPassed = missingClusterItems.length === 0 && clusterRes.length >= 3;

    console.log(`[${clusterPassed ? 'PASS' : 'FAIL'}] Exact Subject Cluster Completeness: Found ${clusterRes.length} items (Missing: ${missingClusterItems.length})`);
    results.push({
      section: 'Cluster Completeness',
      name: "Mum's sold items completeness",
      passed: clusterPassed,
      details: `Retrieved ${clusterRes.length} items: [${clusterRes.join(', ')}]`,
    });

  } finally {
    await cleanupTortureFixtures();
  }

  console.log('\n================================================================================');
  console.log('  STEP 2.2B SHADOW VERIFICATION SUMMARY                                         ');
  console.log('================================================================================');
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  console.log(`TOTAL: ${passed} / ${total} PASSED (${Math.round((passed / total) * 100)}%)`);

  if (passed < total) {
    process.exit(1);
  }
}

runStep22bVerification().catch(err => {
  console.error('Step 2.2B Verification failed:', err);
  process.exit(1);
});

import fs from 'fs';
import { initBunnyDb } from '../server/db/schema.js';
import { executeBunnySql } from '../server/db/client.js';
import { insertMemories, readMemories } from '../server/db/memories.js';
import { executeArchitectureDRetrieval } from '../server/retrieval/architecture_d.js';
import { syncMemoryVector, buildMemoryDocumentString } from '../server/retrieval/vector_service.js';

interface TestCase {
  id: string;
  category: string;
  query: string;
  expectedMemoryIds: string[];
  unexpectedMemoryIds?: string[];
  expectedRoute?: string;
  expectAmbiguityRescue?: boolean;
  expectZeroResult?: boolean;
  notes: string;
}

const LOCAL_CONTEXT = {
  nowIso: '2026-08-28T00:00:00.000Z',
  activeRoleLabels: ['plumber', 'mechanic'],
};

const FIXTURES = [
  // 1. English Direct Fact
  {
    id: 'test_shadow_archd_en_key',
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
  },
  // 2. English Plumber Quote (Numbers & Currency)
  {
    id: 'test_shadow_archd_en_plumber',
    originalText: 'Dave the plumber quoted $450 to clean and replace the gutters.',
    createdAt: '2026-08-22T04:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Dave the plumber quoted $450 to clean and replace the gutters.',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: ['Dave'],
      places: [],
      topics: ['home maintenance', 'gutters', 'plumbing'],
      contexts: ['home maintenance', 'repairs'],
      retrieval_cues: ['plumber quote', 'gutters', 'Dave plumber quote', 'gutter cleaning price', '450 dollars'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 3. French Fact (Garage invoice)
  {
    id: 'test_shadow_archd_fr_garage',
    originalText: 'La révision de la voiture chez le garagiste à Paris a coûté 380 euros avec la vidange.',
    createdAt: '2026-08-21T03:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'La révision de la voiture chez le garagiste à Paris a coûté 380 euros avec la vidange.',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: [],
      places: ['Paris', 'garage'],
      topics: ['voiture', 'garagiste', 'facture', 'entretien'],
      contexts: ['automobile', 'dépenses'],
      retrieval_cues: ['révision voiture', 'garagiste paris', 'coût vidange', '380 euros', 'car service paris'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 4. Spanish Fact (Madrid passports)
  {
    id: 'test_shadow_archd_es_passport',
    originalText: 'Los pasaportes para el viaje a Madrid están guardados en la caja fuerte del armario principal.',
    createdAt: '2026-08-22T05:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Los pasaportes para el viaje a Madrid están guardados en la caja fuerte del armario principal.',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: [],
      places: ['Madrid', 'caja fuerte', 'armario principal'],
      topics: ['pasaportes', 'documentos', 'viaje'],
      contexts: ['viajes', 'seguridad'],
      retrieval_cues: ['pasaportes madrid', 'caja fuerte armario', 'documentos de viaje'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 5. German Fact (Lease termination date)
  {
    id: 'test_shadow_archd_de_lease',
    originalText: 'Der Mietvertrag für die Wohnung in Berlin muss bis zum 30. November schriftlich gekündigt werden.',
    createdAt: '2026-08-23T06:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Der Mietvertrag für die Wohnung in Berlin muss bis zum 30. November schriftlich gekündigt werden.',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: [],
      places: ['Berlin', 'Wohnung'],
      topics: ['Mietvertrag', 'Kündigung', 'Wohnung'],
      contexts: ['Immobilien', 'Fristen'],
      retrieval_cues: ['Mietvertrag kündigen', 'Kündigungsfrist Berlin', '30. November Mietvertrag'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 6. Japanese Fact (Kyoto Hotel booking)
  {
    id: 'test_shadow_archd_ja_hotel',
    originalText: '京都旅行のホテル予約番号は KYOTO-99824 で、チェックインは15時です。',
    createdAt: '2026-08-24T07:00:00.000Z',
    isDone: false,
    interpretation: {
      content: '京都旅行のホテル予約番号は KYOTO-99824 で、チェックインは15時です。',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: [],
      places: ['京都', 'ホテル'],
      topics: ['ホテル予約', '京都旅行', '予約番号'],
      contexts: ['旅行', '予約'],
      retrieval_cues: ['京都ホテル予約', '予約番号 KYOTO-99824', '京都旅行 チェックイン'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 7. Arabic Fact (Office safe key)
  {
    id: 'test_shadow_archd_ar_safe',
    originalText: 'مفتاح الخزنة في المكتب موجود في الدرج المغلق خلف مكتب الاستقبال.',
    createdAt: '2026-08-25T08:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'مفتاح الخزنة في المكتب موجود في الدرج المغلق خلف مكتب الاستقبال.',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: [],
      places: ['المكتب', 'مكتب الاستقبال', 'الدرج المغلق'],
      topics: ['مفتاح الخزنة', 'أمان المكتب'],
      contexts: ['العمل', 'الأمان'],
      retrieval_cues: ['مفتاح الخزنة', 'خزنة المكتب', 'درج الاستقبال'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 8. Sibling 1: Lucy HR Policy
  {
    id: 'test_shadow_archd_sibling_lucy_hr',
    originalText: 'Lucy said the new remote work policy allows 3 days from home starting October.',
    createdAt: '2026-08-26T01:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Lucy said the new remote work policy allows 3 days from home starting October.',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: ['Lucy'],
      places: [],
      topics: ['HR', 'remote work policy', 'company updates'],
      contexts: ['work', 'human resources'],
      retrieval_cues: ['Lucy HR', 'remote work policy', 'Lucy work policy', 'working from home October'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 9. Sibling 2: Lucy Insurance Quote
  {
    id: 'test_shadow_archd_sibling_lucy_ins',
    originalText: 'Lucy quoted $1200 annually for comprehensive car insurance renewal.',
    createdAt: '2026-08-26T02:00:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Lucy quoted $1200 annually for comprehensive car insurance renewal.',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: ['Lucy'],
      places: [],
      topics: ['insurance', 'car insurance', 'quotes'],
      contexts: ['finances', 'insurance'],
      retrieval_cues: ['Lucy car insurance', 'Lucy quote 1200', 'insurance renewal', 'comprehensive car insurance'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 10. Japanese Sibling 1: Tanaka Sales
  {
    id: 'test_shadow_archd_sibling_tanaka_sales',
    originalText: '田中さんは来週月曜日の営業戦略会議の議事録を担当します。',
    createdAt: '2026-08-26T03:00:00.000Z',
    isDone: false,
    interpretation: {
      content: '田中さんは来週月曜日の営業戦略会議の議事録を担当します。',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: ['田中さん'],
      places: [],
      topics: ['営業戦略', '会議議事録', '田中'],
      contexts: ['仕事', '営業'],
      retrieval_cues: ['田中さん 営業会議', '田中 議事録', '営業戦略会議'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 11. Japanese Sibling 2: Tanaka Tech Support
  {
    id: 'test_shadow_archd_sibling_tanaka_tech',
    originalText: '田中さんの技術サポート直通電話番号は 03-1234-5678 です。',
    createdAt: '2026-08-26T04:00:00.000Z',
    isDone: false,
    interpretation: {
      content: '田中さんの技術サポート直通電話番号は 03-1234-5678 です。',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: ['田中さん'],
      places: [],
      topics: ['技術サポート', '電話番号', '田中'],
      contexts: ['サポート', '連絡先'],
      retrieval_cues: ['田中さん 技術サポート', '田中 電話番号 03-1234-5678', 'サポート直通'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 12. Same-Subject List Item 1
  {
    id: 'test_shadow_archd_subj_mum_sofa',
    originalText: "Mum sold the leather sofa for $300 on Marketplace.",
    createdAt: '2026-08-27T01:00:00.000Z',
    isDone: false,
    interpretation: {
      content: "Mum sold the leather sofa for $300 on Marketplace.",
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      subject: "Mum's sold items",
      people: ['Mum'],
      places: ['Marketplace'],
      topics: ['sales', 'sofa', "Mum's sold items"],
      contexts: ['furniture', 'selling'],
      retrieval_cues: ["Mum's sold items", 'mum sold sofa', 'marketplace sofa sale'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 13. Same-Subject List Item 2
  {
    id: 'test_shadow_archd_subj_mum_lamp',
    originalText: "Mum sold the brass floor lamp for $80 to Sarah.",
    createdAt: '2026-08-27T02:00:00.000Z',
    isDone: false,
    interpretation: {
      content: "Mum sold the brass floor lamp for $80 to Sarah.",
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      subject: "Mum's sold items",
      people: ['Mum', 'Sarah'],
      places: [],
      topics: ['sales', 'lamp', "Mum's sold items"],
      contexts: ['furniture', 'selling'],
      retrieval_cues: ["Mum's sold items", 'mum sold brass lamp', 'lamp to sarah'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
  // 14. Done Memory (Status isolation)
  {
    id: 'test_shadow_archd_done_groceries',
    originalText: 'Buy oat milk and eggs from the organic store.',
    createdAt: '2026-08-20T01:00:00.000Z',
    isDone: true, // DONE / RESOLVED
    interpretation: {
      content: 'Buy oat milk and eggs from the organic store.',
      kind: 'task',
      intent: 'remember',
      status: 'done',
      people: [],
      places: ['organic store'],
      topics: ['groceries', 'shopping'],
      contexts: ['groceries'],
      retrieval_cues: ['buy oat milk eggs', 'groceries organic store'],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  },
];

const TEST_CASES: TestCase[] = [
  // 1. English Standard
  {
    id: 'TC-01-EN',
    category: '1. English',
    query: 'Where did I put the spare car key?',
    expectedMemoryIds: ['test_shadow_archd_en_key'],
    notes: 'English standard factual retrieval',
  },
  // 2. French Standard
  {
    id: 'TC-02-FR',
    category: '2. French',
    query: 'Combien a coûté la révision de la voiture chez le garagiste ?',
    expectedMemoryIds: ['test_shadow_archd_fr_garage'],
    notes: 'French native lexical & semantic query',
  },
  // 3. Spanish Standard
  {
    id: 'TC-03-ES',
    category: '3. Spanish',
    query: '¿Dónde guardé los pasaportes para el viaje a Madrid?',
    expectedMemoryIds: ['test_shadow_archd_es_passport'],
    notes: 'Spanish accented Latin factual query',
  },
  // 4. German Standard
  {
    id: 'TC-04-DE',
    category: '4. German',
    query: 'Wann muss der Mietvertrag für die Wohnung in Berlin gekündigt werden?',
    expectedMemoryIds: ['test_shadow_archd_de_lease'],
    notes: 'German compound word & date query',
  },
  // 5. Japanese Standard
  {
    id: 'TC-05-JA',
    category: '5. Japanese',
    query: '京都旅行のホテル予約番号は何番ですか？',
    expectedMemoryIds: ['test_shadow_archd_ja_hotel'],
    notes: 'Japanese non-spaced Unicode query',
  },
  // 6. Arabic Standard
  {
    id: 'TC-06-AR',
    category: '6. Arabic',
    query: 'أين وضعت مفتاح الخزنة في المكتب؟',
    expectedMemoryIds: ['test_shadow_archd_ar_safe'],
    notes: 'Arabic Right-to-Left script factual query',
  },
  // 7. Cross-Language: English Query -> French Memory
  {
    id: 'TC-07-XL-EN-FR',
    category: '7. Cross-Language',
    query: 'How much was the car service invoice in Paris?',
    expectedMemoryIds: ['test_shadow_archd_fr_garage'],
    notes: 'Cross-language: English query retrieving French stored memory',
  },
  // 8. Cross-Language: French Query -> English Memory
  {
    id: 'TC-08-XL-FR-EN',
    category: '7. Cross-Language',
    query: 'Où se trouve le double des clés de la voiture ?',
    expectedMemoryIds: ['test_shadow_archd_en_key'],
    notes: 'Cross-language: French query retrieving English stored memory',
  },
  // 9. Cross-Language: English Query -> Japanese Memory
  {
    id: 'TC-09-XL-EN-JA',
    category: '7. Cross-Language',
    query: 'What is my Kyoto hotel reservation confirmation code?',
    expectedMemoryIds: ['test_shadow_archd_ja_hotel'],
    notes: 'Cross-language: English query retrieving Japanese stored memory',
  },
  // 10. Cross-Language: Japanese Query -> English Memory
  {
    id: 'TC-10-XL-JA-EN',
    category: '7. Cross-Language',
    query: '予備の車の鍵はどこに置いてありますか？',
    expectedMemoryIds: ['test_shadow_archd_en_key'],
    notes: 'Cross-language: Japanese query retrieving English stored memory',
  },
  // 11. Sibling Disambiguation: Lucy HR
  {
    id: 'TC-11-SIB-LUCY-HR',
    category: '8. Sibling Memories',
    query: 'What did Lucy say about the remote work policy?',
    expectedMemoryIds: ['test_shadow_archd_sibling_lucy_hr'],
    unexpectedMemoryIds: ['test_shadow_archd_sibling_lucy_ins'],
    notes: 'Disambiguate Lucy HR from Lucy Insurance Quote via dual-signal arbitration',
  },
  // 12. Sibling Disambiguation: Lucy Insurance
  {
    id: 'TC-12-SIB-LUCY-INS',
    category: '8. Sibling Memories',
    query: 'What was Lucy\'s quote for car insurance renewal?',
    expectedMemoryIds: ['test_shadow_archd_sibling_lucy_ins'],
    unexpectedMemoryIds: ['test_shadow_archd_sibling_lucy_hr'],
    notes: 'Disambiguate Lucy Insurance from Lucy HR via dual-signal arbitration',
  },
  // 13. Sibling Disambiguation: Tanaka Sales (Japanese)
  {
    id: 'TC-13-SIB-TANAKA-SALES',
    category: '8. Sibling Memories',
    query: '田中さんの営業戦略会議のメモ',
    expectedMemoryIds: ['test_shadow_archd_sibling_tanaka_sales'],
    unexpectedMemoryIds: ['test_shadow_archd_sibling_tanaka_tech'],
    notes: 'Japanese sibling disambiguation: Tanaka Sales vs Tanaka Tech Support',
  },
  // 14. Sibling Disambiguation: Tanaka Tech Support (Japanese)
  {
    id: 'TC-14-SIB-TANAKA-TECH',
    category: '8. Sibling Memories',
    query: '田中さんの技術サポート電話番号',
    expectedMemoryIds: ['test_shadow_archd_sibling_tanaka_tech'],
    unexpectedMemoryIds: ['test_shadow_archd_sibling_tanaka_sales'],
    notes: 'Japanese sibling disambiguation: Tanaka Tech Support vs Tanaka Sales',
  },
  // 15. Same-Subject List Complete Recall
  {
    id: 'TC-15-SUBJ-MUM-ITEMS',
    category: '9. Same-Subject Lists',
    query: "What's in Mum's sold items?",
    expectedMemoryIds: ['test_shadow_archd_subj_mum_sofa', 'test_shadow_archd_subj_mum_lamp'],
    expectedRoute: 'exact_subject',
    notes: 'Deterministic subject projection must return all items in the list cluster',
  },
  // 16. Paraphrase / Semantic Drift
  {
    id: 'TC-16-PARAPHRASE',
    category: '10. Paraphrase',
    query: 'Can you remind me where the backup automobile ignition key was stored?',
    expectedMemoryIds: ['test_shadow_archd_en_key'],
    notes: 'High semantic drift with zero shared tokens to "spare car key"',
  },
  // 17. Messy Conversational Phrasing
  {
    id: 'TC-17-MESSY',
    category: '11. Messy Conversational Phrasing',
    query: 'hey um quick question who did that gutter cleaning price quote and how much was it again?',
    expectedMemoryIds: ['test_shadow_archd_en_plumber'],
    notes: 'Conversational noise, modals, and filler words',
  },
  // 18. Numbers, Currency, Locale
  {
    id: 'TC-18-NUM-CURRENCY',
    category: '13. Numbers, Currency & Locale',
    query: 'How much was the $450 quote from Dave?',
    expectedMemoryIds: ['test_shadow_archd_en_plumber'],
    notes: 'Numeric amount and dollar currency symbol in query',
  },
  // 19. Done Memory Status Isolation
  {
    id: 'TC-19-STATUS-ISOLATION',
    category: '14. Deleted / Done Knowledge Isolation',
    query: 'Do I still need to buy oat milk and eggs from the store?',
    expectedMemoryIds: [], // Done item must not be returned for active search
    expectZeroResult: true,
    notes: 'Status isolation: Completed/done task must not be returned in active retrieval',
  },
  // 20. Genuine Zero-Result Distractor Rejection
  {
    id: 'TC-20-ZERO-DISTRACTOR-1',
    category: '15. Genuine Zero-Result Questions',
    query: 'What is the secret recipe for Martian sourdough bread baked on Jupiter?',
    expectedMemoryIds: [],
    expectZeroResult: true,
    notes: 'Irrelevant distractor must cleanly produce zero results',
  },
  // 21. Genuine Zero-Result Distractor Rejection 2
  {
    id: 'TC-21-ZERO-DISTRACTOR-2',
    category: '15. Genuine Zero-Result Questions',
    query: 'How do I build a nuclear fusion reactor in Minecraft hardcore mode?',
    expectedMemoryIds: [],
    expectZeroResult: true,
    notes: 'Irrelevant gaming/science question with no memory match',
  },
  // 22. Genuinely Ambiguous Sibling Query
  {
    id: 'TC-22-AMBIGUOUS-SIBLING',
    category: '18. Genuinely Ambiguous Sibling Question',
    query: 'What did Lucy say?',
    expectedMemoryIds: ['test_shadow_archd_sibling_lucy_hr'],
    expectAmbiguityRescue: true,
    notes: 'Ambiguous query without entity/topic specificity: Stage C Ambiguity Rescue evaluates top candidates safely',
  },
];

async function seedSuiteFixtures() {
  console.log(`[Seed] Inserting ${FIXTURES.length} multilingual test fixtures...`);
  await insertMemories(FIXTURES as any);

  console.log('[Seed] Syncing 512D vectors for test fixtures...');
  for (const f of FIXTURES) {
    const docText = buildMemoryDocumentString(f);
    await syncMemoryVector(f.id, docText);
  }
  console.log('[Seed] Fixtures seeded and vectors synced.');
}

async function cleanupSuiteFixtures() {
  console.log('[Cleanup] Deleting test fixtures and vectors...');
  const ids = FIXTURES.map(f => f.id);
  const placeholders = ids.map(() => '?').join(',');

  await executeBunnySql([
    { sql: `DELETE FROM memories WHERE id IN (${placeholders});`, args: ids },
    { sql: `DELETE FROM memory_search_projection WHERE memory_id IN (${placeholders});`, args: ids },
    { sql: `DELETE FROM memories_fts WHERE memory_id IN (${placeholders});`, args: ids },
    { sql: `DELETE FROM memory_vectors WHERE memory_id IN (${placeholders});`, args: ids },
  ]);
  console.log('[Cleanup] Completed cleanly.');
}

async function verifyNoTempTables() {
  const res = await executeBunnySql([
    {
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='temp_multilingual_vectors_exp';",
      args: [],
    },
  ]);
  return res[0]?.rows || [];
}

async function runSuite() {
  await initBunnyDb();
  console.log('================================================================');
  console.log('PHASE 2 — ARCHITECTURE D SHADOW RETRIEVAL VERIFICATION SUITE');
  console.log('================================================================\n');

  await seedSuiteFixtures();

  const results: any[] = [];
  const latencies = {
    embedding: [] as number[],
    vectorSql: [] as number[],
    arbitration: [] as number[],
    ambiguityRescue: [] as number[],
    hydration: [] as number[],
    total: [] as number[],
  };

  let passedCount = 0;
  let failedCount = 0;

  for (const tc of TEST_CASES) {
    console.log(`\n----------------------------------------------------------------`);
    console.log(`Executing [${tc.id}] (${tc.category}): "${tc.query}"`);

    const res = await executeArchitectureDRetrieval({
      question: tc.query,
      nowIso: LOCAL_CONTEXT.nowIso,
      activeRoleLabels: LOCAL_CONTEXT.activeRoleLabels,
      legacyCandidateIds: [], // Isolated test
      targetStatus: 'active',
    });

    const t = res.shadowTelemetry;
    const returnedCandidateMemories = res.candidateMemories; // SHADOW INVARIANT CHECK
    const debugCandidateIds = res.debugCandidates.map((m: any) => m.id);
    const retrievedArchDIds = t.architecture_d_ids;

    // Invariant Check 1: In shadow mode, candidateMemories MUST BE strictly []
    const shadowIsolationPassed = Array.isArray(returnedCandidateMemories) && returnedCandidateMemories.length === 0;

    // Check match criteria
    let testPassed = true;
    const failureReasons: string[] = [];

    if (!shadowIsolationPassed) {
      testPassed = false;
      failureReasons.push('SHADOW INVARIANT VIOLATION: candidateMemories is not empty []');
    }

    if (tc.expectZeroResult) {
      if (retrievedArchDIds.length > 0) {
        testPassed = false;
        failureReasons.push(`Expected 0 results, got ${retrievedArchDIds.length} ([${retrievedArchDIds.join(', ')}])`);
      }
    } else {
      for (const expId of tc.expectedMemoryIds) {
        if (!retrievedArchDIds.includes(expId)) {
          testPassed = false;
          failureReasons.push(`Missing expected candidate: ${expId}`);
        }
      }
    }

    if (tc.unexpectedMemoryIds) {
      for (const unexpId of tc.unexpectedMemoryIds) {
        if (retrievedArchDIds.includes(unexpId)) {
          testPassed = false;
          failureReasons.push(`Retrieved unexpected candidate: ${unexpId}`);
        }
      }
    }

    if (tc.expectedRoute && t.route_taken !== tc.expectedRoute) {
      testPassed = false;
      failureReasons.push(`Expected route ${tc.expectedRoute}, got ${t.route_taken}`);
    }

    if (tc.expectAmbiguityRescue && !t.ambiguity_rescue_triggered) {
      testPassed = false;
      failureReasons.push('Expected Ambiguity Rescue to be triggered, but was not');
    }

    if (testPassed) {
      passedCount++;
      console.log(`STATUS: PASSED`);
    } else {
      failedCount++;
      console.log(`STATUS: FAILED -> ${failureReasons.join(' | ')}`);
    }

    console.log(`Route: ${t.route_taken} | Script: ${t.query_language_script}`);
    console.log(`Top Candidate: ${t.top_candidate_id} (Sim: ${t.top_cosine_similarity?.toFixed(4) ?? 'N/A'}, Dist: ${t.top_cosine_distance?.toFixed(4) ?? 'N/A'})`);
    console.log(`Sibling Band Candidates: ${t.sibling_candidates_in_band}`);
    console.log(`Composite Scores: ${JSON.stringify(t.composite_scores)}`);
    console.log(`Lexical Anchors: ${JSON.stringify(t.lexical_unique_anchors)}`);
    console.log(`Ambiguity Rescue: ${t.ambiguity_rescue_triggered ? `YES (${t.ambiguity_rescue_reason})` : 'NO'}`);
    console.log(`Latency: Total=${t.timings.total_architecture_d_ms}ms (Embed=${t.timings.embedding_api_ms}ms, VecSQL=${t.timings.vector_sql_ms}ms, Arb=${t.timings.arbitration_ms}ms, Rescue=${t.timings.ambiguity_rescue_ms}ms, Hydrate=${t.timings.hydration_ms}ms)`);
    console.log(`Retrieved ArchD IDs: [${retrievedArchDIds.join(', ')}]`);
    console.log(`Hydrated Debug IDs: [${debugCandidateIds.join(', ')}]`);
    console.log(`Shadow Isolation Verified (candidateMemories === []): ${shadowIsolationPassed}`);

    // Track latencies
    latencies.embedding.push(t.timings.embedding_api_ms);
    latencies.vectorSql.push(t.timings.vector_sql_ms);
    latencies.arbitration.push(t.timings.arbitration_ms);
    if (t.timings.ambiguity_rescue_ms > 0) latencies.ambiguityRescue.push(t.timings.ambiguity_rescue_ms);
    latencies.hydration.push(t.timings.hydration_ms);
    latencies.total.push(t.timings.total_architecture_d_ms);

    results.push({
      id: tc.id,
      category: tc.category,
      query: tc.query,
      passed: testPassed,
      failureReasons,
      route: t.route_taken,
      topCandidateId: t.top_candidate_id,
      topSimilarity: t.top_cosine_similarity,
      topDistance: t.top_cosine_distance,
      siblingBandCount: t.sibling_candidates_in_band,
      compositeScores: t.composite_scores,
      lexicalAnchors: t.lexical_unique_anchors,
      ambiguityRescueTriggered: t.ambiguity_rescue_triggered,
      ambiguityRescueReason: t.ambiguity_rescue_reason,
      ambiguityRescueOutput: t.ambiguity_rescue_output,
      timings: t.timings,
      retrievedIds: retrievedArchDIds,
      shadowIsolationPassed,
    });
  }

  // Cleanup
  await cleanupSuiteFixtures();

  // Cleanup verification
  const tempTableRows = await verifyNoTempTables();
  console.log(`\n================================================================`);
  console.log(`CLEANUP PROOF QUERY RESULT:`);
  console.log(`SELECT name FROM sqlite_master WHERE type='table' AND name='temp_multilingual_vectors_exp';`);
  console.log(`Returned rows count: ${tempTableRows.length}`);
  console.log(`Rows: ${JSON.stringify(tempTableRows)}`);
  console.log(`================================================================\n`);

  // Latency Stats helper
  const stats = (arr: number[]) => {
    if (arr.length === 0) return { mean: 0, min: 0, max: 0, count: 0 };
    const sum = arr.reduce((a, b) => a + b, 0);
    return {
      mean: Math.round(sum / arr.length),
      min: Math.min(...arr),
      max: Math.max(...arr),
      count: arr.length,
    };
  };

  const embedStats = stats(latencies.embedding);
  const vecSqlStats = stats(latencies.vectorSql);
  const arbStats = stats(latencies.arbitration);
  const rescueStats = stats(latencies.ambiguityRescue);
  const hydrateStats = stats(latencies.hydration);
  const totalStats = stats(latencies.total);

  console.log('================================================================');
  console.log('ARCHITECTURE D SHADOW LATENCY SUMMARY (PLAIN NUMBERS)');
  console.log('================================================================');
  console.log(`Document / Query Embedding API: mean ${embedStats.mean} ms, min ${embedStats.min} ms, max ${embedStats.max} ms (sample count: ${embedStats.count})`);
  console.log(`512D Vector Cosine SQL Scan: mean ${vecSqlStats.mean} ms, min ${vecSqlStats.min} ms, max ${vecSqlStats.max} ms (sample count: ${vecSqlStats.count})`);
  console.log(`Dual-Signal Arbitration: mean ${arbStats.mean} ms, min ${arbStats.min} ms, max ${arbStats.max} ms (sample count: ${arbStats.count})`);
  console.log(`Ambiguity Rescue (when triggered): mean ${rescueStats.mean} ms, min ${rescueStats.min} ms, max ${rescueStats.max} ms (sample count: ${rescueStats.count})`);
  console.log(`Database Hydration: mean ${hydrateStats.mean} ms, min ${hydrateStats.min} ms, max ${hydrateStats.max} ms (sample count: ${hydrateStats.count})`);
  console.log(`Total End-to-End Retrieval: mean ${totalStats.mean} ms, min ${totalStats.min} ms, max ${totalStats.max} ms (sample count: ${totalStats.count})`);
  console.log('================================================================\n');

  console.log(`SUITE RESULTS: Passed ${passedCount} / ${TEST_CASES.length} (${((passedCount / TEST_CASES.length) * 100).toFixed(1)}%)`);

  fs.writeFileSync('scripts/architecture-d-shadow-results.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      total: TEST_CASES.length,
      passed: passedCount,
      failed: failedCount,
      passRate: `${((passedCount / TEST_CASES.length) * 100).toFixed(1)}%`,
    },
    latencyStats: {
      embedding: embedStats,
      vectorSql: vecSqlStats,
      arbitration: arbStats,
      ambiguityRescue: rescueStats,
      hydration: hydrateStats,
      total: totalStats,
    },
    cleanupProof: {
      tempTablesCount: tempTableRows.length,
    },
    testCases: results,
  }, null, 2));
}

runSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

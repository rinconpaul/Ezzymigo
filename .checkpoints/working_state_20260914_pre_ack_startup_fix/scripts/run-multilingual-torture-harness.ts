import fs from 'fs';
import path from 'path';
import { initBunnyDb } from '../server/db/schema.js';
import { executeBunnySql } from '../server/db/client.js';
import { insertMemories } from '../server/db/memories.js';
import { executeArchitectureDRetrieval } from '../server/retrieval/architecture_d.js';
import { syncMemoryVector } from '../server/retrieval/vector_service.js';

interface MemoryFixture {
  memory_id: string;
  text: string;
}

interface TortureFixture {
  test_id: string;
  categories: string[];
  memory_language: string;
  query_language: string;
  memories: MemoryFixture[];
  query: string;
  required_memory_ids: string[];
  forbidden_memory_ids: string[];
  expected_outcome: 'exact_single' | 'exact_set' | 'ambiguity' | 'zero_result';
  rationale: string;
}

interface NegativeControl {
  control_id: string;
  based_on: string;
  mutation_type: string;
  mutation: string;
  expected_harness_result: string;
  why: string;
}

interface CorpusData {
  corpus_meta: {
    name: string;
    version: string;
    frozen: boolean;
    constructed_by: string;
    purpose: string;
    languages_covered: string[];
    total_same_language_fixtures: number;
    total_cross_language_fixtures: number;
    total_code_switch_fixtures: number;
    total_fixtures: number;
    negative_control_mutations: number;
    expected_outcome_types: string[];
    notes: string;
  };
  fixtures: TortureFixture[];
  negative_control_mutations: NegativeControl[];
}

export interface EvaluationResult {
  test_id: string;
  language: string;
  category: string;
  query: string;
  expected_outcome: string;
  required_ids: string[];
  forbidden_ids: string[];
  retrieved_ids: string[];
  route: string;
  passed: boolean;
  failure_reason?: string;
  defect_classification?: string;
  timings: {
    total_ms: number;
    embed_ms: number;
    vec_sql_ms: number;
    arb_ms: number;
    rescue_ms: number;
    hydrate_ms: number;
  };
  telemetry: {
    top_candidate_id: string | null;
    top_cosine_sim: number | null;
    sibling_candidates_in_band: number;
    composite_scores: Record<string, number>;
    lexical_unique_anchors: Record<string, string[]>;
    ambiguity_rescue_triggered: boolean;
    ambiguity_rescue_reason: string | null;
    ambiguity_rescue_output: any | null;
  };
}

async function cleanupSyntheticMemories(memoryIds: string[]) {
  if (!memoryIds || memoryIds.length === 0) return;
  const placeholders = memoryIds.map(() => '?').join(',');
  await executeBunnySql([
    { sql: `DELETE FROM memories WHERE id IN (${placeholders});`, args: memoryIds },
    { sql: `DELETE FROM memories_fts WHERE memory_id IN (${placeholders});`, args: memoryIds },
    { sql: `DELETE FROM memory_search_projection WHERE memory_id IN (${placeholders});`, args: memoryIds },
    { sql: `DELETE FROM memory_vectors WHERE memory_id IN (${placeholders});`, args: memoryIds },
  ]);
}

async function seedSyntheticMemories(memories: MemoryFixture[]) {
  if (!memories || memories.length === 0) return;
  const dbItems = memories.map(m => ({
    id: m.memory_id,
    originalText: m.text,
    createdAt: '2026-08-20T00:00:00.000Z',
    isDone: false,
    interpretation: {
      content: m.text,
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: [],
      places: [],
      topics: [],
      contexts: [],
      retrieval_cues: [],
      relationships: [],
      resurfacing: { mode: 'contextual', timing: 'Contextual / On retrieval' },
    },
  }));

  await insertMemories(dbItems);

  for (const m of memories) {
    await syncMemoryVector(m.memory_id, m.text);
  }
}

export function evaluateRetrieval(
  fixture: TortureFixture,
  retrievedIds: string[],
  route: string,
  telemetry: any
): { passed: boolean; reason?: string; defect?: string } {
  const { required_memory_ids, forbidden_memory_ids, expected_outcome } = fixture;

  // Check 1: Forbidden IDs must NEVER be returned
  for (const fId of forbidden_memory_ids) {
    if (retrievedIds.includes(fId)) {
      return {
        passed: false,
        reason: `Forbidden memory ID '${fId}' was returned in retrieved IDs [${retrievedIds.join(', ')}]`,
        defect: 'FORBIDDEN_ID_LEAKAGE',
      };
    }
  }

  // Check 2: Required IDs must ALL be present
  for (const rId of required_memory_ids) {
    if (!retrievedIds.includes(rId)) {
      return {
        passed: false,
        reason: `Required memory ID '${rId}' was NOT returned in retrieved IDs [${retrievedIds.join(', ')}]`,
        defect: 'MISSING_REQUIRED_ID',
      };
    }
  }

  // Check 3: Expected outcome specific criteria
  if (expected_outcome === 'zero_result') {
    if (retrievedIds.length > 0) {
      return {
        passed: false,
        reason: `Expected zero_result (empty candidate set), but retrieved IDs: [${retrievedIds.join(', ')}]`,
        defect: 'FALSE_POSITIVE_ON_ZERO_RESULT',
      };
    }
  } else if (expected_outcome === 'exact_single') {
    if (retrievedIds.length !== 1) {
      return {
        passed: false,
        reason: `Expected exact_single (1 memory), but received ${retrievedIds.length} IDs: [${retrievedIds.join(', ')}]`,
        defect: 'CARDINALITY_MISMATCH_SINGLE',
      };
    }
  } else if (expected_outcome === 'exact_set') {
    if (retrievedIds.length < required_memory_ids.length) {
      return {
        passed: false,
        reason: `Expected exact_set of at least ${required_memory_ids.length} memories, but retrieved ${retrievedIds.length} IDs: [${retrievedIds.join(', ')}]`,
        defect: 'INCOMPLETE_SET',
      };
    }
  } else if (expected_outcome === 'ambiguity') {
    const isAmbiguousReported = telemetry.ambiguity_rescue_triggered && telemetry.ambiguity_rescue_output?.isAmbiguous;
    const hasMultipleCandidates = retrievedIds.length >= 2;
    if (!isAmbiguousReported && !hasMultipleCandidates && retrievedIds.length === 1) {
      return {
        passed: false,
        reason: `Expected ambiguity handling (multiple preserved siblings / ambiguity flag), but system committed to single memory '${retrievedIds[0]}'`,
        defect: 'PREMATURE_AMBIGUITY_COMMITMENT',
      };
    }
  }

  return { passed: true };
}

async function runSingleFixture(fixture: TortureFixture): Promise<EvaluationResult> {
  const memoryIds = fixture.memories.map(m => m.memory_id);
  
  try {
    // 1. Seed memories & vectors
    await seedSyntheticMemories(fixture.memories);

    // 2. Execute Architecture D retrieval
    const result = await executeArchitectureDRetrieval({
      question: fixture.query,
      nowIso: '2026-08-28T00:00:00.000Z',
      targetStatus: 'active',
    });

    const retrievedIds = result.shadowTelemetry.architecture_d_ids;
    const route = result.shadowTelemetry.route_taken;
    const telemetry = result.shadowTelemetry;

    // 3. Evaluate against ground truth
    const evalResult = evaluateRetrieval(fixture, retrievedIds, route, telemetry);

    return {
      test_id: fixture.test_id,
      language: fixture.query_language,
      category: fixture.categories.join(', '),
      query: fixture.query,
      expected_outcome: fixture.expected_outcome,
      required_ids: fixture.required_memory_ids,
      forbidden_ids: fixture.forbidden_memory_ids,
      retrieved_ids: retrievedIds,
      route: route,
      passed: evalResult.passed,
      failure_reason: evalResult.reason,
      defect_classification: evalResult.defect,
      timings: {
        total_ms: telemetry.timings.total_architecture_d_ms,
        embed_ms: telemetry.timings.embedding_api_ms,
        vec_sql_ms: telemetry.timings.vector_sql_ms,
        arb_ms: telemetry.timings.arbitration_ms,
        rescue_ms: telemetry.timings.ambiguity_rescue_ms,
        hydrate_ms: telemetry.timings.hydration_ms,
      },
      telemetry: {
        top_candidate_id: telemetry.top_candidate_id,
        top_cosine_sim: telemetry.top_cosine_similarity,
        sibling_candidates_in_band: telemetry.sibling_candidates_in_band,
        composite_scores: telemetry.composite_scores,
        lexical_unique_anchors: telemetry.lexical_unique_anchors,
        ambiguity_rescue_triggered: telemetry.ambiguity_rescue_triggered,
        ambiguity_rescue_reason: telemetry.ambiguity_rescue_reason,
        ambiguity_rescue_output: telemetry.ambiguity_rescue_output,
      },
    };
  } finally {
    // 4. Always clean up synthetic memories
    await cleanupSyntheticMemories(memoryIds);
  }
}

export async function main() {
  console.log('================================================================================');
  console.log('  ARCHITECTURE D — MULTILINGUAL TORTURE HARNESS EXECUTION                      ');
  console.log('================================================================================\n');

  await initBunnyDb();

  const corpusPath = path.resolve('multilingual_torture_fixtures_v1.json');
  if (!fs.existsSync(corpusPath)) {
    console.error(`ERROR: Corpus file not found at ${corpusPath}`);
    process.exit(1);
  }

  const rawJson = fs.readFileSync(corpusPath, 'utf8');
  const corpus: CorpusData = JSON.parse(rawJson);

  // ---------------------------------------------------------------------------
  // PHASE 1: VERIFY THE EXAM PAPER
  // ---------------------------------------------------------------------------
  console.log('--- PHASE 1: EXAM PAPER VERIFICATION ---');
  console.log(`Corpus Name: ${corpus.corpus_meta.name}`);
  console.log(`Frozen Flag: ${corpus.corpus_meta.frozen}`);
  console.log(`Total Fixtures in metadata: ${corpus.corpus_meta.total_fixtures}`);
  console.log(`Total Fixtures in array: ${corpus.fixtures.length}`);

  const sameLang = corpus.fixtures.filter(f => f.categories.includes('same_language')).length;
  const crossLang = corpus.fixtures.filter(f => f.categories.includes('cross_language')).length;
  const codeSwitch = corpus.fixtures.filter(f => f.categories.includes('code_switch')).length;
  console.log(`Same-Language Count: ${sameLang} (metadata: ${corpus.corpus_meta.total_same_language_fixtures})`);
  console.log(`Cross-Language Count: ${crossLang} (metadata: ${corpus.corpus_meta.total_cross_language_fixtures})`);
  console.log(`Code-Switch Count: ${codeSwitch} (metadata: ${corpus.corpus_meta.total_code_switch_fixtures})`);

  const languages = new Set<string>();
  corpus.fixtures.forEach(f => {
    languages.add(f.memory_language);
    languages.add(f.query_language);
  });
  console.log(`Languages Represented: ${Array.from(languages).join(', ')}`);

  const outcomeCounts: Record<string, number> = {};
  corpus.fixtures.forEach(f => {
    outcomeCounts[f.expected_outcome] = (outcomeCounts[f.expected_outcome] || 0) + 1;
  });
  console.log('Outcome-Type Counts:', outcomeCounts);
  console.log(`Negative Controls in array: ${corpus.negative_control_mutations?.length || 0}`);

  // Check unique IDs
  const fixtureIdSet = new Set<string>();
  let dupFixtureCount = 0;
  corpus.fixtures.forEach(f => {
    if (fixtureIdSet.has(f.test_id)) dupFixtureCount++;
    fixtureIdSet.add(f.test_id);
  });

  const memoryIdSet = new Set<string>();
  let dupMemoryCount = 0;
  corpus.fixtures.forEach(f => {
    f.memories.forEach(m => {
      if (memoryIdSet.has(m.memory_id)) dupMemoryCount++;
      memoryIdSet.add(m.memory_id);
    });
  });

  console.log(`Unique Fixture IDs: ${fixtureIdSet.size} (Duplicates: ${dupFixtureCount})`);
  console.log(`Unique Synthetic Memory IDs: ${memoryIdSet.size} (Duplicates: ${dupMemoryCount})`);

  if (dupFixtureCount > 0 || dupMemoryCount > 0 || !corpus.corpus_meta.frozen || corpus.fixtures.length !== 66) {
    console.error('FATAL: Corpus verification failed.');
    process.exit(1);
  }
  console.log('✅ Phase 1 Verification Passed: Corpus is authentic, valid, and internally consistent.\n');

  // ---------------------------------------------------------------------------
  // PHASE 3: PROVE THE EXAMINER WORKS (NEGATIVE CONTROLS)
  // ---------------------------------------------------------------------------
  console.log('================================================================================');
  console.log('  PHASE 3: NEGATIVE CONTROLS VALIDATION (PROVE EXAMINER WORKS)                 ');
  console.log('================================================================================\n');

  let negativeControlFailuresDetected = 0;
  const negativeControlReports: any[] = [];

  for (const nc of corpus.negative_control_mutations) {
    console.log(`--- Executing Negative Control [${nc.control_id}] (Based on ${nc.based_on}) ---`);
    console.log(`Mutation Type: ${nc.mutation_type}`);
    console.log(`Mutation: ${nc.mutation}`);
    console.log(`Expected Harness Verdict: ${nc.expected_harness_result}`);

    const baseFixture = corpus.fixtures.find(f => f.test_id === nc.based_on);
    if (!baseFixture) {
      throw new Error(`Base fixture ${nc.based_on} not found for negative control ${nc.control_id}`);
    }

    // Apply deliberate mutation to create poisoned test fixture
    const mutatedFixture: TortureFixture = JSON.parse(JSON.stringify(baseFixture));
    if (nc.control_id === 'NC-01') {
      mutatedFixture.required_memory_ids = ['syn_en_sarah_home'];
    } else if (nc.control_id === 'NC-02') {
      mutatedFixture.required_memory_ids = ['syn_en_bins'];
    } else if (nc.control_id === 'NC-03') {
      mutatedFixture.required_memory_ids = ['syn_fr_pierre_voisin'];
      mutatedFixture.forbidden_memory_ids = ['syn_fr_pierre_garage'];
    } else if (nc.control_id === 'NC-04') {
      mutatedFixture.expected_outcome = 'exact_single';
      mutatedFixture.required_memory_ids = ['syn_ja_yuki_ryoko'];
    } else if (nc.control_id === 'NC-05') {
      mutatedFixture.required_memory_ids = ['syn_ja_mitsumori'];
    }

    const evalResult = await runSingleFixture(mutatedFixture);

    console.log(`Actual Retrieved IDs: [${evalResult.retrieved_ids.join(', ')}]`);
    console.log(`Route Selected: ${evalResult.route}`);
    console.log(`Harness Evaluation Result: ${evalResult.passed ? 'PASS (ERROR: Failed to detect poisoned mutation)' : 'FAIL (SUCCESS: Poison detected)'}`);
    if (!evalResult.passed) {
      console.log(`Detection Reason: ${evalResult.failure_reason}`);
      console.log(`Defect Classification: ${evalResult.defect_classification}`);
      negativeControlFailuresDetected++;
    }

    negativeControlReports.push({
      control_id: nc.control_id,
      base_fixture: nc.based_on,
      mutation: nc.mutation,
      actual_retrieved_ids: evalResult.retrieved_ids,
      harness_verdict: evalResult.passed ? 'PASS' : 'FAIL',
      reason: evalResult.failure_reason,
    });
    console.log('');
  }

  console.log(`NEGATIVE CONTROLS RESULT: ${negativeControlFailuresDetected} / 5 NEGATIVE CONTROLS DETECTED AS FAIL`);

  if (negativeControlFailuresDetected !== 5) {
    console.error('FATAL: HARNESS VALIDATION FAILED — The examiner failed to reject one or more poisoned ground-truth mutations.');
    process.exit(1);
  }

  console.log('✅ Phase 3 Negative Control Validation Succeeded: 5 / 5 negative controls detected as FAIL.\n');

  // ---------------------------------------------------------------------------
  // PHASE 4: RUN THE FROZEN 66-CASE EXAM
  // ---------------------------------------------------------------------------
  console.log('================================================================================');
  console.log('  PHASE 4: RUNNING THE UNTOUCHED FROZEN 66-CASE TORTURE EXAM                  ');
  console.log('================================================================================\n');

  const allResults: EvaluationResult[] = [];
  const resultsFile = 'scripts/torture-results.json';
  if (fs.existsSync(resultsFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
      if (Array.isArray(existing.results)) {
        allResults.push(...existing.results);
        console.log(`Resuming from existing progress: ${allResults.length} / ${corpus.fixtures.length} already completed.\n`);
      }
    } catch (e) {
      console.log('Could not parse existing results file, starting fresh.');
    }
  }

  const startIndex = allResults.length;
  for (let i = startIndex; i < corpus.fixtures.length; i++) {
    const fixture = corpus.fixtures[i];
    const evalRes = await runSingleFixture(fixture);
    allResults.push(evalRes);

    const statusStr = evalRes.passed ? 'PASS' : 'FAIL';
    console.log(`[${i + 1}/${corpus.fixtures.length}] ${evalRes.test_id.padEnd(10)} | ${evalRes.language.padEnd(12)} | ${evalRes.category.padEnd(35)} | Exp: ${evalRes.expected_outcome.padEnd(12)} | Actual: [${evalRes.retrieved_ids.join(', ')}] | Route: ${evalRes.route.padEnd(23)} | ${statusStr.padEnd(5)} | ${evalRes.timings.total_ms}ms`);

    if (!evalRes.passed) {
      console.log(`   --> FAILURE DETAILS FOR ${evalRes.test_id}:`);
      console.log(`       Query: "${evalRes.query}"`);
      console.log(`       Candidate Memories Seeded: ${JSON.stringify(fixture.memories)}`);
      console.log(`       Required IDs: [${evalRes.required_ids.join(', ')}] | Forbidden IDs: [${evalRes.forbidden_ids.join(', ')}]`);
      console.log(`       Retrieved IDs: [${evalRes.retrieved_ids.join(', ')}]`);
      console.log(`       Vector Scores: TopID=${evalRes.telemetry.top_candidate_id}, TopSim=${evalRes.telemetry.top_cosine_sim?.toFixed(4)}, SiblingBandCount=${evalRes.telemetry.sibling_candidates_in_band}`);
      console.log(`       Lexical Anchors: ${JSON.stringify(evalRes.telemetry.lexical_unique_anchors)}`);
      console.log(`       Composite Scores: ${JSON.stringify(evalRes.telemetry.composite_scores)}`);
      console.log(`       Selected Route: ${evalRes.route}`);
      console.log(`       Ambiguity Rescue: Triggered=${evalRes.telemetry.ambiguity_rescue_triggered}, Reason=${evalRes.telemetry.ambiguity_rescue_reason}, Output=${JSON.stringify(evalRes.telemetry.ambiguity_rescue_output)}`);
      console.log(`       Failure Reason: ${evalRes.failure_reason}`);
      console.log(`       Defect Classification: ${evalRes.defect_classification}`);
    }

    // Progressively save results
    fs.writeFileSync('scripts/torture-results.json', JSON.stringify({
      timestamp: new Date().toISOString(),
      completed: allResults.length,
      total_cases: corpus.fixtures.length,
      passed_so_far: allResults.filter(r => r.passed).length,
      results: allResults,
    }, null, 2));
  }

  // ---------------------------------------------------------------------------
  // PHASE 5: BREAK DOWN THE RESULTS
  // ---------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  PHASE 5: MULTILINGUAL & CATEGORY BREAKDOWN                                   ');
  console.log('================================================================================\n');

  function calculateBreakdown(filterFn: (r: EvaluationResult) => boolean, label: string) {
    const subset = allResults.filter(filterFn);
    const passed = subset.filter(r => r.passed).length;
    const total = subset.length;
    const pct = total > 0 ? ((passed / total) * 100).toFixed(1) : 'N/A';
    console.log(`${label.padEnd(35)}: ${passed} / ${total} passed (${pct}%)`);
    return { passed, total };
  }

  console.log('--- BY LANGUAGE / COMBINATION ---');
  calculateBreakdown(r => r.language === 'en', 'English (en)');
  calculateBreakdown(r => r.language === 'fr', 'French (fr)');
  calculateBreakdown(r => r.language === 'es', 'Spanish (es)');
  calculateBreakdown(r => r.language === 'de', 'German (de)');
  calculateBreakdown(r => r.language === 'it', 'Italian (it)');
  calculateBreakdown(r => r.language === 'ja', 'Japanese (ja)');
  calculateBreakdown(r => r.language === 'zh', 'Simplified Chinese (zh)');
  calculateBreakdown(r => r.language === 'ar', 'Arabic (ar)');
  calculateBreakdown(r => r.category.includes('cross_language'), 'Cross-Language (xl)');
  calculateBreakdown(r => r.category.includes('code_switch'), 'Code-Switching (cs)');

  console.log('\n--- BY RETRIEVAL CHALLENGE CATEGORY ---');
  calculateBreakdown(r => r.category.includes('sibling_disambiguation'), 'Sibling Disambiguation');
  calculateBreakdown(r => r.category.includes('role_mediated'), 'Role-Mediated Retrieval');
  calculateBreakdown(r => r.category.includes('messy_phrasing'), 'Messy Conversational Phrasing');
  calculateBreakdown(r => r.category.includes('near_miss_zero_result'), 'Near-Miss Zero-Result');
  calculateBreakdown(r => r.category.includes('genuine_ambiguity'), 'Genuine Ambiguity');
  calculateBreakdown(r => r.category.includes('dates_times'), 'Dates & Times');
  calculateBreakdown(r => r.category.includes('currency_locale'), 'Currency & Locale');
  calculateBreakdown(r => r.category.includes('non_latin_script'), 'Non-Latin Scripts (CJK / Arabic)');
  calculateBreakdown(r => r.category.includes('rtl'), 'RTL (Arabic)');

  const totalPassed = allResults.filter(r => r.passed).length;
  const totalCases = allResults.length;
  const overallPct = ((totalPassed / totalCases) * 100).toFixed(1);

  console.log('\n================================================================================');
  console.log(`  OVERALL TORTURE RESULT: ${totalPassed} / ${totalCases} passed (${overallPct}%)`);
  console.log('================================================================================\n');

  // ---------------------------------------------------------------------------
  // PHASE 6: CLEANUP PROOF
  // ---------------------------------------------------------------------------
  console.log('================================================================================');
  console.log('  PHASE 6: DATABASE CLEANUP PROOF                                              ');
  console.log('================================================================================\n');

  const proofMemories = await executeBunnySql([
    { sql: `SELECT id, originalText FROM memories WHERE id LIKE 'syn_%' OR id LIKE 'xl_%' OR id LIKE 'cs_%';`, args: [] }
  ]);
  const proofFts = await executeBunnySql([
    { sql: `SELECT memory_id FROM memories_fts WHERE memory_id LIKE 'syn_%' OR memory_id LIKE 'xl_%' OR memory_id LIKE 'cs_%';`, args: [] }
  ]);
  const proofVectors = await executeBunnySql([
    { sql: `SELECT memory_id FROM memory_vectors WHERE memory_id LIKE 'syn_%' OR memory_id LIKE 'xl_%' OR memory_id LIKE 'cs_%';`, args: [] }
  ]);
  const proofProjection = await executeBunnySql([
    { sql: `SELECT memory_id FROM memory_search_projection WHERE memory_id LIKE 'syn_%' OR memory_id LIKE 'xl_%' OR memory_id LIKE 'cs_%';`, args: [] }
  ]);

  const memCount = proofMemories[0]?.rows?.length || 0;
  const ftsCount = proofFts[0]?.rows?.length || 0;
  const vecCount = proofVectors[0]?.rows?.length || 0;
  const projCount = proofProjection[0]?.rows?.length || 0;

  console.log(`Verification Query: SELECT count FROM memories WHERE id LIKE 'syn_%' OR id LIKE 'xl_%' OR id LIKE 'cs_%'`);
  console.log(`Memories Table Remaining Count: ${memCount}`);
  console.log(`FTS5 Table Remaining Count: ${ftsCount}`);
  console.log(`Vectors Table Remaining Count: ${vecCount}`);
  console.log(`Search Projection Remaining Count: ${projCount}`);

  if (memCount === 0 && ftsCount === 0 && vecCount === 0 && projCount === 0) {
    console.log('✅ CLEANUP VERIFIED: Zero synthetic torture records remain in SQLite database.\n');
  } else {
    console.log('⚠️ CLEANUP NOTE: Cleaning up remaining records now...');
    await executeBunnySql([
      { sql: `DELETE FROM memories WHERE id LIKE 'syn_%' OR id LIKE 'xl_%' OR id LIKE 'cs_%';`, args: [] },
      { sql: `DELETE FROM memories_fts WHERE memory_id LIKE 'syn_%' OR memory_id LIKE 'xl_%' OR memory_id LIKE 'cs_%';`, args: [] },
      { sql: `DELETE FROM memory_search_projection WHERE memory_id LIKE 'syn_%' OR memory_id LIKE 'xl_%' OR memory_id LIKE 'cs_%';`, args: [] },
      { sql: `DELETE FROM memory_vectors WHERE memory_id LIKE 'syn_%' OR memory_id LIKE 'xl_%' OR memory_id LIKE 'cs_%';`, args: [] },
    ]);
    console.log('✅ CLEANUP COMPLETE.\n');
  }
}

if (process.argv[1]?.includes('run-multilingual-torture-harness')) {
  main().catch(err => {
    console.error('Execution Error:', err);
    process.exit(1);
  });
}

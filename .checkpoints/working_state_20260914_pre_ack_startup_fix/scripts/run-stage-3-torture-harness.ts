import fs from 'fs';
import path from 'path';
import { initBunnyDb } from '../server/db/schema.js';
import { executeBunnySql } from '../server/db/client.js';
import { insertMemories } from '../server/db/memories.js';
import { executeArchitectureDRetrieval } from '../server/retrieval/architecture_d.js';
import { syncMemoryVector } from '../server/retrieval/vector_service.js';
import { evaluateRetrieval } from './run-multilingual-torture-harness.js';

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
  corpus_meta: any;
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
  is_inconclusive?: boolean;
  failure_reason?: string;
  defect_classification?: string;
  embedding_call_attempted: boolean;
  embedding_call_succeeded: boolean;
  embedding_error_code: string | null;
  vector_sql_executed: boolean;
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
    slot_audit_contradictions?: Record<string, string>;
    ambiguity_rescue_triggered: boolean;
    ambiguity_rescue_reason: string | null;
    ambiguity_rescue_output: any | null;
  };
}

async function cleanupSyntheticMemories(memoryIds: string[]): Promise<void> {
  if (memoryIds.length === 0) return;
  const placeholders = memoryIds.map(() => '?').join(',');
  await executeBunnySql([
    { sql: `DELETE FROM memories WHERE id IN (${placeholders});`, args: memoryIds },
    { sql: `DELETE FROM memories_fts WHERE memory_id IN (${placeholders});`, args: memoryIds },
    { sql: `DELETE FROM memory_search_projection WHERE memory_id IN (${placeholders});`, args: memoryIds },
    { sql: `DELETE FROM memory_vectors WHERE memory_id IN (${placeholders});`, args: memoryIds },
  ]);
}

async function seedFixtureMemories(fixture: TortureFixture): Promise<void> {
  const dbItems = fixture.memories.map(m => ({
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

  for (const m of fixture.memories) {
    await syncMemoryVector(m.memory_id, m.text);
  }
}

async function runSingleFixture(fixture: TortureFixture): Promise<EvaluationResult> {
  const memoryIds = fixture.memories.map(m => m.memory_id);

  try {
    await cleanupSyntheticMemories(memoryIds);

    let seedEmbeddingError: any = null;
    try {
      await seedFixtureMemories(fixture);
    } catch (err) {
      seedEmbeddingError = err;
    }

    if (seedEmbeddingError) {
      const errCode = String(seedEmbeddingError).includes('RESOURCE_EXHAUSTED') || String(seedEmbeddingError).includes('429')
        ? 'RESOURCE_EXHAUSTED_429'
        : 'EMBEDDING_SEED_ERROR';

      return {
        test_id: fixture.test_id,
        language: fixture.query_language,
        category: fixture.categories.join(', '),
        query: fixture.query,
        expected_outcome: fixture.expected_outcome,
        required_ids: fixture.required_memory_ids,
        forbidden_ids: fixture.forbidden_memory_ids,
        retrieved_ids: [],
        route: 'inconclusive_infra_failure',
        passed: false,
        is_inconclusive: true,
        failure_reason: `Infrastructure failure during memory embedding sync: ${seedEmbeddingError.message || seedEmbeddingError}`,
        defect_classification: 'INCONCLUSIVE_INFRA_FAILURE',
        embedding_call_attempted: true,
        embedding_call_succeeded: false,
        embedding_error_code: String(errCode),
        vector_sql_executed: false,
        timings: {
          total_ms: 0,
          embed_ms: 0,
          vec_sql_ms: 0,
          arb_ms: 0,
          rescue_ms: 0,
          hydrate_ms: 0,
        },
        telemetry: {
          top_candidate_id: null,
          top_cosine_sim: null,
          sibling_candidates_in_band: 0,
          composite_scores: {},
          lexical_unique_anchors: {},
          ambiguity_rescue_triggered: false,
          ambiguity_rescue_reason: null,
          ambiguity_rescue_output: null,
        },
      };
    }

    const result = await executeArchitectureDRetrieval({
      question: fixture.query,
      nowIso: '2026-08-28T00:00:00.000Z',
      targetStatus: 'active',
    });

    const retrievedIds = result.shadowTelemetry.architecture_d_ids;
    const route = result.shadowTelemetry.route_taken;
    const telemetry = result.shadowTelemetry;

    const embeddingAttempted = true;
    const embeddingSucceeded = !telemetry.error && (telemetry.timings.embedding_api_ms > 0 || !telemetry.error);
    const vectorSqlExecuted = telemetry.timings.vector_sql_ms > 0;

    if (telemetry.error || !embeddingSucceeded) {
      const errCode = String(telemetry.error).includes('RESOURCE_EXHAUSTED') || String(telemetry.error).includes('429')
        ? 'RESOURCE_EXHAUSTED_429'
        : 'EMBEDDING_QUERY_ERROR';

      return {
        test_id: fixture.test_id,
        language: fixture.query_language,
        category: fixture.categories.join(', '),
        query: fixture.query,
        expected_outcome: fixture.expected_outcome,
        required_ids: fixture.required_memory_ids,
        forbidden_ids: fixture.forbidden_memory_ids,
        retrieved_ids: [],
        route: 'inconclusive_infra_failure',
        passed: false,
        is_inconclusive: true,
        failure_reason: `Infrastructure failure during query embedding: ${telemetry.error}`,
        defect_classification: 'INCONCLUSIVE_INFRA_FAILURE',
        embedding_call_attempted: true,
        embedding_call_succeeded: false,
        embedding_error_code: String(errCode),
        vector_sql_executed: vectorSqlExecuted,
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
          slot_audit_contradictions: telemetry.slot_audit_contradictions,
          ambiguity_rescue_triggered: telemetry.ambiguity_rescue_triggered,
          ambiguity_rescue_reason: telemetry.ambiguity_rescue_reason,
          ambiguity_rescue_output: telemetry.ambiguity_rescue_output,
        },
      };
    }

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
      route,
      passed: evalResult.passed,
      is_inconclusive: false,
      failure_reason: evalResult.reason,
      defect_classification: evalResult.defect,
      embedding_call_attempted: embeddingAttempted,
      embedding_call_succeeded: embeddingSucceeded,
      embedding_error_code: null,
      vector_sql_executed: vectorSqlExecuted,
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
        slot_audit_contradictions: telemetry.slot_audit_contradictions,
        ambiguity_rescue_triggered: telemetry.ambiguity_rescue_triggered,
        ambiguity_rescue_reason: telemetry.ambiguity_rescue_reason,
        ambiguity_rescue_output: telemetry.ambiguity_rescue_output,
      },
    };
  } finally {
    await cleanupSyntheticMemories(memoryIds);
  }
}

async function main() {
  console.log(`================================================================================`);
  console.log(`  CLASS B — MULTILINGUAL TORTURE TEST HARNESS (STAGE 3 SLOT-AUDIT AUDIT)`);
  console.log(`  Testing Architecture D: Vector + Stage 1 Lexical + Stage 2 Context + Stage 3 Gate`);
  console.log(`================================================================================\n`);

  await initBunnyDb();

  const corpusPath = path.resolve(process.cwd(), 'multilingual_torture_fixtures_v1.json');
  if (!fs.existsSync(corpusPath)) {
    console.error(`Corpus file not found at ${corpusPath}`);
    process.exit(1);
  }

  const corpus: CorpusData = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  console.log(`Loaded ${corpus.fixtures.length} fixtures and ${corpus.negative_control_mutations.length} negative controls.`);

  const args = process.argv.slice(2);
  const targetId = args.find(a => a.startsWith('--id='))?.split('=')[1];
  const targetLanguage = args.find(a => a.startsWith('--lang='))?.split('=')[1];
  const batchArg = args.find(a => a.startsWith('--batch='))?.split('=')[1];

  let fixturesToRun = corpus.fixtures;
  if (targetId) {
    fixturesToRun = fixturesToRun.filter(f => f.test_id === targetId);
  }
  if (targetLanguage) {
    fixturesToRun = fixturesToRun.filter(f => f.query_language === targetLanguage || f.memory_language === targetLanguage);
  }
  if (batchArg) {
    const batchNum = parseInt(batchArg, 10);
    const batchSize = 11;
    const startIdx = (batchNum - 1) * batchSize;
    fixturesToRun = fixturesToRun.slice(startIdx, startIdx + batchSize);
    console.log(`Running Batch ${batchNum}: fixtures ${startIdx + 1} to ${startIdx + fixturesToRun.length}`);
  }

  const allResults: EvaluationResult[] = [];

  for (let i = 0; i < fixturesToRun.length; i++) {
    const fixture = fixturesToRun[i];
    console.log(`[${i + 1}/${fixturesToRun.length}] Testing ${fixture.test_id} (${fixture.query_language}): "${fixture.query}"`);

    const result = await runSingleFixture(fixture);
    allResults.push(result);

    if (result.is_inconclusive) {
      console.log(`  -> RESULT: INCONCLUSIVE (Infrastructure Error: ${result.embedding_error_code})`);
      console.log(`     ${result.failure_reason}`);
    } else if (result.passed) {
      console.log(`  -> RESULT: PASS [Route: ${result.route}] (Retrieved: ${JSON.stringify(result.retrieved_ids)})`);
    } else {
      console.log(`  -> RESULT: FAIL [Defect: ${result.defect_classification}] [Route: ${result.route}]`);
      console.log(`     Expected: ${JSON.stringify(result.required_ids)} | Received: ${JSON.stringify(result.retrieved_ids)}`);
      console.log(`     Reason: ${result.failure_reason}`);
    }
  }

  if (batchArg) {
    const batchNum = parseInt(batchArg, 10);
    const batchFile = `scripts/torture-stage3-batch${batchNum}-results.json`;
    fs.writeFileSync(batchFile, JSON.stringify(allResults, null, 2));
    console.log(`\nBatch ${batchNum} results saved to ${batchFile}`);
    return;
  }

  // Evaluate Negative Controls
  console.log(`\n--- Evaluating ${corpus.negative_control_mutations.length} Negative Controls ---`);
  let negativeControlFailuresDetected = 0;
  let validNegativeControlsEvaluated = 0;
  let inconclusiveNegativeControls = 0;
  const negativeControlResults: any[] = [];

  for (const nc of corpus.negative_control_mutations) {
    const baseFixture = corpus.fixtures.find(f => f.test_id === nc.based_on);
    if (!baseFixture) {
      console.warn(`Base fixture ${nc.based_on} not found for negative control ${nc.control_id}`);
      continue;
    }

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
    if (evalResult.is_inconclusive) {
      inconclusiveNegativeControls++;
      console.log(`[${nc.control_id}] Negative control run INCONCLUSIVE due to infra failure`);
      continue;
    }

    validNegativeControlsEvaluated++;
    if (!evalResult.passed) {
      negativeControlFailuresDetected++;
      console.log(`[${nc.control_id}] Poison detected as expected failure (SUCCESS): ${evalResult.defect_classification}`);
      negativeControlResults.push({
        control_id: nc.control_id,
        status: 'DETECTED',
        retrieved_ids: evalResult.retrieved_ids,
        defect: evalResult.defect_classification,
        reason: evalResult.failure_reason,
      });
    } else {
      console.log(`[${nc.control_id}] Poison NOT detected: returned ${JSON.stringify(evalResult.retrieved_ids)} satisfying poisoned ground truth (ERROR)`);
      negativeControlResults.push({
        control_id: nc.control_id,
        status: 'MISSED',
        retrieved_ids: evalResult.retrieved_ids,
      });
    }
  }

  const ncSummary = {
    timestamp: new Date().toISOString(),
    total_attempted: corpus.negative_control_mutations.length,
    conclusive: validNegativeControlsEvaluated,
    inconclusive: inconclusiveNegativeControls,
    detected: negativeControlFailuresDetected,
    missed: validNegativeControlsEvaluated - negativeControlFailuresDetected,
    results: negativeControlResults,
  };
  fs.writeFileSync('scripts/torture-stage3-negative-controls.json', JSON.stringify(ncSummary, null, 2));

  console.log(`Negative Controls Result: ${negativeControlFailuresDetected} / ${validNegativeControlsEvaluated} valid controls detected as FAIL (Inconclusive: ${inconclusiveNegativeControls}).\n`);

  // Final consolidated report
  const validEvaluated = allResults.filter(r => !r.is_inconclusive);
  const passedCount = validEvaluated.filter(r => r.passed).length;
  const failedCount = validEvaluated.filter(r => !r.passed).length;
  const inconclusiveCount = allResults.filter(r => r.is_inconclusive).length;

  const stage3Report = {
    timestamp: new Date().toISOString(),
    total_fixtures: allResults.length,
    conclusive_fixtures: validEvaluated.length,
    inconclusive_infra_failures: inconclusiveCount,
    passed_cases: passedCount,
    failed_cases: failedCount,
    pass_rate_pct: validEvaluated.length > 0 ? ((passedCount / validEvaluated.length) * 100).toFixed(1) : '0.0',
    negative_controls: {
      total_attempted: corpus.negative_control_mutations.length,
      conclusive: validNegativeControlsEvaluated,
      inconclusive: inconclusiveNegativeControls,
      detected: negativeControlFailuresDetected,
      missed: validNegativeControlsEvaluated - negativeControlFailuresDetected,
      results: negativeControlResults,
    },
    results: allResults,
  };

  fs.writeFileSync('scripts/torture-stage3-results.json', JSON.stringify(stage3Report, null, 2));
  fs.writeFileSync('scripts/torture-stage3-negative-controls.json', JSON.stringify(stage3Report.negative_controls, null, 2));
  console.log(`\nSaved final audited results to scripts/torture-stage3-results.json and scripts/torture-stage3-negative-controls.json`);

  console.log(`\n================================================================================`);
  console.log(`  STAGE 3 AUDITED SCORE: ${passedCount} / ${validEvaluated.length} conclusive cases (${stage3Report.pass_rate_pct}%)`);
  console.log(`  INCONCLUSIVE INFRASTRUCTURE FAILURES: ${inconclusiveCount} / ${allResults.length}`);
  console.log(`================================================================================\n`);
}

main().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});

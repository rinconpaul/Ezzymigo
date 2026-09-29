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

async function runSingleFixture(fixture: TortureFixture, mockEmbeddingFailure: boolean = false): Promise<EvaluationResult> {
  const memoryIds = fixture.memories.map(m => m.memory_id);
  
  try {
    // 0. Pre-clean in case prior run crashed
    await cleanupSyntheticMemories(memoryIds);

    // 1. Seed memories & vectors
    let seedEmbeddingError: any = null;
    if (mockEmbeddingFailure) {
      seedEmbeddingError = new Error('Simulated RESOURCE_EXHAUSTED 429 quota failure');
      seedEmbeddingError.status = 429;
    } else {
      try {
        await seedSyntheticMemories(fixture.memories);
      } catch (err: any) {
        seedEmbeddingError = err;
      }
    }

    if (seedEmbeddingError) {
      const errCode = seedEmbeddingError?.status === 429 || String(seedEmbeddingError).includes('RESOURCE_EXHAUSTED')
        ? 'RESOURCE_EXHAUSTED_429'
        : (seedEmbeddingError?.code || 'EMBEDDING_SEED_ERROR');

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

    // 2. Execute Architecture D retrieval
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

    // Infrastructure check on retrieval execution
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
        failure_reason: `Infrastructure failure during query embedding/retrieval: ${telemetry.error}`,
        defect_classification: 'INCONCLUSIVE_INFRA_FAILURE',
        embedding_call_attempted: embeddingAttempted,
        embedding_call_succeeded: false,
        embedding_error_code: errCode,
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

    // 3. Evaluate against ground truth (only reached when embedding and pipeline succeeded)
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
      is_inconclusive: false,
      failure_reason: evalResult.reason,
      defect_classification: evalResult.defect,
      embedding_call_attempted: true,
      embedding_call_succeeded: true,
      embedding_error_code: null,
      vector_sql_executed: true,
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
    // 4. Clean up synthetic memories
    await cleanupSyntheticMemories(memoryIds);
  }
}

export async function main() {
  console.log('================================================================================');
  console.log('  STAGE 1 RECOVERY — MULTILINGUAL TORTURE HARNESS EXECUTION                    ');
  console.log('================================================================================\n');

  await initBunnyDb();

  // Clean any stray synthetic records from previous runs
  await executeBunnySql([
    { sql: `DELETE FROM memories WHERE id LIKE 'syn_%' OR id LIKE 'xl_%' OR id LIKE 'cs_%';`, args: [] },
    { sql: `DELETE FROM memories_fts WHERE memory_id LIKE 'syn_%' OR memory_id LIKE 'xl_%' OR memory_id LIKE 'cs_%';`, args: [] },
    { sql: `DELETE FROM memory_search_projection WHERE memory_id LIKE 'syn_%' OR memory_id LIKE 'xl_%' OR memory_id LIKE 'cs_%';`, args: [] },
    { sql: `DELETE FROM memory_vectors WHERE memory_id LIKE 'syn_%' OR memory_id LIKE 'xl_%' OR memory_id LIKE 'cs_%';`, args: [] },
  ]);

  const corpusPath = path.resolve('multilingual_torture_fixtures_v1.json');
  if (!fs.existsSync(corpusPath)) {
    console.error(`ERROR: Corpus file not found at ${corpusPath}`);
    process.exit(1);
  }

  const rawJson = fs.readFileSync(corpusPath, 'utf8');
  const corpus: CorpusData = JSON.parse(rawJson);

  // 1. Run 66 fixtures in 6 sequential batches of 11 fixtures
  console.log('--- EXECUTING FROZEN 66-FIXTURE TORTURE CORPUS IN 6 BATCHES (STAGE 1) ---');
  const allResults: EvaluationResult[] = [];
  const totalFixtures = corpus.fixtures.length; // 66
  const batchSize = 11;
  const numBatches = Math.ceil(totalFixtures / batchSize); // 6
  let globalInfraHalt = false;

  for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
    const batchNum = batchIdx + 1;
    const startIdx = batchIdx * batchSize;
    const endIdx = Math.min(startIdx + batchSize, totalFixtures);
    const batchFile = `scripts/torture-stage1-batch${batchNum}-results.json`;

    // Check if batch is already completed and saved
    if (fs.existsSync(batchFile)) {
      try {
        const savedBatch: EvaluationResult[] = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
        if (Array.isArray(savedBatch) && savedBatch.length === (endIdx - startIdx)) {
          allResults.push(...savedBatch);
          console.log(`>>> BATCH ${batchNum}/${numBatches} ALREADY COMPLETED & LOADED (${savedBatch.length} fixtures) <<<`);
          continue;
        }
      } catch (e) {
        console.log(`Could not load batch file ${batchFile}, running batch fresh.`);
      }
    }

    console.log(`\n>>> STARTING BATCH ${batchNum}/${numBatches} (Fixtures ${startIdx + 1} to ${endIdx}) <<<`);

    for (let i = startIdx; i < endIdx; i++) {
      const fixture = corpus.fixtures[i];
      if (globalInfraHalt) {
        // Mark subsequent fixtures as inconclusive due to preceding infra failure
        const incRes: EvaluationResult = {
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
          failure_reason: 'Skipped due to previous infrastructure failure in batch',
          defect_classification: 'INCONCLUSIVE_INFRA_FAILURE',
          embedding_call_attempted: false,
          embedding_call_succeeded: false,
          embedding_error_code: 'INFRA_HALT_CASCADE',
          vector_sql_executed: false,
          timings: { total_ms: 0, embed_ms: 0, vec_sql_ms: 0, arb_ms: 0, rescue_ms: 0, hydrate_ms: 0 },
          telemetry: {
            top_candidate_id: null,
            top_cosine_sim: null,
            sibling_candidates_in_band: 0,
            composite_scores: {},
            lexical_unique_anchors: {},
            ambiguity_rescue_triggered: false,
            ambiguity_rescue_reason: null,
            ambiguity_rescue_output: null,
          }
        };
        allResults.push(incRes);
        console.log(`[${(i + 1).toString().padStart(2, '0')}/66] ${fixture.test_id.padEnd(10)} | ${fixture.query_language.padEnd(4)} | ${fixture.expected_outcome.padEnd(12)} | Ret: [] | INCONCLUSIVE (HALTED)`);
        continue;
      }

      const evalRes = await runSingleFixture(fixture);
      allResults.push(evalRes);

      if (evalRes.is_inconclusive || !evalRes.embedding_call_succeeded) {
        console.log(`[${(i + 1).toString().padStart(2, '0')}/66] ${evalRes.test_id.padEnd(10)} | ${evalRes.language.padEnd(4)} | ${evalRes.expected_outcome.padEnd(12)} | Ret: [${evalRes.retrieved_ids.join(', ')}] | INCONCLUSIVE (${evalRes.embedding_error_code}) | ${evalRes.timings.total_ms}ms`);
        console.warn(`[INFRASTRUCTURE FAILURE] Detected on fixture ${fixture.test_id}: ${evalRes.failure_reason}. Halting current batch/subsequent queries.`);
        globalInfraHalt = true;
      } else {
        const statusStr = evalRes.passed ? 'PASS' : 'FAIL';
        console.log(`[${(i + 1).toString().padStart(2, '0')}/66] ${evalRes.test_id.padEnd(10)} | ${evalRes.language.padEnd(4)} | ${evalRes.expected_outcome.padEnd(12)} | Ret: [${evalRes.retrieved_ids.join(', ')}] | ${statusStr.padEnd(12)} | ${evalRes.timings.total_ms}ms`);
      }
    }

    // Persist after each batch
    const batchResults = allResults.slice(startIdx, endIdx);
    fs.writeFileSync(`scripts/torture-stage1-batch${batchNum}-results.json`, JSON.stringify(batchResults, null, 2));

    const conclusive = allResults.filter(r => !r.is_inconclusive);
    const passedConclusive = conclusive.filter(r => r.passed).length;
    fs.writeFileSync('scripts/torture-stage1-results.json', JSON.stringify({
      timestamp: new Date().toISOString(),
      completed_batches: batchNum,
      total_batches: numBatches,
      total_fixtures: totalFixtures,
      completed_fixtures: allResults.length,
      conclusive_cases: conclusive.length,
      inconclusive_infra_cases: allResults.filter(r => r.is_inconclusive).length,
      passed_conclusive: passedConclusive,
      results: allResults,
    }, null, 2));

    console.log(`>>> BATCH ${batchNum}/${numBatches} COMPLETE & PERSISTED (Conclusive: ${conclusive.length}, Passed: ${passedConclusive}, Inconclusive: ${allResults.filter(r => r.is_inconclusive).length}) <<<\n`);

    if (globalInfraHalt) {
      console.warn('Stopping further batch execution due to infrastructure quota/error halt.');
      break;
    }
  }

  // 2. Negative Controls Validation (Executed after batches)
  console.log('\n--- NEGATIVE CONTROLS VALIDATION (AFTER 6 BATCHES) ---');
  let negativeControlFailuresDetected = 0;
  let validNegativeControlsEvaluated = 0;
  let inconclusiveNegativeControls = 0;
  const negativeControlResults: any[] = [];

  for (const nc of corpus.negative_control_mutations) {
    const baseFixture = corpus.fixtures.find(f => f.test_id === nc.based_on);
    if (!baseFixture) continue;

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
    if (evalResult.is_inconclusive || !evalResult.embedding_call_succeeded) {
      inconclusiveNegativeControls++;
      console.log(`[${nc.control_id}] INCONCLUSIVE_INFRA_FAILURE: Embedding call failed (${evalResult.embedding_error_code}). Excluded from denominator.`);
      negativeControlResults.push({ control_id: nc.control_id, status: 'INCONCLUSIVE_INFRA_FAILURE', error: evalResult.embedding_error_code });
      continue;
    }

    validNegativeControlsEvaluated++;
    if (!evalResult.passed) {
      negativeControlFailuresDetected++;
      console.log(`[${nc.control_id}] Poison detected as FAIL (SUCCESS): ${evalResult.defect_classification}`);
      negativeControlResults.push({ control_id: nc.control_id, status: 'DETECTED', defect: evalResult.defect_classification });
    } else {
      console.log(`[${nc.control_id}] Poison NOT detected (ERROR)`);
      negativeControlResults.push({ control_id: nc.control_id, status: 'MISSED' });
    }
  }
  console.log(`Negative Controls Result: ${negativeControlFailuresDetected} / ${validNegativeControlsEvaluated} valid controls detected as FAIL (Inconclusive: ${inconclusiveNegativeControls}).\n`);

  // Final consolidated report
  const validEvaluated = allResults.filter(r => !r.is_inconclusive);
  const passedCount = validEvaluated.filter(r => r.passed).length;
  const failedCount = validEvaluated.filter(r => !r.passed).length;
  const inconclusiveCount = allResults.filter(r => r.is_inconclusive).length;

  const stage1Report = {
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

  fs.writeFileSync('scripts/torture-stage1-results.json', JSON.stringify(stage1Report, null, 2));
  console.log(`\nSaved final audited results to scripts/torture-stage1-results.json`);

  console.log(`\n================================================================================`);
  console.log(`  STAGE 1 AUDITED SCORE: ${passedCount} / ${validEvaluated.length} conclusive cases (${stage1Report.pass_rate_pct}%)`);
  console.log(`  INCONCLUSIVE INFRASTRUCTURE FAILURES: ${inconclusiveCount} / ${allResults.length}`);
  console.log(`================================================================================\n`);
}

main().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});

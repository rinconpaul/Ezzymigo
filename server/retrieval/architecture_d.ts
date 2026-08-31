import { executeBunnySql } from '../db/client';
import { getGeminiClient } from '../config/gemini';
import { normalizeSubject } from '../db/search_sync';
import { generateEmbedding, searchMemoryVectors, buildMemoryDocumentString } from './vector_service';
import { segmentUnicodeWords, extractUniqueDiscriminativeTokens, detectScript } from './unicode_segmenter';
import { retrieveStageAExactSubject } from './native_search';

// Provisional shadow parameters (subject to shadow validation)
export const PROVISIONAL_ADMITTANCE_SIMILARITY = 0.65;
export const PROVISIONAL_DISTRACTOR_DROP_SIMILARITY = 0.55;
export const PROVISIONAL_SIBLING_BAND_SIMILARITY = 0.60;
export const PROVISIONAL_LEXICAL_WEIGHT = 0.05;

export interface ArchitectureDTelemetry {
  query: string;
  query_language_script: string;
  timestamp: string;
  route_taken: 'exact_subject' | 'vector_unambiguous' | 'vector_lexical_sibling' | 'ambiguity_rescue' | 'zero_result';
  top_candidate_id: string | null;
  top_cosine_similarity: number | null;
  top_cosine_distance: number | null;
  sibling_candidates_in_band: number;
  lexical_unique_anchors: Record<string, string[]>;
  composite_scores: Record<string, number>;
  ambiguity_rescue_triggered: boolean;
  ambiguity_rescue_reason: string | null;
  ambiguity_rescue_output: any | null;
  timings: {
    embedding_api_ms: number;
    vector_sql_ms: number;
    exact_and_fts_sql_ms: number;
    arbitration_ms: number;
    ambiguity_rescue_ms: number;
    hydration_ms: number;
    total_architecture_d_ms: number;
  };
  legacy_ids: string[];
  architecture_d_ids: string[];
  intersection_ids: string[];
  legacy_only_ids: string[];
  architecture_d_only_ids: string[];
  error?: string;
}

export interface ArchitectureDResult {
  candidateMemories: any[]; // Strictly empty [] in shadow mode to prevent prompt leakage
  shadowTelemetry: ArchitectureDTelemetry;
  debugCandidates: any[]; // Available for testing/evaluation
}

/**
 * Stage C Ambiguity Rescue for borderline or contradictory sibling cases.
 * Bounded to maximum 2-3 candidate memories.
 */
async function executeStageCAmbiguityRescue(
  question: string,
  candidates: Array<{ id: string; text: string; cosine_sim: number; unique_anchors: string[] }>
): Promise<{ winningId: string | null; isAmbiguous: boolean; reason: string }> {
  const ai = getGeminiClient();
  if (!ai || candidates.length === 0) {
    return { winningId: candidates[0]?.id || null, isAmbiguous: false, reason: 'Gemini client unavailable' };
  }

  const prompt = `You are a memory disambiguation assistant.
The user asked: "${question}"

Here are the closely competing candidate memories:
${candidates.map((c, i) => `Candidate ${i + 1} (ID: ${c.id}): "${c.text}" (Cosine Similarity: ${c.cosine_sim.toFixed(4)}, Unique Anchors: [${c.unique_anchors.join(', ')}])`).join('\n')}

Determine whether the user's question clearly refers to one specific candidate, or if the question is genuinely ambiguous.
Rules:
1. If one candidate clearly answers the specific entity, topic, or context asked about, return its exact ID as "winning_memory_id" and set "is_ambiguous" to false.
2. If the user's question is genuinely ambiguous (could equally apply to multiple candidates without additional context), set "winning_memory_id" to null and "is_ambiguous" to true.

Respond ONLY with valid JSON:
{
  "winning_memory_id": "string or null",
  "is_ambiguous": boolean,
  "reason": "short explanation"
}`;

  try {
    const res = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse(res.text?.trim() || '{}');
    return {
      winningId: parsed.winning_memory_id || null,
      isAmbiguous: Boolean(parsed.is_ambiguous),
      reason: parsed.reason || 'Completed',
    };
  } catch (err: any) {
    return {
      winningId: candidates[0]?.id || null,
      isAmbiguous: true,
      reason: `Ambiguity rescue error: ${err?.message || String(err)}`,
    };
  }
}

/**
 * Phase 2 — Architecture D Shadow Retrieval Engine.
 * Executes multilingual vector search, exact subject lookup, and Unicode lexical sibling arbitration.
 */
export async function executeArchitectureDRetrieval(options: {
  question: string;
  nowIso: string;
  activeRoleLabels?: string[];
  legacyCandidateIds?: string[];
  targetStatus?: 'active' | 'done' | 'all';
}): Promise<ArchitectureDResult> {
  const { question, nowIso, activeRoleLabels = [], legacyCandidateIds = [], targetStatus = 'active' } = options;
  const startTotal = Date.now();
  const scriptType = detectScript(question);
  const queryTokens = segmentUnicodeWords(question);

  const telemetry: ArchitectureDTelemetry = {
    query: question,
    query_language_script: scriptType,
    timestamp: new Date().toISOString(),
    route_taken: 'zero_result',
    top_candidate_id: null,
    top_cosine_similarity: null,
    top_cosine_distance: null,
    sibling_candidates_in_band: 0,
    lexical_unique_anchors: {},
    composite_scores: {},
    ambiguity_rescue_triggered: false,
    ambiguity_rescue_reason: null,
    ambiguity_rescue_output: null,
    timings: {
      embedding_api_ms: 0,
      vector_sql_ms: 0,
      exact_and_fts_sql_ms: 0,
      arbitration_ms: 0,
      ambiguity_rescue_ms: 0,
      hydration_ms: 0,
      total_architecture_d_ms: 0,
    },
    legacy_ids: [...legacyCandidateIds],
    architecture_d_ids: [],
    intersection_ids: [],
    legacy_only_ids: [],
    architecture_d_only_ids: [],
  };

  let selectedCandidateIds: string[] = [];
  let hydratedMemories: any[] = [];

  try {
    // -------------------------------------------------------------
    // STEP 1: PARALLEL DISPATCH (Vector Search + Exact Subject / FTS5)
    // -------------------------------------------------------------
    const vectorSearchPromise = (async () => {
      const { vector, latencyMs: embedMs } = await generateEmbedding(question, 'RETRIEVAL_QUERY');
      telemetry.timings.embedding_api_ms = embedMs;
      const { results, latencyMs: vecSqlMs } = await searchMemoryVectors(vector, 20);
      telemetry.timings.vector_sql_ms = vecSqlMs;
      return results;
    })();

    const exactAndFtsPromise = (async () => {
      const startSql = Date.now();
      // 1. Exact Subject Check
      const exactSubjectIds = await retrieveStageAExactSubject(question, targetStatus);

      // 2. FTS5 exact token check (for quick lexical verification)
      let ftsIds: string[] = [];
      const cleanFtsQuery = queryTokens
        .filter(t => t.length >= 2)
        .map(t => `"${t.replace(/"/g, '')}"*`)
        .join(' OR ');

      if (cleanFtsQuery) {
        try {
          const ftsRes = await executeBunnySql([
            {
              sql: `SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? LIMIT 15;`,
              args: [cleanFtsQuery],
            },
          ]);
          ftsIds = (ftsRes[0]?.rows || []).map((r: any) => r.memory_id);
        } catch {
          // FTS match syntax safety
        }
      }

      const sqlLatency = Date.now() - startSql;
      telemetry.timings.exact_and_fts_sql_ms = sqlLatency;
      return { exactSubjectIds, ftsIds };
    })();

    const [vectorResults, exactAndFts] = await Promise.all([
      vectorSearchPromise,
      exactAndFtsPromise,
    ]);

    const { exactSubjectIds } = exactAndFts;

    // -------------------------------------------------------------
    // STEP 2: MULTI-SIGNAL ARBITRATION
    // -------------------------------------------------------------
    const startArb = Date.now();

    if (vectorResults.length > 0) {
      telemetry.top_candidate_id = vectorResults[0].memory_id;
      telemetry.top_cosine_similarity = vectorResults[0].cosine_similarity;
      telemetry.top_cosine_distance = vectorResults[0].cosine_distance;
    }

    const topSim = vectorResults[0]?.cosine_similarity ?? 0;

    // Condition 1: Exact Subject Match (e.g. "What's in Mum's sold items?")
    if (exactSubjectIds.length > 0) {
      telemetry.route_taken = 'exact_subject';
      selectedCandidateIds = [...exactSubjectIds];
    }
    // Condition 2: Distractor / Zero Result Drop
    else if (topSim < PROVISIONAL_DISTRACTOR_DROP_SIMILARITY) {
      telemetry.route_taken = 'zero_result';
      selectedCandidateIds = [];
    }
    // Condition 3: Vector Semantic Retrieval with Sibling Disambiguation
    else {
      // Find all candidates in the Sibling Band (Similarity >= 0.60)
      const bandCandidates = vectorResults.filter(
        r => r.cosine_similarity >= PROVISIONAL_SIBLING_BAND_SIMILARITY
      );
      telemetry.sibling_candidates_in_band = bandCandidates.length;

      if (bandCandidates.length === 1 && topSim >= PROVISIONAL_ADMITTANCE_SIMILARITY) {
        // Solo winner with strong similarity
        telemetry.route_taken = 'vector_unambiguous';
        selectedCandidateIds = [bandCandidates[0].memory_id];
        telemetry.composite_scores[bandCandidates[0].memory_id] = bandCandidates[0].cosine_similarity;
      } else if (bandCandidates.length >= 2) {
        // Multi-candidate sibling pool: Fetch document texts for lexical anchoring
        const bandIds = bandCandidates.map(c => c.memory_id);
        const placeholders = bandIds.map(() => '?').join(',');
        const docRowsRes = await executeBunnySql([
          {
            sql: `SELECT * FROM memories WHERE id IN (${placeholders});`,
            args: bandIds,
          },
        ]);
        const docRows = docRowsRes[0]?.rows || [];
        const docMap = new Map(docRows.map((r: any) => [r.id, r]));

        const candidateDocList = bandCandidates.map(c => {
          const row = docMap.get(c.memory_id) || { id: c.memory_id, content: '' };
          return {
            id: c.memory_id,
            text: buildMemoryDocumentString(row),
            cosine_sim: c.cosine_similarity,
          };
        });

        // Compute unique discriminative lexical tokens
        const lexicalResults = extractUniqueDiscriminativeTokens(queryTokens, candidateDocList);

        // Compute Composite Scores
        const scoredPool = candidateDocList.map(cand => {
          const lexInfo = lexicalResults.get(cand.id);
          const uniqueTokens = lexInfo?.uniqueTokens || [];
          const matchedTokens = lexInfo?.matchedTokens || [];
          telemetry.lexical_unique_anchors[cand.id] = uniqueTokens;

          const uCount = uniqueTokens.length;
          const composite = cand.cosine_sim + (PROVISIONAL_LEXICAL_WEIGHT * uCount);
          telemetry.composite_scores[cand.id] = composite;

          return {
            id: cand.id,
            text: cand.text,
            cosine_sim: cand.cosine_sim,
            unique_anchors: uniqueTokens,
            matched_anchors: matchedTokens,
            composite_score: composite,
          };
        });

        // Sort by Composite Score descending
        scoredPool.sort((a, b) => b.composite_score - a.composite_score);

        const top1 = scoredPool[0];
        const top2 = scoredPool[1];
        const deltaVector = top1.cosine_sim - top2.cosine_sim;
        const deltaComposite = top1.composite_score - top2.composite_score;

        // Check if Stage C Ambiguity Rescue is required
        let needsRescue = false;
        let rescueReason = '';

        // Case 3: Zero unique lexical anchors in both and weak vector separation
        if (top1.unique_anchors.length === 0 && top2.unique_anchors.length === 0 && deltaVector < 0.05) {
          needsRescue = true;
          rescueReason = 'ZERO_UNIQUE_ANCHORS_AND_WEAK_VECTOR_SEPARATION';
        }
        // Case 4: Contradictory Signals (Vector winner has lower lexical score vs competitor with strong lexical)
        else if (top2.cosine_sim > top1.cosine_sim && top1.unique_anchors.length > top2.unique_anchors.length) {
          needsRescue = true;
          rescueReason = 'CONTRADICTORY_VECTOR_AND_LEXICAL_WINNERS';
        }
        // Case 1: Exact tie on both vector and lexical
        else if (Math.abs(deltaVector) < 0.01 && top1.unique_anchors.length === top2.unique_anchors.length) {
          needsRescue = true;
          rescueReason = 'EXACT_VECTOR_AND_LEXICAL_TIE';
        }

        if (needsRescue) {
          telemetry.ambiguity_rescue_triggered = true;
          telemetry.ambiguity_rescue_reason = rescueReason;
          const startRescue = Date.now();

          const rescueResult = await executeStageCAmbiguityRescue(
            question,
            scoredPool.slice(0, 3)
          );
          telemetry.timings.ambiguity_rescue_ms = Date.now() - startRescue;
          telemetry.ambiguity_rescue_output = rescueResult;
          telemetry.route_taken = 'ambiguity_rescue';

          if (rescueResult.isAmbiguous || !rescueResult.winningId) {
            // Safe ambiguous state: retain top tied siblings (does not arbitrarily force a single memory)
            selectedCandidateIds = [top1.id, top2.id];
          } else {
            selectedCandidateIds = [rescueResult.winningId];
          }
        } else {
          // Unambiguous winner via vector + lexical composite score
          telemetry.route_taken = 'vector_lexical_sibling';
          if (top1.composite_score >= PROVISIONAL_ADMITTANCE_SIMILARITY) {
            selectedCandidateIds = [top1.id];
          } else {
            selectedCandidateIds = [];
            telemetry.route_taken = 'zero_result';
          }
        }
      } else {
        telemetry.route_taken = 'zero_result';
        selectedCandidateIds = [];
      }
    }

    telemetry.timings.arbitration_ms = Date.now() - startArb;
    telemetry.architecture_d_ids = [...selectedCandidateIds];

    // -------------------------------------------------------------
    // STEP 3: DATABASE HYDRATION & STATUS ISOLATION
    // -------------------------------------------------------------
    const startHydrate = Date.now();
    if (selectedCandidateIds.length > 0) {
      const placeholders = selectedCandidateIds.map(() => '?').join(',');
      const rowsRes = await executeBunnySql([
        {
          sql: `SELECT * FROM memories WHERE id IN (${placeholders}) AND status = ? AND isDone = 0;`,
          args: [...selectedCandidateIds, targetStatus],
        },
      ]);
      const rows = rowsRes[0]?.rows || [];
      const rowMap = new Map(rows.map((r: any) => [r.id, r]));

      const validHydratedIds: string[] = [];
      for (const id of selectedCandidateIds) {
        const item = rowMap.get(id);
        if (item) {
          hydratedMemories.push(item);
          validHydratedIds.push(id);
        }
      }
      selectedCandidateIds = validHydratedIds;
    }
    telemetry.timings.hydration_ms = Date.now() - startHydrate;
    telemetry.architecture_d_ids = [...selectedCandidateIds];

    // -------------------------------------------------------------
    // DISCREPANCY & INTERSECTION METRICS
    // -------------------------------------------------------------
    const nativeSet = new Set(telemetry.architecture_d_ids);
    const legacySet = new Set(telemetry.legacy_ids);

    telemetry.intersection_ids = telemetry.legacy_ids.filter(id => nativeSet.has(id));
    telemetry.legacy_only_ids = telemetry.legacy_ids.filter(id => !nativeSet.has(id));
    telemetry.architecture_d_only_ids = telemetry.architecture_d_ids.filter(id => !legacySet.has(id));

  } catch (err: any) {
    telemetry.error = err?.message || String(err);
    console.error('[Architecture D Shadow Error]:', err);
  } finally {
    telemetry.timings.total_architecture_d_ms = Date.now() - startTotal;
  }

  return {
    candidateMemories: [], // SHADOW MODE: Returns empty array to ensure ZERO leakage into user-facing prompt
    shadowTelemetry: telemetry,
    debugCandidates: hydratedMemories,
  };
}

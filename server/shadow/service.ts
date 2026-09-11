import { executeBunnySql } from '../db/client';
import { initBunnyDb } from '../db/schema';
import { DEFAULT_EZZY_ID } from '../instances/entitlements';
import { assembleEzzyWorldSnapshot, AssembleSnapshotOptions } from '../snapshot/assembler';
import { executeNewEzzyReasoningLoop } from '../reasoning/loop';
import {
  ThinkingOpportunity,
  ShadowEvaluationRecord,
  FeedbackVerdict,
} from '../snapshot/types';
import {
  getLatestActiveAttentionChannel,
  runUnifiedAttentionReview,
} from '../attention/service';
import { ShadowAttentionReviewRecord } from '../attention/types';
import { registerInvalidationListener } from '../attention/freshness';

// In-memory cache for ultra-fast Today retrieval (<5ms)
const todayOrientCache = new Map<string, ShadowEvaluationRecord>();
const nonTodayCache = new Map<string, ShadowEvaluationRecord>();
const inFlightEvaluations = new Map<string, Promise<ShadowEvaluationRecord>>();

// Register cache invalidator upon mutations or phase transitions
registerInvalidationListener((eid: string) => {
  todayOrientCache.delete(eid);
  nonTodayCache.delete(eid);
  console.log(`[Shadow Service] Flushed evaluation caches for ${eid}`);
});

export interface TriggerShadowEvaluationOptions {
  ezzyId?: string;
  opportunity?: ThinkingOpportunity;
  trigger?: string;
  clientNow?: string;
  clientTimeZone?: string;
  clientLanguage?: string;
  clientRegion?: string;
  input?: string;
  targetEventId?: string;
}

function parseShadowRow(row: any): ShadowEvaluationRecord {
  return {
    id: row.id,
    ezzy_id: row.ezzy_id,
    timestamp: row.timestamp,
    opportunity: row.opportunity as ThinkingOpportunity,
    trigger_name: row.trigger_name,
    old_ezzy_outcome: row.old_ezzy_outcome ? JSON.parse(row.old_ezzy_outcome) : null,
    new_ezzy_decision: JSON.parse(row.new_ezzy_decision),
    new_ezzy_rationale: row.new_ezzy_rationale || '',
    cited_memory_ids: row.cited_memory_ids ? JSON.parse(row.cited_memory_ids) : [],
    cited_calendar_ids: row.cited_calendar_ids ? JSON.parse(row.cited_calendar_ids) : [],
    model_name: row.model_name,
    latency_ms: Number(row.latency_ms || 0),
    prompt_tokens: Number(row.prompt_tokens || 0),
    output_tokens: Number(row.output_tokens || 0),
    verdict: (row.verdict as FeedbackVerdict) || null,
    verdict_comment: row.verdict_comment || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getLatestTodayEvaluation(
  ezzyId?: string
): Promise<ShadowEvaluationRecord | null> {
  const eid = (ezzyId || DEFAULT_EZZY_ID).trim();
  const cached = todayOrientCache.get(eid);
  if (cached) {
    return cached;
  }

  await initBunnyDb();
  try {
    const res = await executeBunnySql([
      {
        sql: `SELECT id, ezzy_id, timestamp, opportunity, trigger_name, old_ezzy_outcome, new_ezzy_decision, new_ezzy_rationale, cited_memory_ids, cited_calendar_ids, model_name, latency_ms, prompt_tokens, output_tokens, verdict, verdict_comment, created_at, updated_at
              FROM shadow_evaluations
              WHERE ezzy_id = ? AND opportunity = 'TODAY_ORIENT'
              ORDER BY timestamp DESC
              LIMIT 1;`,
        args: [eid],
      },
    ]);

    const row = res[0]?.rows?.[0];
    if (!row) return null;

    const record = parseShadowRow(row);
    todayOrientCache.set(eid, record);
    return record;
  } catch (err) {
    console.error('[Shadow Service] Error fetching latest today evaluation:', err);
    return null;
  }
}

export async function getLatestCheckInEvaluation(
  ezzyId?: string
): Promise<ShadowEvaluationRecord | null> {
  const eid = (ezzyId || DEFAULT_EZZY_ID).trim();
  const cached = nonTodayCache.get(eid);
  if (cached) {
    const dec = cached.new_ezzy_decision;
    if (dec?.communication.mode !== 'SILENT' && (dec?.communication.question || dec?.communication.headline)) {
      return cached;
    }
    return null;
  }

  await initBunnyDb();
  try {
    const res = await executeBunnySql([
      {
        sql: `SELECT id, ezzy_id, timestamp, opportunity, trigger_name, old_ezzy_outcome, new_ezzy_decision, new_ezzy_rationale, cited_memory_ids, cited_calendar_ids, model_name, latency_ms, prompt_tokens, output_tokens, verdict, verdict_comment, created_at, updated_at
              FROM shadow_evaluations
              WHERE ezzy_id = ? AND opportunity != 'TODAY_ORIENT'
              ORDER BY timestamp DESC
              LIMIT 1;`,
        args: [eid],
      },
    ]);

    const row = res[0]?.rows?.[0];
    if (!row) return null;

    const record = parseShadowRow(row);
    nonTodayCache.set(eid, record);
    const dec = record.new_ezzy_decision;
    if (dec?.communication.mode !== 'SILENT' && (dec?.communication.question || dec?.communication.headline)) {
      return record;
    }
    return null;
  } catch (err) {
    console.error('[Shadow Service] Error fetching latest check-in evaluation:', err);
    return null;
  }
}

export async function getRecentShadowEvaluations(
  ezzyId?: string,
  limit: number = 6
): Promise<ShadowEvaluationRecord[]> {
  const eid = (ezzyId || DEFAULT_EZZY_ID).trim();
  await initBunnyDb();
  try {
    const res = await executeBunnySql([
      {
        sql: `SELECT id, ezzy_id, timestamp, opportunity, trigger_name, old_ezzy_outcome, new_ezzy_decision, new_ezzy_rationale, cited_memory_ids, cited_calendar_ids, model_name, latency_ms, prompt_tokens, output_tokens, verdict, verdict_comment, created_at, updated_at
              FROM shadow_evaluations
              WHERE ezzy_id = ?
              ORDER BY timestamp DESC
              LIMIT ?;`,
        args: [eid, limit],
      },
    ]);
    const rows = res[0]?.rows || [];
    return rows.map(parseShadowRow);
  } catch (err) {
    console.error('[Shadow Service] Error fetching recent shadow evaluations:', err);
    return [];
  }
}

export interface ShadowDisplayState {
  todayEvaluation: ShadowEvaluationRecord | null;
  checkInEvaluation: ShadowEvaluationRecord | null;
  recentEvaluations: ShadowEvaluationRecord[];
  attentionReview: ShadowAttentionReviewRecord | null;
}

export async function getShadowDisplayState(
  ezzyId?: string
): Promise<ShadowDisplayState> {
  const [todayEvaluation, checkInEvaluation, recentEvaluations, attentionReview] = await Promise.all([
    getLatestTodayEvaluation(ezzyId),
    getLatestCheckInEvaluation(ezzyId),
    getRecentShadowEvaluations(ezzyId, 6),
    getLatestActiveAttentionChannel(ezzyId),
  ]);
  return { todayEvaluation, checkInEvaluation, recentEvaluations, attentionReview };
}

export async function getLatestShadowEvaluation(
  ezzyId?: string
): Promise<ShadowEvaluationRecord | null> {
  return getLatestTodayEvaluation(ezzyId);
}

export async function evaluateShadowOpportunity(
  options: TriggerShadowEvaluationOptions
): Promise<ShadowEvaluationRecord> {
  const eid = (options.ezzyId || DEFAULT_EZZY_ID).trim();
  const opportunity = options.opportunity || 'TODAY_ORIENT';
  const trigger = options.trigger || 'manual_or_lifecycle';
  const flightKey = `${eid}_${opportunity}`;

  // Coalesce duplicate in-flight requests for the same opportunity
  const existingFlight = inFlightEvaluations.get(flightKey);
  if (existingFlight) {
    return existingFlight;
  }

  const evaluationPromise = (async () => {
    try {
      await initBunnyDb();

      // 1. Assemble bounded real Personal World snapshot
      const snapshot = await assembleEzzyWorldSnapshot({
        ezzyId: eid,
        clientNow: options.clientNow,
        clientTimeZone: options.clientTimeZone,
        clientLanguage: options.clientLanguage,
        clientRegion: options.clientRegion,
        opportunity,
        trigger,
        input: options.input,
      });

      // Old Ezzy comparison is decommissioned. New Ezzy is the sole behavioural engine.
      const oldEzzyOutcome: any = null;

      // 2. Execute New Ezzy Unified Reasoning Loop (isolated, cannot mutate database)
      const reasoningResult = await executeNewEzzyReasoningLoop(
        opportunity,
        snapshot,
        {
          input: options.input,
          trigger,
          targetEventId: options.targetEventId,
        }
      );

      const evaluationId = `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const nowIso = new Date().toISOString();

      const record: ShadowEvaluationRecord = {
        id: evaluationId,
        ezzy_id: eid,
        timestamp: nowIso,
        opportunity,
        trigger_name: trigger,
        old_ezzy_outcome: oldEzzyOutcome,
        new_ezzy_decision: reasoningResult.decision,
        new_ezzy_rationale: reasoningResult.decision.rationale,
        cited_memory_ids: reasoningResult.decision.citedMemoryIds,
        cited_calendar_ids: reasoningResult.decision.citedCalendarIds,
        model_name: reasoningResult.modelName,
        latency_ms: reasoningResult.latencyMs,
        prompt_tokens: reasoningResult.promptTokens,
        output_tokens: reasoningResult.outputTokens,
        verdict: null,
        verdict_comment: null,
        created_at: nowIso,
        updated_at: nowIso,
      };

      // 4. Persist to shadow_evaluations table (ONLY write permitted for New Ezzy)
      await executeBunnySql([
        {
          sql: `INSERT INTO shadow_evaluations (
            id, ezzy_id, timestamp, opportunity, trigger_name,
            old_ezzy_outcome, new_ezzy_decision, new_ezzy_rationale,
            cited_memory_ids, cited_calendar_ids, model_name,
            latency_ms, prompt_tokens, output_tokens,
            verdict, verdict_comment, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          args: [
            record.id,
            record.ezzy_id,
            record.timestamp,
            record.opportunity,
            record.trigger_name,
            JSON.stringify(record.old_ezzy_outcome),
            JSON.stringify(record.new_ezzy_decision),
            record.new_ezzy_rationale,
            JSON.stringify(record.cited_memory_ids),
            JSON.stringify(record.cited_calendar_ids),
            record.model_name,
            record.latency_ms,
            record.prompt_tokens,
            record.output_tokens,
            null,
            null,
            record.created_at,
            record.updated_at,
          ],
        },
      ]);

      // 5. Update in-memory opportunity cache
      if (opportunity === 'TODAY_ORIENT') {
        todayOrientCache.set(eid, record);
      } else {
        nonTodayCache.set(eid, record);
      }

      console.log(
        `[Shadow Service] Evaluated ${opportunity} (${record.latency_ms}ms) -> Mode: ${record.new_ezzy_decision.communication.mode} | Headline: "${record.new_ezzy_decision.communication.headline || 'N/A'}"`
      );

      // Event-driven: whenever a new candidate evaluation is produced, re-run executive attention review
      runUnifiedAttentionReview(
        eid,
        `opportunity_${opportunity}`,
        options.clientNow,
        options.clientTimeZone
      ).catch((revErr) => {
        console.warn('[Shadow Service] Background Attention Review after opportunity failed:', revErr);
      });

      return record;
    } finally {
      inFlightEvaluations.delete(flightKey);
    }
  })();

  inFlightEvaluations.set(flightKey, evaluationPromise);
  return evaluationPromise;
}

export async function recordShadowFeedback(
  evaluationId: string,
  verdict: FeedbackVerdict,
  comment?: string | null,
  ezzyId?: string
): Promise<boolean> {
  const eid = (ezzyId || DEFAULT_EZZY_ID).trim();
  await initBunnyDb();

  const nowIso = new Date().toISOString();
  try {
    const res = await executeBunnySql([
      {
        sql: `UPDATE shadow_evaluations
              SET verdict = ?, verdict_comment = ?, updated_at = ?
              WHERE id = ? AND ezzy_id = ?;`,
        args: [verdict, comment || null, nowIso, evaluationId, eid],
      },
    ]);

    // Update in-memory caches if matched
    const todayCached = todayOrientCache.get(eid);
    if (todayCached && todayCached.id === evaluationId) {
      todayCached.verdict = verdict;
      todayCached.verdict_comment = comment || null;
      todayCached.updated_at = nowIso;
    }
    const nonTodayCached = nonTodayCache.get(eid);
    if (nonTodayCached && nonTodayCached.id === evaluationId) {
      nonTodayCached.verdict = verdict;
      nonTodayCached.verdict_comment = comment || null;
      nonTodayCached.updated_at = nowIso;
    }

    return (res[0]?.affected_rows || 0) > 0;
  } catch (err) {
    console.error('[Shadow Service] Error recording feedback:', err);
    return false;
  }
}

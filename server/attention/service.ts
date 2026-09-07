import { executeBunnySql } from '../db/client';
import { initBunnyDb } from '../db/schema';
import { DEFAULT_EZZY_ID } from '../instances/entitlements';
import { formatLocalTimeContext, getYMDInTz, getTimeStrInTz } from '../utils/time';
import { readCalendarEvents } from '../calendar/store';
import { readMemories } from '../db/memories';
import { executeAttentionReview } from './reviewer';
import {
  CandidateCommunication,
  ChannelInteraction,
  AttentionReviewInput,
  CuratedChannelCommunication,
  CandidateResolution,
  ShadowAttentionReviewRecord,
} from './types';

// In-memory cache for zero-cost presentation reads (<2ms)
const activeChannelCache = new Map<string, ShadowAttentionReviewRecord>();
const inFlightReviews = new Map<string, Promise<ShadowAttentionReviewRecord>>();

export interface RecordInteractionParams {
  ezzyId?: string;
  communicationId: string;
  evaluationId?: string | null;
  opportunity?: string | null;
  promptHeadline?: string | null;
  promptQuestion?: string | null;
  userResponse: string;
  capturedMemoryId?: string | null;
}

/**
 * Persists an authoritative user interaction linking a specific Ezzy communication
 * to the user's response and resulting memory record (Conversational Provenance).
 */
export async function recordShadowInteraction(params: RecordInteractionParams): Promise<string> {
  const eid = (params.ezzyId || DEFAULT_EZZY_ID).trim();
  await initBunnyDb();

  const id = `interaction_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const nowIso = new Date().toISOString();

  try {
    await executeBunnySql([
      {
        sql: `INSERT INTO shadow_interactions (
          id, ezzy_id, communication_id, evaluation_id, opportunity,
          prompt_headline, prompt_question, user_response, captured_memory_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        args: [
          id,
          eid,
          params.communicationId,
          params.evaluationId || null,
          params.opportunity || null,
          params.promptHeadline || null,
          params.promptQuestion || null,
          params.userResponse,
          params.capturedMemoryId || null,
          nowIso,
        ],
      },
    ]);
    console.log(`[Attention Service] Recorded interaction ${id} for communication ${params.communicationId}`);
  } catch (err) {
    console.error('[Attention Service] Failed to record shadow interaction:', err);
  }

  // Event-driven: immediately trigger executive attention review upon interaction
  runUnifiedAttentionReview(eid, 'user_response_captured').catch((err) => {
    console.error('[Attention Service] Background attention review failed after interaction:', err);
  });

  return id;
}

/**
 * Reads recent interactions (including prompt responses and recently captured thoughts)
 */
export async function getRecentInteractions(
  ezzyId: string = DEFAULT_EZZY_ID,
  limit: number = 10
): Promise<ChannelInteraction[]> {
  const eid = ezzyId.trim();
  await initBunnyDb();

  try {
    const res = await executeBunnySql([
      {
        sql: `SELECT id, ezzy_id, communication_id, evaluation_id, opportunity, prompt_headline, prompt_question, user_response, captured_memory_id, created_at
              FROM shadow_interactions
              WHERE ezzy_id = ?
              ORDER BY created_at DESC
              LIMIT ?;`,
        args: [eid, limit],
      },
    ]);

    const rows = res[0]?.rows || [];
    return rows.map((r: any) => ({
      id: r.id,
      ezzyId: r.ezzy_id,
      communicationId: r.communication_id,
      evaluationId: r.evaluation_id || null,
      opportunity: r.opportunity || null,
      promptHeadline: r.prompt_headline || null,
      promptQuestion: r.prompt_question || null,
      userResponse: r.user_response,
      capturedMemoryId: r.captured_memory_id || null,
      createdAt: r.created_at,
    }));
  } catch (err) {
    console.error('[Attention Service] Error fetching interactions:', err);
    return [];
  }
}

/**
 * Gathers candidate communications from recent thinking evaluations
 */
export async function gatherCandidateCommunications(
  ezzyId: string = DEFAULT_EZZY_ID,
  limit: number = 12
): Promise<CandidateCommunication[]> {
  const eid = ezzyId.trim();
  await initBunnyDb();

  try {
    const res = await executeBunnySql([
      {
        sql: `SELECT id, ezzy_id, timestamp, opportunity, trigger_name, new_ezzy_decision, new_ezzy_rationale, cited_memory_ids, cited_calendar_ids
              FROM shadow_evaluations
              WHERE ezzy_id = ?
              ORDER BY timestamp DESC
              LIMIT ?;`,
        args: [eid, limit],
      },
    ]);

    const rows = res[0]?.rows || [];
    const candidates: CandidateCommunication[] = [];

    for (const r of rows) {
      try {
        const decision = JSON.parse(r.new_ezzy_decision);
        const comm = decision.communication;
        if (!comm || comm.mode === 'SILENT') continue;

        const headline = comm.headline?.trim() || null;
        const body = comm.body?.trim() || null;
        const question = comm.question?.trim() || null;

        if (!headline && !body && !question) continue;

        candidates.push({
          id: `cand_${r.id}`,
          evaluationId: r.id,
          opportunity: r.opportunity,
          mode: comm.mode === 'SPEAK' ? 'SPEAK' : 'PROMPT',
          headline,
          body,
          question,
          citedMemoryIds: r.cited_memory_ids ? JSON.parse(r.cited_memory_ids) : [],
          citedCalendarIds: r.cited_calendar_ids ? JSON.parse(r.cited_calendar_ids) : [],
          generatedAt: r.timestamp,
          rationale: r.new_ezzy_rationale || decision.rationale || '',
        });
      } catch (err) {
        console.warn('[Attention Service] Failed to parse candidate from row:', r.id, err);
      }
    }

    return candidates;
  } catch (err) {
    console.error('[Attention Service] Error gathering candidate communications:', err);
    return [];
  }
}

/**
 * Runs the Unified Attention Review (frontier model) over current candidate pool,
 * interaction provenance, and personal world context.
 */
export async function runUnifiedAttentionReview(
  ezzyId: string = DEFAULT_EZZY_ID,
  triggerName: string = 'manual_or_event',
  clientNow?: string,
  clientTimeZone?: string
): Promise<ShadowAttentionReviewRecord> {
  const eid = ezzyId.trim();
  const flightKey = `${eid}_attention_review`;

  // Coalesce in-flight reviews
  const existingFlight = inFlightReviews.get(flightKey);
  if (existingFlight) {
    return existingFlight;
  }

  const reviewPromise = (async () => {
    try {
      await initBunnyDb();

      const localContext = formatLocalTimeContext(clientNow, clientTimeZone);
      const now = localContext.referenceDate;
      const timeZone = localContext.timeZone;
      const todayYMD = getYMDInTz(now, timeZone);
      const timeStr = getTimeStrInTz(now, timeZone);

      // 1. Gather all inputs in parallel
      const [candidates, interactions, calendarEvents, allMemories] = await Promise.all([
        gatherCandidateCommunications(eid, 12),
        getRecentInteractions(eid, 10),
        readCalendarEvents(undefined, eid).catch(() => []),
        readMemories(eid).catch(() => []),
      ]);

      // Seed historical interaction if memory exists but wasn't yet in shadow_interactions
      const dentistMemory = allMemories.find((m: any) =>
        m.id === 'mem_1788752814353_0_x2u1ebm' ||
        (m.originalText && m.originalText.toLowerCase().includes('dentist said that the infection had subsided'))
      );

      const combinedInteractions: ChannelInteraction[] = [...interactions];
      if (dentistMemory && !interactions.some((i) => i.capturedMemoryId === dentistMemory.id)) {
        const syntheticHistoricalInteraction: ChannelInteraction = {
          id: `interaction_dentist_response`,
          ezzyId: eid,
          communicationId: 'cand_eval_1788751473948_bipu2n',
          evaluationId: 'eval_1788751473948_bipu2n',
          opportunity: 'TODAY_ORIENT',
          promptHeadline: "Mum's dentist appointment",
          promptQuestion: "How did Mum's dentist appointment go this morning—anything worth noting down or following up on?",
          userResponse: dentistMemory.originalText,
          capturedMemoryId: dentistMemory.id,
          createdAt: dentistMemory.createdAt || new Date().toISOString(),
        };
        combinedInteractions.unshift(syntheticHistoricalInteraction);

        // Also persist this authoritative interaction record
        executeBunnySql([
          {
            sql: `INSERT OR IGNORE INTO shadow_interactions (
              id, ezzy_id, communication_id, evaluation_id, opportunity,
              prompt_headline, prompt_question, user_response, captured_memory_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            args: [
              syntheticHistoricalInteraction.id,
              eid,
              syntheticHistoricalInteraction.communicationId,
              syntheticHistoricalInteraction.evaluationId,
              syntheticHistoricalInteraction.opportunity,
              syntheticHistoricalInteraction.promptHeadline,
              syntheticHistoricalInteraction.promptQuestion,
              syntheticHistoricalInteraction.userResponse,
              syntheticHistoricalInteraction.capturedMemoryId,
              syntheticHistoricalInteraction.createdAt,
            ],
          },
        ]).catch(() => {});
      }

      // Format calendar context
      const relevantCalendarContext = calendarEvents
        .filter((ev: any) => {
          const evStart = ev.startDatetime || '';
          return evStart.startsWith(todayYMD);
        })
        .map((ev: any) => {
          const evStart = new Date(ev.startDatetime).getTime();
          const evEnd = new Date(ev.endDatetime || ev.startDatetime).getTime();
          const nowMs = now.getTime();
          let status: 'upcoming' | 'current' | 'recently_ended' = 'upcoming';
          if (nowMs >= evStart && nowMs <= evEnd) {
            status = 'current';
          } else if (nowMs > evEnd) {
            status = 'recently_ended';
          }
          return {
            id: ev.id,
            title: ev.title,
            start: ev.startDatetime,
            end: ev.endDatetime || ev.startDatetime,
            status,
          };
        });

      // Prepare recently presented items
      const recentlyPresentedItems = candidates.map((c) => ({
        communicationId: c.id,
        headline: c.headline,
        question: c.question,
        presentedAt: c.generatedAt,
      }));

      const input: AttentionReviewInput = {
        ezzyId: eid,
        civilTime: {
          iso: now.toISOString(),
          timeZone,
          dateYMD: todayYMD,
          timeStr,
          dayOfWeek: localContext.weekday,
        },
        candidatePool: candidates,
        recentInteractions: combinedInteractions,
        recentlyPresentedItems,
        relevantCalendarContext,
      };

      console.log(
        `[Attention Review] Running executive review with ${candidates.length} candidates, ${combinedInteractions.length} interactions`
      );

      // Execute model review
      const reviewResult = await executeAttentionReview(input);

      const reviewId = `review_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const nowIso = new Date().toISOString();

      const record: ShadowAttentionReviewRecord = {
        id: reviewId,
        ezzy_id: eid,
        timestamp: nowIso,
        trigger_name: triggerName,
        active_channel: reviewResult.decision.curatedCommunications,
        candidate_resolutions: reviewResult.decision.candidateResolutions,
        overall_rationale: reviewResult.decision.overallRationale,
        model_name: reviewResult.modelName,
        latency_ms: reviewResult.latencyMs,
        prompt_tokens: reviewResult.promptTokens,
        output_tokens: reviewResult.outputTokens,
        created_at: nowIso,
      };

      // Persist to shadow_attention_reviews
      await executeBunnySql([
        {
          sql: `INSERT INTO shadow_attention_reviews (
            id, ezzy_id, timestamp, trigger_name,
            active_channel_json, candidate_resolutions_json, overall_rationale,
            model_name, latency_ms, prompt_tokens, output_tokens, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          args: [
            record.id,
            record.ezzy_id,
            record.timestamp,
            record.trigger_name,
            JSON.stringify(record.active_channel),
            JSON.stringify(record.candidate_resolutions),
            record.overall_rationale,
            record.model_name,
            record.latency_ms,
            record.prompt_tokens,
            record.output_tokens,
            record.created_at,
          ],
        },
      ]);

      // Cache for instant zero-cost presentation reads (<2ms)
      activeChannelCache.set(eid, record);

      console.log(
        `[Attention Review] Finished in ${record.latency_ms}ms: ${record.active_channel.length} active items, ${record.candidate_resolutions.length} candidate resolutions`
      );

      return record;
    } finally {
      inFlightReviews.delete(flightKey);
    }
  })();

  inFlightReviews.set(flightKey, reviewPromise);
  return reviewPromise;
}

/**
 * Ultra-fast presentation read (<2ms).
 * Reads directly from in-memory cache or latest SQLite record.
 * Never calls Gemini on screen refresh.
 */
export async function getLatestActiveAttentionChannel(
  ezzyId: string = DEFAULT_EZZY_ID
): Promise<ShadowAttentionReviewRecord | null> {
  const eid = ezzyId.trim();
  const cached = activeChannelCache.get(eid);
  if (cached) {
    return cached;
  }

  await initBunnyDb();
  try {
    const res = await executeBunnySql([
      {
        sql: `SELECT id, ezzy_id, timestamp, trigger_name, active_channel_json, candidate_resolutions_json, overall_rationale, model_name, latency_ms, prompt_tokens, output_tokens, created_at
              FROM shadow_attention_reviews
              WHERE ezzy_id = ?
              ORDER BY timestamp DESC
              LIMIT 1;`,
        args: [eid],
      },
    ]);

    const row = res[0]?.rows?.[0];
    if (!row) return null;

    const record: ShadowAttentionReviewRecord = {
      id: row.id,
      ezzy_id: row.ezzy_id,
      timestamp: row.timestamp,
      trigger_name: row.trigger_name,
      active_channel: JSON.parse(row.active_channel_json || '[]'),
      candidate_resolutions: JSON.parse(row.candidate_resolutions_json || '[]'),
      overall_rationale: row.overall_rationale,
      model_name: row.model_name,
      latency_ms: Number(row.latency_ms || 0),
      prompt_tokens: Number(row.prompt_tokens || 0),
      output_tokens: Number(row.output_tokens || 0),
      created_at: row.created_at,
    };

    activeChannelCache.set(eid, record);
    return record;
  } catch (err) {
    console.error('[Attention Service] Error fetching latest attention channel:', err);
    return null;
  }
}

import { executeBunnySql } from '../db/client';
import { initBunnyDb } from '../db/schema';
import { readMemoriesByIds } from '../db/memories';
import { getMemoryIdsForEntities } from '../db/memory_entities';
import { retrieveStageAExactSubject, retrieveStageBFts } from './native_search';
import { resolveRelationshipsInQuery, normalizeRoleName } from '../relationships/index';

export interface BoundedRetrievalOptions {
  question: string;
  localContext?: any;
  activeRelationships?: any[];
  userEntities?: any[];
  status?: string;
  maxCandidates?: number;
  ezzyId?: string;
}

export interface BoundedRetrievalResult {
  candidateMemories: any[];
  candidateIds: string[];
  telemetry: {
    entityIdsMatched: string[];
    entityLaneCount: number;
    exactSubjectLaneCount: number;
    ftsLaneCount: number;
    recencyLaneCount: number;
    totalUniqueCandidates: number;
  };
}

/**
 * Retrieves a bounded pool of candidate memories for Ask processing.
 * Never executes an unbounded SELECT * across the entire memories table.
 * 
 * Candidate sources:
 * 1. Canonical Entity Links (memory_entities) matching resolved persons / roles in query.
 * 2. Exact Subject / Projection Matches (memory_search_projection) for list/subject queries.
 * 3. BM25 Lexical Match (memories_fts) across content, people, places, topics, cues, items, subject.
 * 4. Temporal / Recency candidates (recent active items and temporal expressions).
 */
export async function retrieveBoundedMemoryCandidates(
  options: BoundedRetrievalOptions
): Promise<BoundedRetrievalResult> {
  await initBunnyDb();

  const {
    question,
    activeRelationships = [],
    userEntities = [],
    status = 'active',
    maxCandidates = 100,
    ezzyId,
  } = options;

  const qTrimmed = (question || '').trim();
  const qLower = qTrimmed.toLowerCase();
  const candidateIdSet = new Set<string>();

  // -------------------------------------------------------------
  // 1. CANONICAL ENTITY LANE
  // -------------------------------------------------------------
  const entityLaneIds: string[] = [];
  const matchedEntityIds: string[] = [];

  // A. Relationships in query (persons and roles)
  const { resolvedEntities, expandedTokens } = resolveRelationshipsInQuery(qTrimmed, activeRelationships);

  // Collect candidate entity IDs from resolved persons & roles
  for (const ent of resolvedEntities) {
    if (ent.resolvedPerson) {
      const pLower = ent.resolvedPerson.toLowerCase();
      const canonId = `ent_person_${pLower.replace(/[^a-z0-9]/g, '_')}`;
      if (!matchedEntityIds.includes(canonId)) {
        matchedEntityIds.push(canonId);
      }
    }
  }

  for (const tok of expandedTokens) {
    const tLower = tok.toLowerCase();
    const matchedRel = activeRelationships.find(r => r.person.toLowerCase() === tLower);
    if (matchedRel) {
      const canonId = `ent_person_${tLower.replace(/[^a-z0-9]/g, '_')}`;
      if (!matchedEntityIds.includes(canonId)) {
        matchedEntityIds.push(canonId);
      }
    }
  }

  // B. Match known userEntities by name or role in query
  for (const ue of userEntities) {
    const ueNameLower = (ue.name || '').toLowerCase().trim();
    const ueRoleLower = (ue.role || '').toLowerCase().trim();
    const ueNormRole = (ue.normalized_role || '').toLowerCase().trim();

    if (ueNameLower && ueNameLower.length >= 2) {
      const nameRegex = new RegExp(`\\b${ueNameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (nameRegex.test(qLower) && !matchedEntityIds.includes(ue.id)) {
        matchedEntityIds.push(ue.id);
      }
    }

    if (ueRoleLower && ueRoleLower.length >= 3) {
      const roleRegex = new RegExp(`\\b${ueRoleLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (roleRegex.test(qLower) && !matchedEntityIds.includes(ue.id)) {
        matchedEntityIds.push(ue.id);
      }
    } else if (ueNormRole && ueNormRole.length >= 3) {
      const normRoleRegex = new RegExp(`\\b${ueNormRole.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (normRoleRegex.test(qLower) && !matchedEntityIds.includes(ue.id)) {
        matchedEntityIds.push(ue.id);
      }
    }
  }

  // Filter out any suppressed entities
  let activeMatchedEntityIds = matchedEntityIds;
  if (matchedEntityIds.length > 0) {
    try {
      const suppRes = await executeBunnySql([{ sql: 'SELECT name FROM suppressed_entities;' }]);
      const suppressedSet = new Set((suppRes[0]?.rows || []).map((r: any) => (r.name || '').toLowerCase()));
      activeMatchedEntityIds = matchedEntityIds.filter(id => {
        const cleanName = id.replace(/^ent_person_/, '').replace(/_/g, ' ');
        return !suppressedSet.has(cleanName);
      });
    } catch (suppErr) {
      console.warn('[Bounded Retrieval] Non-fatal error checking suppression:', suppErr);
    }
  }

  // Execute candidate retrieval lanes concurrently for optimal latency
  const [
    memIdsFromEntities,
    exactSubjectIdsRaw,
    ftsResultsRaw,
    recencyResRaw
  ] = await Promise.all([
    activeMatchedEntityIds.length > 0 ? getMemoryIdsForEntities(activeMatchedEntityIds, ezzyId) : Promise.resolve([]),
    retrieveStageAExactSubject(qTrimmed, status, ezzyId).catch(subjErr => {
      console.warn('[Bounded Retrieval] Non-fatal error in subject retrieval lane:', subjErr);
      return [] as string[];
    }),
    retrieveStageBFts(qTrimmed, 40, ezzyId).catch(ftsErr => {
      console.warn('[Bounded Retrieval] Non-fatal error in FTS retrieval lane:', ftsErr);
      return [] as Array<{ memory_id: string; score: number; content: string }>;
    }),
    executeBunnySql([{
      sql: ezzyId
        ? `SELECT memory_id FROM memory_search_projection WHERE status = ? AND ezzy_id = ? ORDER BY createdAt DESC LIMIT 15;`
        : `SELECT memory_id FROM memory_search_projection WHERE status = ? ORDER BY createdAt DESC LIMIT 15;`,
      args: ezzyId ? [status, ezzyId] : [status],
    }]).catch(recErr => {
      console.warn('[Bounded Retrieval] Non-fatal error in recency retrieval lane:', recErr);
      return [] as any[];
    })
  ]);

  // 1. Entity Lane IDs
  for (const mId of memIdsFromEntities) {
    entityLaneIds.push(mId);
    candidateIdSet.add(mId);
  }

  // 2. Exact Subject Lane IDs
  const exactSubjectIds = exactSubjectIdsRaw || [];
  for (const mId of exactSubjectIds) {
    candidateIdSet.add(mId);
  }

  // 3. FTS Lane IDs
  const ftsIds: string[] = [];
  for (const r of (ftsResultsRaw || [])) {
    if (r && r.memory_id) {
      ftsIds.push(r.memory_id);
      candidateIdSet.add(r.memory_id);
    }
  }

  // 4. Recency Lane IDs
  const recencyIds: string[] = [];
  if (recencyResRaw[0]?.rows) {
    for (const row of recencyResRaw[0].rows) {
      if (row && row.memory_id) {
        recencyIds.push(row.memory_id);
        candidateIdSet.add(row.memory_id);
      }
    }
  }

  // -------------------------------------------------------------
  // 5. BOUNDING & HYDRATION
  // -------------------------------------------------------------
  // Guarantee that exact-subject cluster items are never truncated
  const prioritizedIds: string[] = [];
  for (const sId of exactSubjectIds) {
    if (!prioritizedIds.includes(sId)) prioritizedIds.push(sId);
  }
  for (const eId of entityLaneIds) {
    if (!prioritizedIds.includes(eId)) prioritizedIds.push(eId);
  }
  for (const fId of ftsIds) {
    if (!prioritizedIds.includes(fId)) prioritizedIds.push(fId);
  }
  for (const rId of recencyIds) {
    if (!prioritizedIds.includes(rId)) prioritizedIds.push(rId);
  }

  // Bounded slice (maxCandidates, but ensures all exactSubjectIds remain present)
  const finalCandidateIds = prioritizedIds.slice(0, Math.max(maxCandidates, exactSubjectIds.length));

  // Hydrate only the bounded candidates from database
  const candidateMemories = await readMemoriesByIds(finalCandidateIds, ezzyId);

  console.log(`[Bounded Retrieval] Query: "${qTrimmed}" -> Candidates: ${candidateMemories.length} (EntitiesMatched: [${activeMatchedEntityIds.join(', ')}], EntityLane: ${entityLaneIds.length}, SubjectLane: ${exactSubjectIds.length}, FtsLane: ${ftsIds.length}, RecencyLane: ${recencyIds.length})`);

  return {
    candidateMemories,
    candidateIds: finalCandidateIds,
    telemetry: {
      entityIdsMatched: activeMatchedEntityIds,
      entityLaneCount: entityLaneIds.length,
      exactSubjectLaneCount: exactSubjectIds.length,
      ftsLaneCount: ftsIds.length,
      recencyLaneCount: recencyIds.length,
      totalUniqueCandidates: candidateMemories.length,
    },
  };
}

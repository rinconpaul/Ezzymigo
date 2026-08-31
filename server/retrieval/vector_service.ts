import { executeBunnySql } from '../db/client';
import { getGeminiClient } from '../config/gemini';
import { parseStoredTopicsAndMetadata } from '../db/memories';
import { initBunnyDb } from '../db/schema';

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSION = 512;

/**
 * L2 Normalization helper: v / ||v||_2
 */
export function normalizeL2(vec: number[]): number[] {
  if (!vec || vec.length === 0) return [];
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  return vec.map(val => val / norm);
}

/**
 * Deterministically constructs the authoritative document string for vector indexing.
 * Format: content [ | People: people ] [ | Places: places ] [ | Topics: topics ] [ | Cues: retrieval_cues ]
 */
export function buildMemoryDocumentString(input: any): string {
  const content = input.content || input.originalText || input.original_text || '';
  let peopleArr: string[] = [];
  let placesArr: string[] = [];
  let topicsArr: string[] = [];
  let cuesArr: string[] = [];

  if (input.interpretation) {
    peopleArr = Array.isArray(input.interpretation.people) ? input.interpretation.people : [];
    placesArr = Array.isArray(input.interpretation.places) ? input.interpretation.places : [];
    topicsArr = Array.isArray(input.interpretation.topics) ? input.interpretation.topics : [];
    cuesArr = Array.isArray(input.interpretation.retrieval_cues) ? input.interpretation.retrieval_cues : [];
  } else {
    if (typeof input.people === 'string') {
      try {
        const p = JSON.parse(input.people);
        if (Array.isArray(p)) peopleArr = p;
      } catch {}
    } else if (Array.isArray(input.people)) {
      peopleArr = input.people;
    }

    if (typeof input.places === 'string') {
      try {
        const p = JSON.parse(input.places);
        if (Array.isArray(p)) placesArr = p;
      } catch {}
    } else if (Array.isArray(input.places)) {
      placesArr = input.places;
    }

    const meta = parseStoredTopicsAndMetadata(input.topics, input.kind || 'fact');
    topicsArr = meta.topics || [];
    cuesArr = meta.retrieval_cues || [];
  }

  const parts: string[] = [content.trim()];
  const cleanPeople = peopleArr.filter(Boolean).join(', ');
  if (cleanPeople) parts.push(`People: ${cleanPeople}`);

  const cleanPlaces = placesArr.filter(Boolean).join(', ');
  if (cleanPlaces) parts.push(`Places: ${cleanPlaces}`);

  const cleanTopics = topicsArr.filter(Boolean).join(', ');
  if (cleanTopics) parts.push(`Topics: ${cleanTopics}`);

  const cleanCues = cuesArr.filter(Boolean).join(', ');
  if (cleanCues) parts.push(`Cues: ${cleanCues}`);

  return parts.join(' | ');
}

/**
 * Generate 512-dimensional L2-normalized embedding for a memory document or ask query.
 */
export async function generateEmbedding(
  text: string,
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'
): Promise<{ vector: number[]; latencyMs: number }> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('Gemini client not initialized; GEMINI_API_KEY missing');
  }

  const start = Date.now();
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: {
      outputDimensionality: EMBEDDING_DIMENSION,
      taskType,
    },
  });

  const rawValues = response.embeddings?.[0]?.values || [];
  if (!rawValues || rawValues.length === 0) {
    throw new Error(`Empty embedding returned by ${EMBEDDING_MODEL}`);
  }

  const normalized = normalizeL2(rawValues);
  const latencyMs = Date.now() - start;

  return {
    vector: normalized,
    latencyMs,
  };
}

/**
 * Synchronizes a single memory's vector into memory_vectors table.
 * Idempotent, safe, and handles errors gracefully.
 */
export async function syncMemoryVector(memoryId: string, docText: string): Promise<void> {
  try {
    await initBunnyDb();
    const { vector } = await generateEmbedding(docText, 'RETRIEVAL_DOCUMENT');
    const vectorJson = JSON.stringify(vector);
    const nowIso = new Date().toISOString();

    await executeBunnySql([
      {
        sql: `INSERT INTO memory_vectors (memory_id, vector_json, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(memory_id) DO UPDATE SET
                vector_json = excluded.vector_json,
                updated_at = excluded.updated_at;`,
        args: [memoryId, vectorJson, nowIso],
      },
    ]);
  } catch (err) {
    console.error(`[Vector Service] Non-fatal error syncing vector for memory ${memoryId}:`, err);
  }
}

/**
 * Delete vector record for a deleted memory.
 */
export async function deleteMemoryVector(memoryId: string): Promise<void> {
  try {
    await executeBunnySql([
      {
        sql: 'DELETE FROM memory_vectors WHERE memory_id = ?;',
        args: [memoryId],
      },
    ]);
  } catch (err) {
    console.error(`[Vector Service] Error deleting vector for memory ${memoryId}:`, err);
  }
}

export interface VectorSearchResult {
  memory_id: string;
  cosine_distance: number;
  cosine_similarity: number;
}

/**
 * Searches memory_vectors using libSQL vector_distance_cos.
 */
export async function searchMemoryVectors(
  queryVector: number[],
  limit = 20
): Promise<{ results: VectorSearchResult[]; latencyMs: number }> {
  await initBunnyDb();
  const start = Date.now();
  const vectorJson = JSON.stringify(queryVector);

  const res = await executeBunnySql([
    {
      sql: `SELECT memory_id, vector_distance_cos(vector_json, ?) AS cosine_distance
            FROM memory_vectors
            ORDER BY cosine_distance ASC
            LIMIT ?;`,
      args: [vectorJson, limit],
    },
  ]);

  const rows = res[0]?.rows || [];
  const results: VectorSearchResult[] = rows.map((r: any) => {
    const dist = Number(r.cosine_distance) || 0;
    return {
      memory_id: r.memory_id,
      cosine_distance: dist,
      cosine_similarity: Math.max(0, 1 - dist),
    };
  });

  const latencyMs = Date.now() - start;
  return { results, latencyMs };
}

/**
 * Idempotent backfill of all memories into memory_vectors.
 */
export async function backfillMemoryVectors(options?: { force?: boolean }): Promise<{
  total: number;
  synced: number;
  skipped: number;
}> {
  await initBunnyDb();
  const memRes = await executeBunnySql([{ sql: 'SELECT * FROM memories;' }]);
  const rows = memRes[0]?.rows || [];
  const total = rows.length;

  if (total === 0) {
    return { total: 0, synced: 0, skipped: 0 };
  }

  let existingIds = new Set<string>();
  if (!options?.force) {
    const vecRes = await executeBunnySql([{ sql: 'SELECT memory_id FROM memory_vectors;' }]);
    const vecRows = vecRes[0]?.rows || [];
    existingIds = new Set(vecRows.map((r: any) => r.memory_id));
  } else {
    await executeBunnySql([{ sql: 'DELETE FROM memory_vectors;', args: [] }]);
  }

  let synced = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!options?.force && existingIds.has(row.id)) {
      skipped++;
      continue;
    }
    const docText = buildMemoryDocumentString(row);
    await syncMemoryVector(row.id, docText);
    synced++;
  }

  return { total, synced, skipped };
}

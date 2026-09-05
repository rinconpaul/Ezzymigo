import { executeBunnySql } from './client';
import { initBunnyDb } from './schema';
import { normalizeRoleName } from '../relationships/index';

export interface BackfillResult {
  totalMemories: number;
  linkedMemories: number;
  unlinkedMemories: number;
  ambiguousMemories: number;
  totalLinksCreated: number;
}

/**
 * Links a memory to one or more canonical entities in memory_entities.
 * Duplicate links are ignored via PRIMARY KEY (memory_id, entity_id).
 */
export async function linkMemoryEntities(
  memoryId: string,
  entityIds: string[],
  createdAt?: string,
  ezzyId: string = 'ezzy_default'
): Promise<void> {
  const mId = (memoryId || '').trim();
  if (!mId || !Array.isArray(entityIds) || entityIds.length === 0) return;

  const validEntityIds = Array.from(
    new Set(entityIds.map(e => (e || '').trim()).filter(Boolean))
  );
  if (validEntityIds.length === 0) return;

  await initBunnyDb();
  const nowIso = createdAt || new Date().toISOString();
  const scopeEzzyId = (ezzyId || 'ezzy_default').trim();

  const stmts = validEntityIds.map(entId => ({
    sql: `INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, ezzy_id, created_at)
          VALUES (?, ?, ?, ?);`,
    args: [mId, entId, scopeEzzyId, nowIso],
  }));

  try {
    await executeBunnySql(stmts);
    console.log(`[MemoryEntities] Linked memory "${mId}" to ${validEntityIds.length} entities in ezzy "${scopeEzzyId}": [${validEntityIds.join(', ')}]`);
  } catch (err) {
    console.error(`[MemoryEntities] Error linking memory "${mId}":`, err);
  }
}

/**
 * Removes all entity links for a given memory (e.g., upon memory deletion).
 */
export async function unlinkMemory(memoryId: string): Promise<void> {
  const mId = (memoryId || '').trim();
  if (!mId) return;

  await initBunnyDb();
  try {
    await executeBunnySql([{
      sql: 'DELETE FROM memory_entities WHERE memory_id = ?;',
      args: [mId],
    }]);
  } catch (err) {
    console.error(`[MemoryEntities] Error unlinking memory "${mId}":`, err);
  }
}

/**
 * Removes all memory links for a given entity (e.g., when entity is forgotten).
 */
export async function unlinkEntity(entityId: string): Promise<void> {
  const entId = (entityId || '').trim();
  if (!entId) return;

  await initBunnyDb();
  try {
    await executeBunnySql([{
      sql: 'DELETE FROM memory_entities WHERE entity_id = ?;',
      args: [entId],
    }]);
    console.log(`[MemoryEntities] Removed all links for entity "${entId}".`);
  } catch (err) {
    console.error(`[MemoryEntities] Error unlinking entity "${entId}":`, err);
  }
}

/**
 * Retrieves all memory IDs linked to a specific entity ID.
 */
export async function getMemoryIdsForEntity(entityId: string): Promise<string[]> {
  const entId = (entityId || '').trim();
  if (!entId) return [];

  await initBunnyDb();
  try {
    const results = await executeBunnySql([{
      sql: 'SELECT memory_id FROM memory_entities WHERE entity_id = ? ORDER BY created_at DESC;',
      args: [entId],
    }]);
    if (!results[0]?.rows) return [];
    return results[0].rows.map((r: any) => r.memory_id).filter(Boolean);
  } catch (err) {
    console.error(`[MemoryEntities] Error getting memory IDs for entity "${entId}":`, err);
    return [];
  }
}

/**
 * Retrieves all memory IDs linked to any of the provided entity IDs.
 */
export async function getMemoryIdsForEntities(entityIds: string[], ezzyId?: string): Promise<string[]> {
  const validIds = Array.from(new Set(entityIds.map(e => (e || '').trim()).filter(Boolean)));
  if (validIds.length === 0) return [];

  await initBunnyDb();
  try {
    const placeholders = validIds.map(() => '?').join(', ');
    const ezzyClause = ezzyId ? ` AND ezzy_id = ?` : ``;
    const ezzyArgs = ezzyId ? [ezzyId] : [];
    const results = await executeBunnySql([{
      sql: `SELECT DISTINCT memory_id FROM memory_entities WHERE entity_id IN (${placeholders})${ezzyClause} ORDER BY created_at DESC;`,
      args: [...validIds, ...ezzyArgs],
    }]);
    if (!results[0]?.rows) return [];
    return results[0].rows.map((r: any) => r.memory_id).filter(Boolean);
  } catch (err) {
    console.error('[MemoryEntities] Error getting memory IDs for entities:', err);
    return [];
  }
}

/**
 * Retrieves all entity IDs linked to a specific memory ID.
 */
export async function getLinkedEntityIdsForMemory(memoryId: string): Promise<string[]> {
  const mId = (memoryId || '').trim();
  if (!mId) return [];

  await initBunnyDb();
  try {
    const results = await executeBunnySql([{
      sql: 'SELECT entity_id FROM memory_entities WHERE memory_id = ? ORDER BY created_at ASC;',
      args: [mId],
    }]);
    if (!results[0]?.rows) return [];
    return results[0].rows.map((r: any) => r.entity_id).filter(Boolean);
  } catch (err) {
    console.error(`[MemoryEntities] Error getting linked entity IDs for memory "${mId}":`, err);
    return [];
  }
}

/**
 * Resolves a person name or role string to a canonical user_entities ID deterministically.
 * Case-insensitive, checks active relationships, user_entities, and suppression rules.
 * Never creates duplicates due to case or spacing variations.
 */
export async function resolvePersonToEntityId(
  personName: string,
  options?: { checkSuppression?: boolean },
  ezzyId?: string
): Promise<string | null> {
  const raw = (personName || '').trim();
  if (!raw) return null;
  const pLower = raw.toLowerCase();

  await initBunnyDb();

  // 1. Check suppression list (if suppressed, do not resolve or link)
  if (options?.checkSuppression !== false) {
    const supp = await executeBunnySql([{
      sql: 'SELECT name FROM suppressed_entities WHERE LOWER(name) = ?;',
      args: [pLower],
    }]);
    if (supp[0]?.rows && supp[0].rows.length > 0) {
      return null;
    }
  }

  const ezzyClause = ezzyId ? ` AND ezzy_id = ?` : ``;
  const ezzyArgs = ezzyId ? [ezzyId] : [];

  // 2. Direct match on user_entities by name
  const entRes = await executeBunnySql([{
    sql: `SELECT id, name FROM user_entities WHERE LOWER(name) = ?${ezzyClause} ORDER BY updated_at DESC;`,
    args: [pLower, ...ezzyArgs],
  }]);
  if (entRes[0]?.rows && entRes[0].rows.length > 0) {
    return entRes[0].rows[0].id;
  }

  // 3. Match on user_entities by normalized_role (e.g. "plumber", "doctor", "wife")
  const normRole = normalizeRoleName(pLower);
  if (normRole) {
    const roleEntRes = await executeBunnySql([{
      sql: `SELECT id, name FROM user_entities WHERE normalized_role = ?${ezzyClause} ORDER BY updated_at DESC;`,
      args: [normRole, ...ezzyArgs],
    }]);
    if (roleEntRes[0]?.rows && roleEntRes[0].rows.length === 1) {
      return roleEntRes[0].rows[0].id;
    }
  }

  // 4. Match on user_relationships (active relationships)
  const relRes = await executeBunnySql([{
    sql: `SELECT id, person, role, normalized_role FROM user_relationships WHERE LOWER(person) = ? AND is_active = 1${ezzyClause} ORDER BY updated_at DESC;`,
    args: [pLower, ...ezzyArgs],
  }]);
  if (relRes[0]?.rows && relRes[0].rows.length > 0) {
    const personNameMatched = relRes[0].rows[0].person;
    const canonicalId = `ent_person_${personNameMatched.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    return canonicalId;
  }

  return null;
}

/**
 * Safely and deterministically backfills memory_entities links for existing memories.
 * - Matches people[] to canonical entities/relationships without LLM guesswork.
 * - Does not link ambiguous identities.
 * - Idempotent (uses INSERT OR IGNORE).
 * - Reports linked, unlinked, and ambiguous statistics.
 */
export async function backfillMemoryEntities(): Promise<BackfillResult> {
  await initBunnyDb();

  const [memoriesRes, entitiesRes, relsRes, suppRes] = await Promise.all([
    executeBunnySql([{ sql: 'SELECT id, people, createdAt FROM memories;' }]),
    executeBunnySql([{ sql: 'SELECT id, name, normalized_role FROM user_entities;' }]),
    executeBunnySql([{ sql: 'SELECT person, role, normalized_role FROM user_relationships WHERE is_active = 1;' }]),
    executeBunnySql([{ sql: 'SELECT name FROM suppressed_entities;' }]),
  ]);

  const memories = memoriesRes[0]?.rows || [];
  const entities = entitiesRes[0]?.rows || [];
  const rels = relsRes[0]?.rows || [];
  const suppressed = new Set((suppRes[0]?.rows || []).map((r: any) => (r.name || '').toLowerCase()));

  // Map of lowercase name -> canonical entity ID
  const entityMap = new Map<string, string>();
  for (const ent of entities) {
    const nameLower = (ent.name || '').trim().toLowerCase();
    if (nameLower && !suppressed.has(nameLower)) {
      entityMap.set(nameLower, ent.id);
    }
  }

  // Also populate from active relationships if not in user_entities map
  for (const r of rels) {
    const pLower = (r.person || '').trim().toLowerCase();
    if (pLower && !suppressed.has(pLower) && !entityMap.has(pLower)) {
      entityMap.set(pLower, `ent_person_${pLower.replace(/[^a-z0-9]/g, '_')}`);
    }
  }

  let linkedMemories = 0;
  let unlinkedMemories = 0;
  let ambiguousMemories = 0;
  let totalLinksCreated = 0;

  const linkStmts: Array<{ sql: string; args: any[] }> = [];

  for (const mem of memories) {
    let peopleArr: string[] = [];
    try {
      peopleArr = typeof mem.people === 'string' ? JSON.parse(mem.people) : (mem.people || []);
      if (!Array.isArray(peopleArr)) peopleArr = [];
    } catch {
      peopleArr = [];
    }

    if (peopleArr.length === 0) {
      unlinkedMemories++;
      continue;
    }

    const matchedEntityIds = new Set<string>();
    let isAmbiguous = false;

    for (const rawPerson of peopleArr) {
      const p = (rawPerson || '').trim().toLowerCase();
      if (!p || suppressed.has(p)) continue;

      const entId = entityMap.get(p);
      if (entId) {
        matchedEntityIds.add(entId);
      }
    }

    if (isAmbiguous) {
      ambiguousMemories++;
    }

    if (matchedEntityIds.size > 0) {
      linkedMemories++;
      for (const entId of matchedEntityIds) {
        linkStmts.push({
          sql: `INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, created_at)
                VALUES (?, ?, ?);`,
          args: [mem.id, entId, mem.createdAt || new Date().toISOString()],
        });
        totalLinksCreated++;
      }
    } else {
      unlinkedMemories++;
    }
  }

  if (linkStmts.length > 0) {
    // Execute in chunks of 50 to avoid oversized batch payloads
    const chunkSize = 50;
    for (let i = 0; i < linkStmts.length; i += chunkSize) {
      const chunk = linkStmts.slice(i, i + chunkSize);
      await executeBunnySql(chunk);
    }
  }

  console.log(`[MemoryEntities Backfill] Completed: ${memories.length} total, ${linkedMemories} linked, ${unlinkedMemories} unlinked, ${ambiguousMemories} ambiguous, ${totalLinksCreated} links queued.`);

  return {
    totalMemories: memories.length,
    linkedMemories,
    unlinkedMemories,
    ambiguousMemories,
    totalLinksCreated,
  };
}

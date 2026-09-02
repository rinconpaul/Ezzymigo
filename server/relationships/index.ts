import { GoogleGenAI } from '@google/genai';
import { executeBunnySql } from '../db/client';
import { initBunnyDb } from '../db/schema';
import { readMemories, readMemoryById, updateMemoryInDb } from '../db/memories';
import { detectClockTimeAmbiguity, ClockTimeAmbiguity } from '../utils/timeAmbiguity';

// -------------------------------------------------------------
// Relationship-Aware Entities Layer (V1) & Ambiguity Rule
// -------------------------------------------------------------
export function normalizeRoleName(role: string): string {
  if (!role || typeof role !== 'string') return '';
  let cleaned = role.toLowerCase().trim();
  // Strip leading possessives/articles (e.g. "my ", "our ", "the ", "a ", "an ")
  cleaned = cleaned.replace(/^(?:my|our|the|a|an)\s+/i, '').trim();
  // Strip trailing punctuation or possessives like "'s"
  cleaned = cleaned.replace(/['’]s$/i, '').replace(/[.,?!]+$/, '').trim();

  // Normalize common synonyms
  if (['general practitioner', 'physician', 'doc', 'dr'].includes(cleaned)) return 'doctor';
  if (['physiotherapist'].includes(cleaned)) return 'physio';
  if (['hubby'].includes(cleaned)) return 'husband';
  if (['wifey'].includes(cleaned)) return 'wife';
  return cleaned;
}

// Read all active user relationships
export async function readActiveRelationships(): Promise<Array<{ id: string; person: string; role: string; normalized_role: string; is_active: boolean; updated_at: string }>> {
  try {
    await initBunnyDb();
    const results = await executeBunnySql([{
      sql: 'SELECT id, person, role, normalized_role, is_active, updated_at FROM user_relationships WHERE is_active = 1 ORDER BY updated_at DESC;'
    }]);

    if (!results[0] || !results[0].rows) return [];

    return results[0].rows.map((row: any) => ({
      id: row.id,
      person: row.person,
      role: row.role,
      normalized_role: row.normalized_role,
      is_active: Boolean(Number(row.is_active)),
      updated_at: row.updated_at,
    }));
  } catch (err) {
    console.error('[Relationships] Error reading active relationships:', err);
    return [];
  }
}

// Targeted query to look up a specific active relationship by normalized role
export async function getActiveRelationshipByRole(role: string): Promise<{ id: string; person: string; role: string; normalized_role: string; is_active: boolean; updated_at: string } | null> {
  const norm = normalizeRoleName(role);
  if (!norm) return null;
  try {
    await initBunnyDb();
    const results = await executeBunnySql([{
      sql: 'SELECT id, person, role, normalized_role, is_active, updated_at FROM user_relationships WHERE normalized_role = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1;',
      args: [norm]
    }]);
    if (!results[0]?.rows?.[0]) return null;
    const row = results[0].rows[0];
    return {
      id: row.id,
      person: row.person,
      role: row.role,
      normalized_role: row.normalized_role,
      is_active: Boolean(Number(row.is_active)),
      updated_at: row.updated_at,
    };
  } catch (err) {
    console.error('[Relationships] Error finding active relationship by role:', err);
    return null;
  }
}

// Targeted query to look up a specific active relationship by person name
export async function getActiveRelationshipByPerson(person: string): Promise<{ id: string; person: string; role: string; normalized_role: string; is_active: boolean; updated_at: string } | null> {
  const p = (person || '').trim();
  if (!p) return null;
  try {
    await initBunnyDb();
    const results = await executeBunnySql([{
      sql: 'SELECT id, person, role, normalized_role, is_active, updated_at FROM user_relationships WHERE LOWER(person) = LOWER(?) AND is_active = 1 ORDER BY updated_at DESC LIMIT 1;',
      args: [p]
    }]);
    if (!results[0]?.rows?.[0]) return null;
    const row = results[0].rows[0];
    return {
      id: row.id,
      person: row.person,
      role: row.role,
      normalized_role: row.normalized_role,
      is_active: Boolean(Number(row.is_active)),
      updated_at: row.updated_at,
    };
  } catch (err) {
    console.error('[Relationships] Error finding active relationship by person:', err);
    return null;
  }
}

// Extract phone number from raw clarification answer or freeform text
export function extractPhoneNumber(text: string): { phoneNumber: string | null; cleanedText: string } {
  if (!text || typeof text !== 'string') {
    return { phoneNumber: null, cleanedText: text || '' };
  }

  // Regex pattern for Australian & general phone numbers:
  // - Mobile: 04xx xxx xxx / +61 4xx xxx xxx / 04xxxxxxxx / 04xx-xxx-xxx / 04xx.xxx.xxx
  // - Landline with area code: (02) xxxx xxxx / 02 xxxx xxxx / 02-xxxx-xxxx / +61 2 xxxx xxxx
  // - 8-digit landline: xxxx xxxx / xxxx-xxxx
  // - 1300 / 1800 / 13 xx xx
  const phonePattern = /(?:(?:(?:\+?61\s*(?:\(0\))?|0)[2-478](?:[ -]?[0-9]){8})|(?:(?:\+?61\s*(?:\(0\))?|0)4(?:[ -]?[0-9]){8})|(?:\(?0[2-478]\)?\s*[0-9]{4}[ -]?[0-9]{4})|(?:1[38]00[ -]?[0-9]{3}[ -]?[0-9]{3})|(?:13[ -]?[0-9]{2}[ -]?[0-9]{2})|(?<!\d|\$|\/|-)(?:[2-9][0-9]{3}[ -][0-9]{4})(?!\d|\/|-)|(?<!\d|\$|\/|-)\b(?:04[0-9]{2}[ -]?[0-9]{3}[ -]?[0-9]{3})\b)/i;

  const match = text.match(phonePattern);
  if (!match) {
    return { phoneNumber: null, cleanedText: text };
  }

  const rawPhone = match[0].trim();

  // Strip phone and optional contact/label prefixes (e.g. "phone:", "ph:", "mob:", "mobile:", "tel:", etc.)
  let cleaned = text.replace(match[0], '');
  cleaned = cleaned.replace(/\b(?:phone(?:\s*number)?|ph|mob|mobile|tel|telephone|contact(?:\s*number)?)\s*[:#-]?\s*/gi, '');
  cleaned = cleaned.replace(/^[,\s:—-]+|[,\s:—-]+$/g, '').replace(/\s*,\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();
  cleaned = cleaned.replace(/[,\s:—-]+$/, '').trim();

  return { phoneNumber: rawPhone, cleanedText: cleaned };
}

// Save or update reusable user entity (supporting future metadata like phone, email, notes)
export async function saveUserEntity(entity: {
  name: string;
  entity_type?: string;
  role?: string;
  normalized_role?: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  const name = (entity.name || '').trim();
  if (!name) return;
  const entityType = entity.entity_type || 'person';
  const role = entity.role || '';
  const normalizedRole = entity.normalized_role || normalizeRoleName(role);
  const metadataStr = JSON.stringify(entity.metadata || {});
  const nowIso = new Date().toISOString();
  const id = `ent_${entityType}_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

  try {
    await initBunnyDb();
    await executeBunnySql([{
      sql: `INSERT INTO user_entities (id, name, entity_type, role, normalized_role, metadata, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              entity_type = excluded.entity_type,
              role = excluded.role,
              normalized_role = excluded.normalized_role,
              metadata = CASE WHEN excluded.metadata != '{}' THEN excluded.metadata ELSE user_entities.metadata END,
              updated_at = excluded.updated_at;`,
      args: [id, name, entityType, role, normalizedRole, metadataStr, nowIso]
    }]);
    console.log(`[Entities] Successfully saved user entity "${name}" (${entityType}) with metadata:`, metadataStr);
  } catch (err) {
    console.error('[Entities] Error saving user entity:', err);
  }
}

// Save or update relationships extracted from memories
export async function saveRelationships(relationships: Array<{ person: string; role: string; is_active?: boolean }>): Promise<void> {
  if (!Array.isArray(relationships) || relationships.length === 0) return;
  await initBunnyDb();
  const stmts: Array<{ sql: string; args: any[] }> = [];
  const nowIso = new Date().toISOString();

  for (const rel of relationships) {
    const person = (rel.person || '').trim();
    const rawRole = (rel.role || '').trim();
    const normalizedRole = normalizeRoleName(rawRole);
    const isActive = rel.is_active !== false ? 1 : 0;

    if (!person || !normalizedRole) continue;

    const id = `rel_${normalizedRole}_${person.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

    if (isActive === 1) {
      // Singular / exclusive roles (e.g. wife, husband, spouse, partner, plumber, etc.)
      // When a replacement is explicitly set (e.g. "Peter is my plumber"), supersede previous holders of this role
      const singularRoles = ['wife', 'husband', 'spouse', 'partner', 'plumber', 'electrician', 'mechanic', 'accountant', 'lawyer', 'boss', 'gp', 'primary doctor'];
      if (singularRoles.includes(normalizedRole)) {
        stmts.push({
          sql: 'UPDATE user_relationships SET is_active = 0, updated_at = ? WHERE normalized_role = ? AND LOWER(person) != LOWER(?);',
          args: [nowIso, normalizedRole, person]
        });
      }

      stmts.push({
        sql: `INSERT INTO user_relationships (id, person, role, normalized_role, is_active, updated_at)
              VALUES (?, ?, ?, ?, 1, ?)
              ON CONFLICT(id) DO UPDATE SET
                person = excluded.person,
                role = excluded.role,
                normalized_role = excluded.normalized_role,
                is_active = 1,
                updated_at = excluded.updated_at;`,
        args: [id, person, rawRole, normalizedRole, nowIso]
      });

      // Also persist to reusable user_entities
      saveUserEntity({
        name: person,
        entity_type: 'person',
        role: rawRole,
        normalized_role: normalizedRole,
      }).catch(e => console.error('[Entities] Auto-save error:', e));
    } else {
      // Deactivating / superseding relationship (e.g. "Steve isn't my plumber anymore")
      stmts.push({
        sql: `UPDATE user_relationships SET is_active = 0, updated_at = ?
              WHERE id = ? OR (normalized_role = ? AND LOWER(person) = LOWER(?));`,
        args: [nowIso, id, normalizedRole, person]
      });
    }
  }

  if (stmts.length > 0) {
    try {
      await executeBunnySql(stmts);
      console.log('[Relationships] Successfully persisted relationship updates:', relationships);
    } catch (dbErr) {
      console.error('[Relationships] Error persisting relationships:', dbErr);
    }
  }
}

// Idempotently restore any relationships already present in stored memory records into user_relationships table
export async function backfillStoredRelationships(): Promise<void> {
  try {
    const allMemories = await readMemories();
    const relationshipsToSave: Array<{ person: string; role: string; is_active?: boolean }> = [];
    for (const mem of allMemories) {
      const rels = mem.interpretation?.relationships;
      if (Array.isArray(rels) && rels.length > 0) {
        relationshipsToSave.push(...rels);
      }
    }
    if (relationshipsToSave.length > 0) {
      await saveRelationships(relationshipsToSave);
      console.log(`[Relationships] Idempotently synced ${relationshipsToSave.length} relationships from stored memories.`);
    }
  } catch (err) {
    console.error('[Relationships] Error backfilling relationships from memories:', err);
  }
}

// Deactivate a specific relationship or all relationships for a person without deleting memories
export async function deactivateUserRelationship(person: string, role?: string): Promise<{ deactivated: boolean; remainingRoles: string[] }> {
  const p = (person || '').trim();
  if (!p) return { deactivated: false, remainingRoles: [] };
  const r = (role || '').trim();
  const normalizedRole = r ? normalizeRoleName(r) : '';
  const nowIso = new Date().toISOString();

  await initBunnyDb();
  const stmts: Array<{ sql: string; args: any[] }> = [];

  if (normalizedRole) {
    stmts.push({
      sql: 'UPDATE user_relationships SET is_active = 0, updated_at = ? WHERE LOWER(person) = LOWER(?) AND (normalized_role = ? OR LOWER(role) = LOWER(?));',
      args: [nowIso, p, normalizedRole, r.toLowerCase()]
    });
  } else {
    stmts.push({
      sql: 'UPDATE user_relationships SET is_active = 0, updated_at = ? WHERE LOWER(person) = LOWER(?);',
      args: [nowIso, p]
    });
  }

  try {
    await executeBunnySql(stmts);
    console.log(`[Relationships] Deactivated relationship for person="${p}", role="${r || 'all'}"`);

    // Check remaining active relationships for this person
    const remResults = await executeBunnySql([{
      sql: 'SELECT role, normalized_role FROM user_relationships WHERE LOWER(person) = LOWER(?) AND is_active = 1;',
      args: [p]
    }]);

    const remainingRows = remResults[0]?.rows || [];
    const remainingRoles = remainingRows.map((row: any) => row.role);

    if (remainingRows.length > 0) {
      const topRole = remainingRows[0].role;
      const topNorm = remainingRows[0].normalized_role;
      await executeBunnySql([{
        sql: 'UPDATE user_entities SET role = ?, normalized_role = ?, updated_at = ? WHERE LOWER(name) = LOWER(?);',
        args: [topRole, topNorm, nowIso, p]
      }]);
    } else {
      await executeBunnySql([{
        sql: 'UPDATE user_entities SET role = NULL, normalized_role = NULL, updated_at = ? WHERE LOWER(name) = LOWER(?);',
        args: [nowIso, p]
      }]);
    }

    return { deactivated: true, remainingRoles };
  } catch (err) {
    console.error('[Relationships] Error deactivating relationship:', err);
    return { deactivated: false, remainingRoles: [] };
  }
}

// Forget entire entity and all its relationships after user confirmation
export async function forgetUserEntity(person: string): Promise<boolean> {
  const p = (person || '').trim();
  if (!p) return false;
  const nowIso = new Date().toISOString();

  await initBunnyDb();
  try {
    await executeBunnySql([
      {
        sql: 'UPDATE user_relationships SET is_active = 0, updated_at = ? WHERE LOWER(person) = LOWER(?);',
        args: [nowIso, p]
      },
      {
        sql: 'DELETE FROM user_entities WHERE LOWER(name) = LOWER(?);',
        args: [p]
      }
    ]);
    console.log(`[Entities] Successfully forgot entity "${p}" and deactivated all its relationships.`);
    return true;
  } catch (err) {
    console.error(`[Entities] Error forgetting entity "${p}":`, err);
    return false;
  }
}

// Correct a relationship (deactivates old role and learns new role without contradictory duplicates)
export async function correctUserRelationship(person: string, oldRole: string, newRole: string): Promise<void> {
  const p = (person || '').trim();
  const oldR = (oldRole || '').trim();
  const newR = (newRole || '').trim();
  if (!p || !newR) return;

  if (oldR) {
    await deactivateUserRelationship(p, oldR);
  }
  await saveRelationships([{ person: p, role: newR, is_active: true }]);
}

// Forget / Correction Intent Engine for Ask Ezzymigo
export async function evaluateKnowledgeModification(
  query: string,
  activeRelationships: Array<{ person: string; role: string; normalized_role: string }>,
  confirmed: boolean = false,
  ai: GoogleGenAI | null = null
): Promise<{
  handled: boolean;
  answer?: string;
  confirmation_required?: boolean;
  pending_action?: { type: string; entityName: string };
} | null> {
  const q = query.trim();
  const qLower = q.toLowerCase();

  // 1. CONFIRMATION OF ENTITY FORGET
  const confirmMatch = q.match(/^(?:yes(?:,\s*please)?|confirm(?:ed)?)\s*,?\s*(?:please\s+)?forget\s+(?:about\s+|all\s+about\s+|everything\s+about\s+)?([A-Za-z0-9\s]+?)[.!]?$/i);
  if (confirmMatch || (confirmed && q.match(/^(?:please\s+)?(?:forget|delete|remove)\s+(?:about\s+|all\s+about\s+|everything\s+about\s+)?([A-Za-z0-9\s]+?)[.!]?$/i))) {
    const rawTarget = confirmMatch ? confirmMatch[1].trim() : q.replace(/^(?:please\s+)?(?:forget|delete|remove)\s+(?:about\s+|all\s+about\s+|everything\s+about\s+)?/i, '').replace(/[.!]?$/, '').trim();
    if (rawTarget && !rawTarget.toLowerCase().startsWith('that ')) {
      await forgetUserEntity(rawTarget);
      return {
        handled: true,
        answer: `I've forgotten all saved knowledge about ${rawTarget}.`,
      };
    }
  }

  // 2. CORRECTION REQUESTS (e.g. "Bill isn't my cousin, he's my neighbour" or "Bill is my neighbour, not my cousin")
  // Pattern 2A: "X isn't my [oldRole], he's my [newRole]"
  const corrMatch1 = q.match(/^(?:actually,?\s*)?([A-Za-z0-9\s]+?)\s+(?:is\s+not|isn['’]t|is\s+no\s+longer)\s+(?:my\s+|the\s+|a\s+|an\s+)?([a-z\s]+?)(?:,|\s+|-)+(?:he['’]?s|she['’]?s|they['’]?re|he\s+is|she\s+is|they\s+are|is)\s+(?:my\s+|a\s+|an\s+)?([a-z\s]+?)[.!]?$/i);
  if (corrMatch1) {
    const person = corrMatch1[1].trim();
    const oldRole = corrMatch1[2].trim();
    const newRole = corrMatch1[3].trim();
    await correctUserRelationship(person, oldRole, newRole);
    return {
      handled: true,
      answer: `I've updated my knowledge: ${person} is your ${newRole} (and no longer listed as your ${oldRole}).`,
    };
  }

  // Pattern 2B: "X is my [newRole], not my [oldRole]"
  const corrMatch2 = q.match(/^(?:actually,?\s*)?([A-Za-z0-9\s]+?)\s+is\s+(?:my\s+|a\s+|an\s+)?([a-z\s]+?)(?:,|\s+|-)+(?:not\s+(?:my\s+|the\s+|a\s+|an\s+)?|instead\s+of\s+(?:my\s+|the\s+|a\s+|an\s+)?)([a-z\s]+?)[.!]?$/i);
  if (corrMatch2) {
    const person = corrMatch2[1].trim();
    const newRole = corrMatch2[2].trim();
    const oldRole = corrMatch2[3].trim();
    await correctUserRelationship(person, oldRole, newRole);
    return {
      handled: true,
      answer: `I've updated my knowledge: ${person} is your ${newRole} (and no longer listed as your ${oldRole}).`,
    };
  }

  // 3. RELATIONSHIP-SPECIFIC FORGET (e.g. "Forget that Bill is my cousin", "Bill isn't my cousin", "Steve is no longer my plumber")
  // Pattern 3A: "Forget that X is my Y"
  const relForgetMatch1 = q.match(/^(?:please\s+)?forget\s+(?:that\s+)?([A-Za-z0-9\s]+?)\s+(?:is|was)\s+(?:my\s+|the\s+|a\s+|an\s+)?([a-z\s]+?)[.!]?$/i);
  if (relForgetMatch1) {
    const person = relForgetMatch1[1].trim();
    const role = relForgetMatch1[2].trim();
    await deactivateUserRelationship(person, role);
    return {
      handled: true,
      answer: `I've forgotten that ${person} is your ${role}.`,
    };
  }

  // Pattern 3B: "X isn't my Y" (standalone without replacement)
  const relForgetMatch2 = q.match(/^(?:actually,?\s*)?([A-Za-z0-9\s]+?)\s+(?:is\s+not|isn['’]t|is\s+no\s+longer)\s+(?:my\s+|the\s+|a\s+|an\s+)?([a-z\s]+?)(?:\s+anymore)?[.!]?$/i);
  if (relForgetMatch2) {
    const person = relForgetMatch2[1].trim();
    const role = relForgetMatch2[2].trim();
    await deactivateUserRelationship(person, role);
    return {
      handled: true,
      answer: `I've forgotten that ${person} is your ${role}.`,
    };
  }

  // Pattern 3C: "Forget X as my Y"
  const relForgetMatch3 = q.match(/^(?:please\s+)?(?:forget|remove|delete)\s+(?:relationship\s+(?:with|between)\s+)?([A-Za-z0-9\s]+?)\s+(?:as|being)\s+(?:my\s+|the\s+|a\s+|an\s+)?([a-z\s]+?)[.!]?$/i);
  if (relForgetMatch3) {
    const person = relForgetMatch3[1].trim();
    const role = relForgetMatch3[2].trim();
    await deactivateUserRelationship(person, role);
    return {
      handled: true,
      answer: `I've forgotten that ${person} is your ${role}.`,
    };
  }

  // 4. ENTITY-WIDE FORGET (e.g. "Forget Bill", "Forget about Bill", "Forget all about Bill")
  const entityForgetMatch = q.match(/^(?:please\s+)?(?:forget|delete|remove)\s+(?:about\s+|all\s+about\s+|everything\s+about\s+)?([A-Za-z0-9\s]+?)[.!]?$/i);
  if (entityForgetMatch) {
    const target = entityForgetMatch[1].trim();
    if (target && !target.toLowerCase().startsWith('that ') && !target.toLowerCase().includes(' is ')) {
      // Require explicit confirmation
      return {
        handled: true,
        answer: `Are you sure you want to forget all learned knowledge about ${target}? This will remove all saved relationships and details for ${target}.`,
        confirmation_required: true,
        pending_action: {
          type: 'forget_entity',
          entityName: target,
        },
      };
    }
  }

  return null;
}

// Enrich a newly saved memory with a learned or resolved relationship without altering past memories
export async function enrichMemoryWithRelationship(memoryId: string, person: string, role: string): Promise<void> {
  try {
    const memory = await readMemoryById(memoryId);
    if (!memory || !memory.interpretation) return;

    const interp = memory.interpretation;

    // 1. Add relationship if missing
    if (!Array.isArray(interp.relationships)) interp.relationships = [];
    if (!interp.relationships.some((r: any) => r.person?.toLowerCase() === person.toLowerCase() && r.role?.toLowerCase() === role.toLowerCase())) {
      interp.relationships.push({ person, role, is_active: true });
    }

    // 2. Add people if missing
    if (!Array.isArray(interp.people)) interp.people = [];
    if (!interp.people.some((p: string) => p.toLowerCase() === person.toLowerCase())) {
      interp.people.push(person);
    }

    // 3. Add retrieval cues
    if (!Array.isArray(interp.retrieval_cues)) interp.retrieval_cues = [];
    const cuesToAdd = [
      role.toLowerCase(),
      `${person} (${role})`.toLowerCase(),
      `${role} ${person}`.toLowerCase(),
      `my ${role}`.toLowerCase(),
    ];
    for (const cue of cuesToAdd) {
      if (!interp.retrieval_cues.includes(cue)) {
        interp.retrieval_cues.push(cue);
      }
    }

    await updateMemoryInDb(memoryId, interp);
    console.log(`[Ambiguity Rule] Successfully enriched memory ${memoryId} with relationship: ${person} <-> ${role}`);
  } catch (err) {
    console.error(`[Ambiguity Rule] Error enriching memory ${memoryId}:`, err);
  }
}

// Ambiguity Detection Engine (Ezzymigo Ambiguity Rule)
// Detects potentially ambiguous personal references in saved memories and prompts optional clarification
export async function detectAmbiguityInSavedMemories(
  memories: any[],
  activeRelationships: Array<{ person: string; role: string; normalized_role: string }>,
  originalText: string,
  ai: GoogleGenAI | null
): Promise<{
  id: string;
  question: string;
  entityName: string;
  entityType: string;
  candidateOptions?: string[];
  memoryId?: string;
  context?: string;
  metadata?: Record<string, any>;
} | null> {
  // If memory is not_sure, never trigger entity clarification
  const validMemories = memories.filter(m => m.interpretation?.kind !== 'not_sure');
  if (validMemories.length === 0) return null;

  // 1. FIRST PRIORITY: Check for ambiguous clock times requiring exact notifications
  for (const memory of validMemories) {
    const ambiguity: ClockTimeAmbiguity = memory.interpretation?.temporal_ambiguity ||
      detectClockTimeAmbiguity(memory.originalText, memory.interpretation?.resurfacing?.timing || memory.interpretation?.original_time_expression);

    if (ambiguity && ambiguity.isAmbiguous && ambiguity.question) {
      console.log(`[Ambiguity Rule] Ambiguous clock time detected for memory "${memory.id}". Asking: "${ambiguity.question}"`);
      return {
        id: `clar_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        question: ambiguity.question,
        entityName: ambiguity.hourStr || 'time',
        entityType: 'time_meridiem',
        candidateOptions: ambiguity.candidateOptions || [`${ambiguity.hourStr} am`, `${ambiguity.hourStr} pm`],
        memoryId: memory.id,
        context: memory.interpretation?.content || memory.originalText,
        metadata: {
          hour: ambiguity.hour,
          minute: ambiguity.minute,
          hourStr: ambiguity.hourStr,
          targetDate: ambiguity.targetDate,
          timeExpr: ambiguity.timeExpr,
        }
      };
    }
  }

  // Retrieve existing stored memories to distinguish first-mention from established contextual entities
  const allStored = await readMemories();
  const newIds = new Set(memories.map(m => m.id));
  const priorStored = allStored.filter(m => !newIds.has(m.id));

  for (const memory of validMemories) {
    const people: string[] = Array.isArray(memory.interpretation?.people) ? memory.interpretation.people : [];
    const memoryRelationships = Array.isArray(memory.interpretation?.relationships) ? memory.interpretation.relationships : [];

    // If the memory already explicitly defined the relationship (e.g. "Barb is my wife"), it was learned in saveRelationships
    if (memoryRelationships.length > 0) {
      continue;
    }

    for (const rawPerson of people) {
      const person = (rawPerson || '').trim();
      if (!person || person.length < 2) continue;

      // Search active relationships for this person
      const matches = activeRelationships.filter(r => r.person.toLowerCase() === person.toLowerCase());

      if (matches.length === 1) {
        // 1 Confident Match: Silently associate!
        console.log(`[Ambiguity Rule] Confidently matched "${person}" to known role "${matches[0].role}". Silently associating without asking.`);
        await enrichMemoryWithRelationship(memory.id, matches[0].person, matches[0].role);
        continue;
      } else if (matches.length > 1) {
        // Multiple known matches: Disambiguate! (e.g. "Which Peter? Peter — brother, Peter — plumber")
        console.log(`[Ambiguity Rule] Multiple candidates for person "${person}". Asking disambiguation question.`);
        return {
          id: `clar_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          question: `Which ${person}?`,
          entityName: person,
          entityType: 'person',
          candidateOptions: matches.map(m => `${m.person} — ${m.role}`),
          memoryId: memory.id,
          context: memory.interpretation?.content || memory.originalText,
        };
      } else {
        // 0 matches: Check if this person already appears in prior stored memories
        const pLower = person.toLowerCase();
        const escaped = pLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wordRegex = new RegExp(`\\b${escaped}\\b`, 'i');

        const alreadyInPriorMemories = priorStored.some(m => {
          const mPeople: string[] = Array.isArray(m.interpretation?.people) ? m.interpretation.people : [];
          if (mPeople.some(p => (p || '').toLowerCase().trim() === pLower)) return true;
          const orig = m.originalText || '';
          const cont = m.interpretation?.content || '';
          return wordRegex.test(orig) || wordRegex.test(cont);
        });

        if (alreadyInPriorMemories) {
          console.log(`[Ambiguity Rule] Person "${person}" already exists in stored memories. Treating as established contextual entity with unspecified relationship; suppressing repeat clarification.`);
          continue;
        }

        // 0 matches and first-ever mention: Optional clarification (e.g. "Who is Margaret?")
        console.log(`[Ambiguity Rule] Unknown person "${person}" detected (first mention). Generating optional clarification.`);
        return {
          id: `clar_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          question: `Who is ${person}?`,
          entityName: person,
          entityType: 'person',
          memoryId: memory.id,
          context: memory.interpretation?.content || memory.originalText,
        };
      }
    }

    // Also check for role references mentioned in text when people array might be empty (e.g. "My sister wants the book", "I'll ask my doctor")
    const textLower = (memory.originalText || '').toLowerCase();
    const commonRoles = ['sister', 'brother', 'son', 'daughter', 'doctor', 'physio', 'plumber', 'electrician', 'mechanic', 'dentist', 'boss', 'accountant'];

    if (people.length === 0) {
      for (const role of commonRoles) {
        const regex = new RegExp(`\\b(?:my|our)\\s+(${role})\\b`, 'i');
        const match = textLower.match(regex);
        if (match) {
          const matchedRole = match[1].toLowerCase();
          const normalized = normalizeRoleName(matchedRole);
          const matches = activeRelationships.filter(r => r.normalized_role === normalized);

          if (matches.length === 1) {
            console.log(`[Ambiguity Rule] Silently resolving role "my ${matchedRole}" to known person "${matches[0].person}".`);
            await enrichMemoryWithRelationship(memory.id, matches[0].person, matches[0].role);
          } else if (matches.length > 1) {
            console.log(`[Ambiguity Rule] Multiple candidates for role "${matchedRole}". Asking disambiguation question.`);
            return {
              id: `clar_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              question: `Which ${matchedRole}?`,
              entityName: matchedRole,
              entityType: 'relationship',
              candidateOptions: matches.map(m => m.person),
              memoryId: memory.id,
              context: memory.interpretation?.content || memory.originalText,
            };
          } else if (matches.length === 0) {
            // Check if this role was already mentioned in prior memories
            const roleRegex = new RegExp(`\\b(?:my|our)\\s+${matchedRole}\\b`, 'i');
            const priorRoleMentioned = priorStored.some(m =>
              roleRegex.test(m.originalText || '') || roleRegex.test(m.interpretation?.content || '')
            );
            if (priorRoleMentioned) {
              console.log(`[Ambiguity Rule] Role "my ${matchedRole}" already mentioned in prior memories. Suppressing repeat clarification.`);
              continue;
            }

            console.log(`[Ambiguity Rule] Unknown role "my ${matchedRole}" detected (first mention). Prompting clarification.`);
            return {
              id: `clar_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              question: `Who is your ${matchedRole}?`,
              entityName: matchedRole,
              entityType: 'relationship',
              memoryId: memory.id,
              context: memory.interpretation?.content || memory.originalText,
            };
          }
          break;
        }
      }
    }
  }

  return null;
}

// Resolve relational cues in user query before retrieval
export function resolveRelationshipsInQuery(
  query: string,
  activeRelationships: Array<{ person: string; role: string; normalized_role: string }>
): {
  resolvedEntities: Array<{ roleMatch: string; normalizedRole: string; resolvedPerson: string }>;
  ambiguousEntities: Array<{ roleMatch: string; normalizedRole: string; candidatePeople: string[] }>;
  expandedTokens: string[];
} {
  const resolvedEntities: Array<{ roleMatch: string; normalizedRole: string; resolvedPerson: string }> = [];
  const ambiguousEntities: Array<{ roleMatch: string; normalizedRole: string; candidatePeople: string[] }> = [];
  const expandedTokens: string[] = [];

  if (!query || !Array.isArray(activeRelationships) || activeRelationships.length === 0) {
    return { resolvedEntities, ambiguousEntities, expandedTokens };
  }

  const qLower = query.toLowerCase();

  // 1. Group active relationships by normalized role
  const roleMap = new Map<string, string[]>();
  for (const rel of activeRelationships) {
    const nRole = rel.normalized_role;
    if (!roleMap.has(nRole)) {
      roleMap.set(nRole, []);
    }
    const list = roleMap.get(nRole)!;
    if (!list.some(p => p.toLowerCase() === rel.person.toLowerCase())) {
      list.push(rel.person);
    }
  }

  // Check each role against query
  for (const [nRole, people] of roleMap.entries()) {
    // Regex matches e.g. "my wife", "our wife", "the wife", "wife's", "wife", "my brother", "brother"
    const regex = new RegExp(`\\b(?:(?:my|our|the)\\s+)?${nRole}(?:['’]s)?\\b`, 'i');
    const match = qLower.match(regex);
    if (match) {
      const roleMatch = match[0];
      if (people.length === 1) {
        resolvedEntities.push({
          roleMatch,
          normalizedRole: nRole,
          resolvedPerson: people[0],
        });
        if (!expandedTokens.includes(people[0])) {
          expandedTokens.push(people[0]);
        }
      } else if (people.length > 1) {
        ambiguousEntities.push({
          roleMatch,
          normalizedRole: nRole,
          candidatePeople: people,
        });
      }
    }
  }

  // 2. Also check if query mentions a known person directly (e.g. "Peter" -> expand to "brother", "Peter")
  for (const rel of activeRelationships) {
    if (rel.person && qLower.includes(rel.person.toLowerCase())) {
      if (!expandedTokens.includes(rel.person)) {
        expandedTokens.push(rel.person);
      }
      if (rel.role && !expandedTokens.includes(rel.role)) {
        expandedTokens.push(rel.role);
      }
      if (rel.normalized_role && !expandedTokens.includes(rel.normalized_role)) {
        expandedTokens.push(rel.normalized_role);
      }
    }
  }

  return { resolvedEntities, ambiguousEntities, expandedTokens };
}

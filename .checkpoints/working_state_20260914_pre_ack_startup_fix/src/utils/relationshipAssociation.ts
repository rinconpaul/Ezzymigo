import { MemoryItem, UserRelationship } from '../types';

/**
 * Escapes characters for safe inclusion in a regular expression.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks if a standalone person name reference appears in raw text.
 * Requires genuine whole-token / word boundary isolation.
 * Prevents "Barb" from matching inside "barbecue", "barber", "barbell", "rhubarb",
 * or "Tom" from matching inside "tomorrow", "bottom", "custom", etc.
 */
export function hasStandaloneNameReference(text: string, personName: string): boolean {
  if (!text || !personName) return false;
  const trimmedName = personName.trim();
  if (!trimmedName) return false;

  // Use Unicode-aware word boundaries to ensure the name is bounded by
  // start/end of string or non-letter/number characters.
  // This matches: "call Barb", "Barb's dinner", "Barb, how are you", "dinner with Barb."
  // Strictly rejects: "barbecue", "barber", "barbell", "tomorrow", "bottom", etc.
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmedName)}($|[^\\p{L}\\p{N}])`, 'iu');
  return pattern.test(text);
}

/**
 * Identifies active relationships genuinely associated with a given memory.
 *
 * Precedence:
 * 1. Authoritative: `memory.interpretation.people` and `memory.interpretation.relationships`.
 *    If the person appears in the structured entity extraction, it is genuinely associated.
 * 2. Fallback: Standalone whole-token match in raw text (`originalText` or `content`).
 *    Substrings inside other words are strictly rejected.
 */
export function findAssociatedRelationships(
  memory: MemoryItem,
  activeRelationships: UserRelationship[]
): UserRelationship[] {
  if (!memory || !Array.isArray(activeRelationships) || activeRelationships.length === 0) {
    return [];
  }

  // 1. Authoritative: Extract structured people & relationship entities
  const structuredPeople = (memory.interpretation?.people || [])
    .map((p) => (typeof p === 'string' ? p.trim().toLowerCase() : ''))
    .filter(Boolean);

  const structuredRelPeople = (memory.interpretation?.relationships || [])
    .map((r) => (typeof r?.person === 'string' ? r.person.trim().toLowerCase() : ''))
    .filter(Boolean);

  // 2. Compatibility fallback: Raw text strings
  const rawTexts = [
    memory.originalText,
    memory.interpretation?.content,
  ].filter((t): t is string => typeof t === 'string' && t.trim().length > 0);

  return activeRelationships.filter((rel) => {
    if (!rel || !rel.person) return false;
    if (rel.is_active === false) return false;

    const personName = rel.person.trim();
    if (!personName) return false;
    const personLower = personName.toLowerCase();

    // Check 1: Authoritative structured people array
    if (structuredPeople.includes(personLower)) {
      return true;
    }

    // Check 2: Authoritative structured relationships array
    if (structuredRelPeople.includes(personLower)) {
      return true;
    }

    // Check 3: Compatibility fallback: Standalone word boundary match in raw text
    for (const text of rawTexts) {
      if (hasStandaloneNameReference(text, personName)) {
        return true;
      }
    }

    return false;
  });
}

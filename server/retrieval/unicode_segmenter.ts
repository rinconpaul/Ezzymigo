// Unicode-aware word segmentation and lexical anchoring utilities
// Phase 2 — Architecture D Retrieval Simplification

export function detectScript(text: string): string {
  if (!text) return 'empty';
  const hasCJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/u.test(text);
  const hasArabic = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/u.test(text);
  const hasCyrillic = /[\u0400-\u04ff]/u.test(text);
  const hasDevanagari = /[\u0900-\u097f]/u.test(text);
  const hasLatin = /[a-zA-Z\u00C0-\u024F]/u.test(text);

  const scripts: string[] = [];
  if (hasCJK) scripts.push('cjk');
  if (hasArabic) scripts.push('arabic');
  if (hasCyrillic) scripts.push('cyrillic');
  if (hasDevanagari) scripts.push('devanagari');
  if (hasLatin) scripts.push('latin');

  if (scripts.length === 0) return 'symbolic';
  if (scripts.length === 1) return scripts[0];
  return `mixed_${scripts.join('_')}`;
}

export function segmentUnicodeWords(text: string, locale: string = 'und'): string[] {
  if (!text || typeof text !== 'string') return [];
  try {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    const segments = Array.from(segmenter.segment(text));
    return segments
      .filter(s => s.isWordLike)
      .map(s => s.segment.trim().toLowerCase())
      .filter(w => w.length > 0);
  } catch (err) {
    // Fallback if Intl.Segmenter fails for unknown locale
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }
}

export interface UniqueLexicalAnchorResult {
  candidateId: string;
  matchedTokens: string[];
  uniqueTokens: string[];
}

/**
 * Extracts unique discriminative tokens present in a candidate document that are ABSENT from other candidates in the pool.
 * This directly powers vector + lexical sibling arbitration across English, Japanese, Arabic, etc.
 */
export function extractUniqueDiscriminativeTokens(
  queryTokens: string[],
  candidateDocs: Array<{ id: string; text: string }>
): Map<string, UniqueLexicalAnchorResult> {
  const result = new Map<string, UniqueLexicalAnchorResult>();
  if (candidateDocs.length === 0 || queryTokens.length === 0) return result;

  // Build candidate token sets
  const candidateTokenSets = new Map<string, Set<string>>();
  for (const doc of candidateDocs) {
    const docTokens = segmentUnicodeWords(doc.text);
    candidateTokenSets.set(doc.id, new Set(docTokens));
  }

  // Find matched query tokens for each candidate
  const candidateMatches = new Map<string, string[]>();
  for (const doc of candidateDocs) {
    const tokenSet = candidateTokenSets.get(doc.id)!;
    const matches = queryTokens.filter(qToken => tokenSet.has(qToken));
    candidateMatches.set(doc.id, matches);
  }

  // Identify unique discriminators for each candidate
  for (const doc of candidateDocs) {
    const myMatches = candidateMatches.get(doc.id) || [];
    const uniqueTokens = myMatches.filter(token => {
      // Check if any other candidate in the pool contains this token
      for (const otherDoc of candidateDocs) {
        if (otherDoc.id === doc.id) continue;
        const otherSet = candidateTokenSets.get(otherDoc.id);
        if (otherSet && otherSet.has(token)) {
          return false; // Not unique to this candidate
        }
      }
      return true; // Unique to this candidate in the candidate pool
    });

    result.set(doc.id, {
      candidateId: doc.id,
      matchedTokens: myMatches,
      uniqueTokens,
    });
  }

  return result;
}

/**
 * Utilities for normalizing and displaying list subjects in Ezzymigo.
 * 
 * Normalization is used for canonical identity and grouping so capitalization
 * and harmless whitespace variations (e.g. "Bunnings list", "bunnings list", " Bunnings list ")
 * group reliably into a single logical list.
 * 
 * Display functions preserve human-readable casing and remove redundant spacing.
 */

/**
 * Normalizes a list subject string for canonical identity and grouping.
 * Strips surrounding whitespace, collapses internal whitespace, and lowercases.
 * E.g. "  Bunnings   list " -> "bunnings list"
 */
export function normalizeSubjectKey(rawSubject?: string | null): string {
  if (!rawSubject || typeof rawSubject !== 'string') return '';
  const trimmed = rawSubject.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return '';
  return trimmed.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Cleans a list subject string for human-readable display.
 * Strips harmless surrounding whitespace and collapses redundant internal whitespace,
 * while preserving the user's intended casing.
 * E.g. "   Bunnings   list   " -> "Bunnings list"
 */
export function cleanDisplaySubject(rawSubject?: string | null): string {
  if (!rawSubject || typeof rawSubject !== 'string') return '';
  return rawSubject.replace(/\s+/g, ' ').trim();
}

/**
 * Compares an existing display title with a candidate display title from another memory
 * in the same normalized list group, selecting the most human-readable presentation.
 * Prefers titles with capitalized characters over all-lowercase titles.
 */
export function pickBestDisplayTitle(currentBest: string, candidate?: string | null): string {
  const cleanCand = cleanDisplaySubject(candidate);
  if (!cleanCand) return currentBest;
  if (!currentBest) return cleanCand;

  const currentHasUpper = /[A-Z]/.test(currentBest);
  const candHasUpper = /[A-Z]/.test(cleanCand);

  // If current is all-lowercase and candidate has uppercase (e.g. Title Case), prefer the candidate
  if (!currentHasUpper && candHasUpper) {
    return cleanCand;
  }

  return currentBest;
}

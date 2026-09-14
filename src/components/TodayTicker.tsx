import React from 'react';
import { TodayRelevanceCandidate } from '../types';

export function getDismissedReflections(): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem('ezzymigo_dismissed_reflections');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function markOccurrenceDismissed(candidate: { occurrence_id?: string; source_id?: string }): void {
  if (!candidate) return;
  // Ephemeral call candidates must never be persisted in localStorage
  if (candidate.source_id?.startsWith('ephemeral_call:')) return;
  const id = candidate.occurrence_id || candidate.source_id;
  if (!id) return;
  try {
    if (typeof localStorage === 'undefined') return;
    const dismissed = getDismissedReflections();
    if (!dismissed.includes(id)) {
      dismissed.push(id);
      localStorage.setItem('ezzymigo_dismissed_reflections', JSON.stringify(dismissed));
    }
  } catch {}
}

export function markReflectionDismissed(candidate: { occurrence_id?: string; source_id?: string }): void {
  markOccurrenceDismissed(candidate);
}

export const TodayTicker: React.FC<any> = () => {
  return null;
};

export default TodayTicker;

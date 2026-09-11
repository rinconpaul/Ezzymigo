import { ShadowEvaluationRecord } from '../snapshot/types';
import { ShadowAttentionReviewRecord } from './types';
import { getHourInTz, getYMDInTz } from '../utils/time';

export type TimePhase = 'morning' | 'afternoon' | 'evening' | 'night';

/**
 * Returns the civil time phase for a given date in a time zone:
 * - morning: 05:00 - 12:00
 * - afternoon: 12:00 - 17:00
 * - evening: 17:00 - 22:00
 * - night: 22:00 - 05:00
 */
export function getTimePhase(date: Date, timeZone: string): TimePhase {
  const hour = getHourInTz(date, timeZone);
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/**
 * Calculates the exact timestamp of the next time-phase boundary (transition)
 * after the given reference date in the specified time zone.
 */
export function getNextTimePhaseTransition(date: Date, timeZone: string): number {
  const hour = getHourInTz(date, timeZone);
  const boundaryHours = [5, 12, 17, 22];
  
  let nextBoundaryHour = boundaryHours.find((h) => h > hour);
  const dateMs = date.getTime();
  
  // If no later boundary today, the next one is 5:00 am tomorrow
  if (nextBoundaryHour === undefined) {
    const hoursUntilNextDay5am = (24 - hour) + 5;
    return dateMs + hoursUntilNextDay5am * 3600 * 1000;
  }
  
  const hoursUntil = nextBoundaryHour - hour;
  return dateMs + hoursUntil * 3600 * 1000;
}

export interface StaleCheckResult {
  isStale: boolean;
  reason?: string;
  nextInvalidationAt?: number;
}

// Global cache invalidation registry
type InvalidationListener = (ezzyId: string) => void;
const invalidationListeners: InvalidationListener[] = [];

export function registerInvalidationListener(listener: InvalidationListener): void {
  invalidationListeners.push(listener);
}

/**
 * Explicitly invalidates all cached evaluations and attention reviews for an Ezzy instance
 * upon any relevant data mutation (memories, calendar events, reminders, interactions, dismissals).
 */
export function invalidateEzzyCaches(ezzyId: string): void {
  const eid = (ezzyId || 'ezzy_default').trim();
  for (const listener of invalidationListeners) {
    try {
      listener(eid);
    } catch (err) {
      console.error('[Freshness] Invalidation listener error for', eid, err);
    }
  }
  console.log(`[Freshness] Caches invalidated for instance: ${eid}`);
}

/**
 * Checks whether an existing evaluation or attention review state is stale relative to
 * the current civil time, time phase boundaries, item expiration, or item eligibility.
 */
export function checkAttentionFreshness(params: {
  evaluation: ShadowEvaluationRecord | null;
  review: ShadowAttentionReviewRecord | null;
  clientNow?: string | Date;
  clientTimeZone?: string;
  forceRefresh?: boolean;
}): StaleCheckResult {
  const { evaluation, review, clientNow, clientTimeZone = 'Australia/Sydney', forceRefresh } = params;

  if (forceRefresh) {
    return { isStale: true, reason: 'explicit_force_refresh' };
  }

  if (!evaluation || !review) {
    return { isStale: true, reason: 'missing_record' };
  }

  const now = clientNow ? new Date(clientNow) : new Date();
  const nowMs = now.getTime();
  const timeZone = clientTimeZone;

  const evalDate = new Date(evaluation.timestamp);
  const evalMs = evalDate.getTime();
  const reviewDate = new Date(review.timestamp);
  const reviewMs = reviewDate.getTime();

  // 1. Calendar Day Boundary
  const nowYMD = getYMDInTz(now, timeZone);
  const evalYMD = getYMDInTz(evalDate, timeZone);
  if (nowYMD !== evalYMD) {
    return { isStale: true, reason: `day_boundary_transition (${evalYMD} -> ${nowYMD})` };
  }

  // 2. Civil Time-Phase Boundary (e.g. 4:55 pm afternoon vs 5:01 pm evening)
  const currentPhase = getTimePhase(now, timeZone);
  const evalPhase = getTimePhase(evalDate, timeZone);
  if (currentPhase !== evalPhase) {
    return {
      isStale: true,
      reason: `time_phase_transition (${evalPhase} -> ${currentPhase})`,
    };
  }

  // 3. Active Channel Item Expiration (expires_at)
  if (Array.isArray(review.active_channel)) {
    for (const item of review.active_channel) {
      if (item.expires_at) {
        const expiresMs = new Date(item.expires_at).getTime();
        if (!isNaN(expiresMs) && nowMs >= expiresMs && reviewMs < expiresMs) {
          return {
            isStale: true,
            reason: `active_item_expired (${item.headline || item.id} expired at ${item.expires_at})`,
          };
        }
      }
    }
  }

  // 4. Decision Communication Expiration
  const decComm = evaluation.new_ezzy_decision?.communication;
  if (decComm?.expiresAt) {
    const expMs = new Date(decComm.expiresAt).getTime();
    if (!isNaN(expMs) && nowMs >= expMs && evalMs < expMs) {
      return {
        isStale: true,
        reason: `decision_expired (${decComm.headline} expired at ${decComm.expiresAt})`,
      };
    }
  }

  // 5. Decision Communication Eligibility Window (eligible_at)
  if (decComm?.eligibleAt) {
    const eligMs = new Date(decComm.eligibleAt).getTime();
    if (!isNaN(eligMs) && nowMs >= eligMs && evalMs < eligMs) {
      return {
        isStale: true,
        reason: `decision_became_eligible (${decComm.headline} eligible at ${decComm.eligibleAt})`,
      };
    }
  }

  // 6. Next Invalidation Time calculation
  const nextPhaseMs = getNextTimePhaseTransition(now, timeZone);
  let nextInvalidationAt = nextPhaseMs;

  // Active items expires_at
  if (Array.isArray(review.active_channel)) {
    for (const item of review.active_channel) {
      if (item.expires_at) {
        const itemExpMs = new Date(item.expires_at).getTime();
        if (!isNaN(itemExpMs) && itemExpMs > nowMs && itemExpMs < nextInvalidationAt) {
          nextInvalidationAt = itemExpMs;
        }
      }
    }
  }

  // 7. Fallback safety maximum age: 4 hours
  const safetyMaxAgeMs = 4 * 3600 * 1000;
  const evalAge = nowMs - evalMs;
  const reviewAge = nowMs - reviewMs;
  if (evalAge > safetyMaxAgeMs || reviewAge > safetyMaxAgeMs) {
    return { isStale: true, reason: 'safety_max_age_exceeded' };
  }

  return { isStale: false, nextInvalidationAt };
}

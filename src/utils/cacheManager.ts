/**
 * Scoped, Isolated Client Cache Manager for Ezzymigo.
 * Enforces:
 * - Isolation by authenticated userId and ezzyId (My Ezzy vs Our Ezzy never share data)
 * - Safe rejection of expired or structurally incompatible entries
 * - Zero side effects on load
 * - Immediate invalidation upon mutation or account switching
 */

export interface CacheEnvelope<T> {
  version: number;
  userId: string;
  ezzyId: string;
  timestamp: number;
  data: T;
}

const CACHE_VERSION = 2;
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getScopedCacheKey(prefix: string, userId?: string | null, ezzyId?: string | null): string {
  const u = (userId || 'anon').trim();
  const e = (ezzyId || 'ezzy_default').trim();
  return `${prefix}_u_${u}_e_${e}`;
}

export function loadScopedCache<T>(
  prefix: string,
  userId?: string | null,
  ezzyId?: string | null,
  validator?: (data: any) => boolean
): T | null {
  try {
    const key = getScopedCacheKey(prefix, userId, ezzyId);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const envelope: CacheEnvelope<T> = JSON.parse(raw);
    if (!envelope || envelope.version !== CACHE_VERSION) {
      localStorage.removeItem(key);
      return null;
    }
    const currentUserId = (userId || 'anon').trim();
    const currentEzzyId = (ezzyId || 'ezzy_default').trim();
    if (envelope.userId !== currentUserId || envelope.ezzyId !== currentEzzyId) {
      return null; // Strict isolation!
    }
    if (Date.now() - envelope.timestamp > MAX_CACHE_AGE_MS) {
      localStorage.removeItem(key);
      return null;
    }
    if (validator && !validator(envelope.data)) {
      localStorage.removeItem(key);
      return null;
    }
    return envelope.data;
  } catch (err) {
    console.warn('[CacheManager] Failed to load cache safely:', err);
    return null;
  }
}

export function saveScopedCache<T>(
  prefix: string,
  userId: string | null | undefined,
  ezzyId: string | null | undefined,
  data: T
): void {
  try {
    const key = getScopedCacheKey(prefix, userId, ezzyId);
    const envelope: CacheEnvelope<T> = {
      version: CACHE_VERSION,
      userId: (userId || 'anon').trim(),
      ezzyId: (ezzyId || 'ezzy_default').trim(),
      timestamp: Date.now(),
      data,
    };
    localStorage.setItem(key, JSON.stringify(envelope));
  } catch (err) {
    console.warn('[CacheManager] Failed to persist cache:', err);
  }
}

export function removeScopedCache(
  prefix: string,
  userId?: string | null,
  ezzyId?: string | null
): void {
  try {
    const key = getScopedCacheKey(prefix, userId, ezzyId);
    localStorage.removeItem(key);
  } catch (err) {
    console.warn('[CacheManager] Failed to remove scoped cache:', err);
  }
}

export function clearUserScopedCaches(userId?: string | null): void {
  try {
    const u = (userId || 'anon').trim();
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.includes(`_u_${u}_`) || key.startsWith('ezzymigo_cached_'))) {
        keysToRemove.push(key);
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
  } catch (err) {
    console.warn('[CacheManager] Failed to clear user caches:', err);
  }
}

import { executeBunnySql } from '../db/client';
import { initBunnyDb } from '../db/schema';
import { DEFAULT_EZZY_ID } from '../instances/entitlements';
import { invalidateEzzyCaches } from './freshness';

export interface DismissalRecord {
  id: string;
  ezzyId: string;
  communicationId: string;
  reason?: string;
  dismissedAt: string;
  ttlHours?: number;
}

export async function recordShadowDismissal(params: {
  ezzyId?: string;
  communicationId: string;
  reason?: string;
  ttlHours?: number;
}): Promise<string> {
  const eid = (params.ezzyId || DEFAULT_EZZY_ID).trim();
  await initBunnyDb();

  const id = `dismiss_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const nowIso = new Date().toISOString();
  const ttl = typeof params.ttlHours === 'number' && params.ttlHours > 0 ? params.ttlHours : 48;

  try {
    await executeBunnySql([
      {
        sql: `INSERT INTO shadow_dismissals (id, ezzy_id, communication_id, reason, dismissed_at, ttl_hours)
              VALUES (?, ?, ?, ?, ?, ?);`,
        args: [id, eid, params.communicationId, params.reason || null, nowIso, ttl],
      },
    ]);
    console.log(`[Dismissal] Recorded dismissal ${id} (ttl ${ttl}h) for comm ${params.communicationId} in ${eid}`);
    invalidateEzzyCaches(eid);
  } catch (err) {
    console.error('[Dismissal] Failed to record dismissal:', err);
  }

  return id;
}

export async function getRecentDismissals(
  ezzyId: string = DEFAULT_EZZY_ID,
  referenceNow?: string
): Promise<Array<{ communicationId: string; dismissedAt: string; ttlHours?: number; reason?: string }>> {
  const eid = ezzyId.trim();
  await initBunnyDb();

  const nowMs = referenceNow ? new Date(referenceNow).getTime() : Date.now();

  try {
    const res = await executeBunnySql([
      {
        sql: `SELECT communication_id, reason, dismissed_at, ttl_hours
              FROM shadow_dismissals
              WHERE ezzy_id = ?
              ORDER BY dismissed_at DESC;`,
        args: [eid],
      },
    ]);

    const rows = res[0]?.rows || [];
    return rows
      .filter((r: any) => {
        const dismissedMs = new Date(r.dismissed_at).getTime();
        if (isNaN(dismissedMs)) return false;
        const ttl = typeof r.ttl_hours === 'number' && r.ttl_hours > 0 ? r.ttl_hours : 48;
        const expiryMs = dismissedMs + ttl * 3600 * 1000;
        return nowMs < expiryMs;
      })
      .map((r: any) => ({
        communicationId: r.communication_id,
        dismissedAt: r.dismissed_at,
        ttlHours: r.ttl_hours || 48,
        reason: r.reason || undefined,
      }));
  } catch (err) {
    console.error('[Dismissal] Error fetching dismissals:', err);
    return [];
  }
}

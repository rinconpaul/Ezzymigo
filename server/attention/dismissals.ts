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
}

export async function recordShadowDismissal(params: {
  ezzyId?: string;
  communicationId: string;
  reason?: string;
}): Promise<string> {
  const eid = (params.ezzyId || DEFAULT_EZZY_ID).trim();
  await initBunnyDb();

  const id = `dismiss_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const nowIso = new Date().toISOString();

  try {
    await executeBunnySql([
      {
        sql: `INSERT INTO shadow_dismissals (id, ezzy_id, communication_id, reason, dismissed_at)
              VALUES (?, ?, ?, ?, ?);`,
        args: [id, eid, params.communicationId, params.reason || null, nowIso],
      },
    ]);
    console.log(`[Dismissal] Recorded dismissal ${id} for comm ${params.communicationId} in ${eid}`);
    invalidateEzzyCaches(eid);
  } catch (err) {
    console.error('[Dismissal] Failed to record dismissal:', err);
  }

  return id;
}

export async function getRecentDismissals(
  ezzyId: string = DEFAULT_EZZY_ID,
  hoursWindow: number = 48
): Promise<Array<{ communicationId: string; dismissedAt: string; reason?: string }>> {
  const eid = ezzyId.trim();
  await initBunnyDb();

  const windowStartIso = new Date(Date.now() - hoursWindow * 3600 * 1000).toISOString();

  try {
    const res = await executeBunnySql([
      {
        sql: `SELECT communication_id, reason, dismissed_at
              FROM shadow_dismissals
              WHERE ezzy_id = ? AND dismissed_at >= ?
              ORDER BY dismissed_at DESC;`,
        args: [eid, windowStartIso],
      },
    ]);

    const rows = res[0]?.rows || [];
    return rows.map((r: any) => ({
      communicationId: r.communication_id,
      dismissedAt: r.dismissed_at,
      reason: r.reason || undefined,
    }));
  } catch (err) {
    console.error('[Dismissal] Error fetching dismissals:', err);
    return [];
  }
}

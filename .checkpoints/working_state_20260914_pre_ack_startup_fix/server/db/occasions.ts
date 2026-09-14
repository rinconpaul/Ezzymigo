import { executeBunnySql } from './client';
import { initBunnyDb } from './schema';
import { EzzyOccasionPreferences, UserOccasionPreferences } from '../../src/types';
import { getDefaultOccasionPreferences } from '../../src/data/occasionsCatalog';
import { DEFAULT_EZZY_ID, assertEzzyAccess } from '../instances/entitlements';

export const DEFAULT_USER_ID = DEFAULT_EZZY_ID;

/**
 * Retrieves the persistent occasion preferences for the specified Ezzy instance.
 * Occasion preferences are Ezzy-instance-level configuration, not individual-user preferences.
 * Falls back to default regional preferences (Australia — ACT) if none stored yet.
 */
export async function getEzzyOccasionPreferences(
  ezzyId = DEFAULT_EZZY_ID,
  userId?: string
): Promise<EzzyOccasionPreferences> {
  await initBunnyDb();
  const eid = (ezzyId || DEFAULT_EZZY_ID).trim();

  if (userId) {
    await assertEzzyAccess(eid, userId, 'read');
  }

  try {
    const results = await executeBunnySql([
      {
        sql: `SELECT ezzy_id, country, subdivision, selected_traditions, occasions_json, updated_at
              FROM ezzy_occasion_preferences
              WHERE ezzy_id = ? LIMIT 1;`,
        args: [eid],
      },
    ]);

    const row = results[0]?.rows?.[0];
    if (!row) {
      const defaultPrefs = getDefaultOccasionPreferences('AU', 'ACT');
      return {
        ezzyId: eid,
        ...defaultPrefs,
      };
    }

    const country = row.country ? String(row.country) : 'AU';
    const subdivision = row.subdivision ? String(row.subdivision) : undefined;
    const rawTraditions = row.selected_traditions ? String(row.selected_traditions) : '[]';
    const rawOccasions = row.occasions_json ? String(row.occasions_json) : '{}';
    const updatedAt = row.updated_at ? String(row.updated_at) : new Date().toISOString();

    let selectedTraditions: string[] = [];
    try {
      const parsed = JSON.parse(rawTraditions);
      if (Array.isArray(parsed)) {
        selectedTraditions = parsed.map(String);
      }
    } catch {
      selectedTraditions = [];
    }

    let occasions: Record<string, boolean> = {};
    try {
      const parsed = JSON.parse(rawOccasions);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          occasions[k] = Boolean(v);
        }
      }
    } catch {
      occasions = {};
    }

    return {
      ezzyId: eid,
      country,
      subdivision,
      selectedTraditions,
      occasions,
      updatedAt,
    };
  } catch (err) {
    console.error('[Occasions DB] Error reading occasion preferences for Ezzy:', eid, err);
    const defaultPrefs = getDefaultOccasionPreferences('AU', 'ACT');
    return {
      ezzyId: eid,
      ...defaultPrefs,
    };
  }
}

/**
 * Persists occasion preferences for an Ezzy instance to Bunny DB.
 */
export async function saveEzzyOccasionPreferences(
  prefs: Partial<EzzyOccasionPreferences>,
  ezzyId = DEFAULT_EZZY_ID,
  userId?: string
): Promise<EzzyOccasionPreferences> {
  await initBunnyDb();
  const eid = (ezzyId || DEFAULT_EZZY_ID).trim();

  if (userId) {
    await assertEzzyAccess(eid, userId, 'write');
  }

  const current = await getEzzyOccasionPreferences(eid);
  const country = (prefs.country !== undefined ? prefs.country : current.country) || 'AU';
  const subdivision = prefs.subdivision !== undefined ? prefs.subdivision : current.subdivision;
  const selectedTraditions = Array.isArray(prefs.selectedTraditions)
    ? prefs.selectedTraditions
    : current.selectedTraditions;
  const occasions = prefs.occasions !== undefined ? { ...prefs.occasions } : { ...current.occasions };
  const updatedAt = new Date().toISOString();

  await executeBunnySql([
    {
      sql: `INSERT INTO ezzy_occasion_preferences (ezzy_id, country, subdivision, selected_traditions, occasions_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ezzy_id) DO UPDATE SET
              country = excluded.country,
              subdivision = excluded.subdivision,
              selected_traditions = excluded.selected_traditions,
              occasions_json = excluded.occasions_json,
              updated_at = excluded.updated_at;`,
      args: [
        eid,
        country,
        subdivision || null,
        JSON.stringify(selectedTraditions),
        JSON.stringify(occasions),
        updatedAt,
      ],
    },
  ]);

  return {
    ezzyId: eid,
    country,
    subdivision,
    selectedTraditions,
    occasions,
    updatedAt,
  };
}

/**
 * Deletes isolated test occasion preferences from Bunny DB.
 * Guaranteed to refuse deletion of protected default instance record.
 */
export async function deleteEzzyOccasionPreferences(ezzyId: string, userId?: string): Promise<void> {
  const eid = (ezzyId || '').trim();
  if (!eid || eid === DEFAULT_EZZY_ID) {
    throw new Error(`[PRODUCTION DATA GUARD] Cannot delete protected Ezzy instance '${DEFAULT_EZZY_ID}'.`);
  }
  if (userId) {
    await assertEzzyAccess(eid, userId, 'write');
  }
  await executeBunnySql([
    {
      sql: `DELETE FROM ezzy_occasion_preferences WHERE ezzy_id = ?;`,
      args: [eid],
    },
  ]);
}

// Backwards-compatible aliases for existing callers
export const getUserOccasionPreferences = getEzzyOccasionPreferences;
export const saveUserOccasionPreferences = saveEzzyOccasionPreferences;
export const deleteUserOccasionPreferences = deleteEzzyOccasionPreferences;

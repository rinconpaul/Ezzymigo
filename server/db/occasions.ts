import { executeBunnySql } from './client';
import { initBunnyDb } from './schema';
import { UserOccasionPreferences } from '../../src/types';
import { getDefaultOccasionPreferences } from '../../src/data/occasionsCatalog';

export const DEFAULT_USER_ID = 'default_user';

/**
 * Retrieves the persistent occasion preferences for the user.
 * Falls back to default regional preferences (Australia — ACT) if none stored yet.
 */
export async function getUserOccasionPreferences(userId = DEFAULT_USER_ID): Promise<UserOccasionPreferences> {
  await initBunnyDb();

  try {
    const results = await executeBunnySql([
      {
        sql: `SELECT id, country, subdivision, selected_traditions, occasions_json, updated_at
              FROM user_occasion_preferences
              WHERE id = ? LIMIT 1;`,
        args: [userId],
      },
    ]);

    const row = results[0]?.rows?.[0];
    if (!row) {
      return getDefaultOccasionPreferences('AU', 'ACT');
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
      country,
      subdivision,
      selectedTraditions,
      occasions,
      updatedAt,
    };
  } catch (err) {
    console.error('[Occasions DB] Error reading user occasion preferences:', err);
    return getDefaultOccasionPreferences('AU', 'ACT');
  }
}

/**
 * Persists the user's occasion preferences to Bunny DB.
 */
export async function saveUserOccasionPreferences(
  prefs: Partial<UserOccasionPreferences>,
  userId = DEFAULT_USER_ID
): Promise<UserOccasionPreferences> {
  await initBunnyDb();

  const current = await getUserOccasionPreferences(userId);
  const country = (prefs.country !== undefined ? prefs.country : current.country) || 'AU';
  const subdivision = prefs.subdivision !== undefined ? prefs.subdivision : current.subdivision;
  const selectedTraditions = Array.isArray(prefs.selectedTraditions)
    ? prefs.selectedTraditions
    : current.selectedTraditions;
  const occasions = prefs.occasions !== undefined ? { ...prefs.occasions } : { ...current.occasions };
  const updatedAt = new Date().toISOString();

  await executeBunnySql([
    {
      sql: `INSERT INTO user_occasion_preferences (id, country, subdivision, selected_traditions, occasions_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              country = excluded.country,
              subdivision = excluded.subdivision,
              selected_traditions = excluded.selected_traditions,
              occasions_json = excluded.occasions_json,
              updated_at = excluded.updated_at;`,
      args: [
        userId,
        country,
        subdivision || null,
        JSON.stringify(selectedTraditions),
        JSON.stringify(occasions),
        updatedAt,
      ],
    },
  ]);

  return {
    country,
    subdivision,
    selectedTraditions,
    occasions,
    updatedAt,
  };
}

/**
 * Deletes isolated test user preferences from Bunny DB.
 * Guaranteed to refuse deletion of protected default_user record.
 */
export async function deleteUserOccasionPreferences(userId: string): Promise<void> {
  if (!userId || userId === DEFAULT_USER_ID) {
    throw new Error(`[PRODUCTION DATA GUARD] Cannot delete protected user '${DEFAULT_USER_ID}'.`);
  }
  await executeBunnySql([
    {
      sql: `DELETE FROM user_occasion_preferences WHERE id = ?;`,
      args: [userId],
    },
  ]);
}

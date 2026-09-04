import { getUserOccasionPreferences } from '../db/occasions';
import { CATALOG_OCCASIONS, getRegionalOccasions, getTraditionOccasions } from '../../src/data/occasionsCatalog';
import { CatalogOccasion, OccasionOccurrence, UserOccasionPreferences } from '../../src/types';
import { resolveOccasionOccurrencesForWindow, addDays, formatYMD } from './dateResolver';

/**
 * Retrieves the catalog occasions that the user has selected or enabled.
 */
export async function getUserSelectedCatalogOccasions(): Promise<{
  occasions: CatalogOccasion[];
  preferences: UserOccasionPreferences;
}> {
  const prefs = await getUserOccasionPreferences();
  const country = (prefs.country || 'AU').toUpperCase();
  const subdivision = prefs.subdivision ? prefs.subdivision.toUpperCase() : undefined;

  // 1. Regional popular occasions for user's region
  const regionalOccasions = getRegionalOccasions(country, subdivision);

  // 2. Tradition occasions for user's selected traditions
  const traditionOccasions: CatalogOccasion[] = [];
  if (Array.isArray(prefs.selectedTraditions)) {
    for (const tradId of prefs.selectedTraditions) {
      const items = getTraditionOccasions(tradId);
      traditionOccasions.push(...items);
    }
  }

  // Combine and deduplicate
  const allEligible = [...regionalOccasions, ...traditionOccasions];
  const uniqueMap = new Map<string, CatalogOccasion>();
  for (const item of allEligible) {
    uniqueMap.set(item.id, item);
  }

  // Filter based on explicit user toggle in prefs.occasions
  // If an occasion is in prefs.occasions and set to false, it is excluded.
  // If not explicitly false, it is included if it was part of selected region or tradition.
  const activeOccasions: CatalogOccasion[] = [];
  for (const [id, occasion] of uniqueMap.entries()) {
    const isExplicitlyDisabled = prefs.occasions?.[id] === false;
    const isExplicitlyEnabled = prefs.occasions?.[id] === true;

    // For regional: enabled by default unless explicitly false
    // For traditions: enabled if tradition is selected unless explicitly false
    if (!isExplicitlyDisabled) {
      activeOccasions.push(occasion);
    }
  }

  return { occasions: activeOccasions, preferences: prefs };
}

/**
 * Resolves all active occurrences for the user's selected occasions in a rolling window around referenceDate.
 * Default window: 14 days in the past (for reflection on recent occasions) to 60 days in the future.
 */
export async function getActiveUserOccasionOccurrences(
  referenceDate: Date,
  timeZone = 'Australia/Sydney',
  windowPastDays = 14,
  windowFutureDays = 60
): Promise<OccasionOccurrence[]> {
  const { occasions, preferences } = await getUserSelectedCatalogOccasions();

  // Compute window boundaries YYYY-MM-DD in user's timeZone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayYMD = formatter.format(referenceDate);

  const windowStart = addDays(todayYMD, -windowPastDays);
  const windowEnd = addDays(todayYMD, windowFutureDays);

  const allOccurrences: OccasionOccurrence[] = [];

  for (const occasion of occasions) {
    try {
      const occs = await resolveOccasionOccurrencesForWindow(
        occasion,
        windowStart,
        windowEnd,
        preferences.country,
        preferences.subdivision
      );
      allOccurrences.push(...occs);
    } catch (err) {
      console.error(`[OccasionManager] Error resolving occurrences for ${occasion.id}:`, err);
    }
  }

  // Sort by startDate
  allOccurrences.sort((a, b) => a.startDate.localeCompare(b.startDate));

  return allOccurrences;
}

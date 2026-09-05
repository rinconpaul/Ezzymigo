import { getEzzyOccasionPreferences } from '../db/occasions';
import { CATALOG_OCCASIONS, getRegionalOccasions, getTraditionOccasions } from '../../src/data/occasionsCatalog';
import { CatalogOccasion, OccasionOccurrence, EzzyOccasionPreferences, UserOccasionPreferences } from '../../src/types';
import { resolveOccasionOccurrencesForWindow, addDays, formatYMD } from './dateResolver';

/**
 * Retrieves the catalog occasions that the specified Ezzy instance has selected or enabled.
 */
export async function getEzzySelectedCatalogOccasions(ezzyId?: string): Promise<{
  occasions: CatalogOccasion[];
  preferences: EzzyOccasionPreferences;
}> {
  const prefs = await getEzzyOccasionPreferences(ezzyId || undefined);
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

  // Filter based on explicit toggle in prefs.occasions
  const activeOccasions: CatalogOccasion[] = [];
  for (const [id, occasion] of uniqueMap.entries()) {
    const isExplicitlyDisabled = prefs.occasions?.[id] === false;

    if (!isExplicitlyDisabled) {
      activeOccasions.push(occasion);
    }
  }

  return { occasions: activeOccasions, preferences: prefs };
}

export const getUserSelectedCatalogOccasions = getEzzySelectedCatalogOccasions;

/**
 * Resolves all active occurrences for an Ezzy's selected occasions in a rolling window around referenceDate.
 * Default window: 14 days in the past (for reflection on recent occasions) to 60 days in the future.
 */
export async function getActiveEzzyOccasionOccurrences(
  referenceDate: Date,
  timeZone = 'Australia/Sydney',
  windowPastDays = 14,
  windowFutureDays = 60,
  ezzyId?: string
): Promise<OccasionOccurrence[]> {
  const { occasions, preferences } = await getEzzySelectedCatalogOccasions(ezzyId);

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

export const getActiveUserOccasionOccurrences = getActiveEzzyOccasionOccurrences;

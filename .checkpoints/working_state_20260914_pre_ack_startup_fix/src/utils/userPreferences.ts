import { UserPreferences, I18nContextPayload } from '../types';

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  language: 'en-AU',
  region: 'AU',
  timezone: 'Australia/Sydney',
  currency: 'AUD',
};

const STORAGE_KEY = 'ezzymigo_user_preferences';

/**
 * Retrieves the current central user preferences.
 * Reads from localStorage if persisted, otherwise returns defaults.
 */
export function getUserPreferences(): UserPreferences {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_USER_PREFERENCES };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        language: parsed.language || DEFAULT_USER_PREFERENCES.language,
        region: parsed.region || DEFAULT_USER_PREFERENCES.region,
        timezone: parsed.timezone || DEFAULT_USER_PREFERENCES.timezone,
        currency: parsed.currency || DEFAULT_USER_PREFERENCES.currency,
      };
    }
  } catch (err) {
    console.warn('[i18n] Error reading user preferences from storage:', err);
  }

  return { ...DEFAULT_USER_PREFERENCES };
}

/**
 * Updates and persists user preferences in localStorage.
 */
export function setUserPreferences(updates: Partial<UserPreferences>): UserPreferences {
  const current = getUserPreferences();
  const next: UserPreferences = {
    ...current,
    ...updates,
  };

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      console.warn('[i18n] Error persisting user preferences to storage:', err);
    }
  }

  return next;
}

/**
 * Builds the standard i18n payload to send with API requests.
 */
export function getI18nPayload(prefs?: UserPreferences): I18nContextPayload {
  const currentPrefs = prefs || getUserPreferences();
  return {
    language: currentPrefs.language,
    region: currentPrefs.region,
    timezone: currentPrefs.timezone,
    currency: currentPrefs.currency,
    now: new Date().toISOString(),
  };
}

/**
 * Formats a date/time timestamp according to the user's preferred locale and timezone.
 * Machine-readable timestamps (ISO-8601) are preserved for storage; this helper is strictly for display.
 */
export function formatDateTime(
  dateInput: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
  prefs?: UserPreferences
): string {
  try {
    const date = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
    if (isNaN(date.getTime())) {
      return String(dateInput);
    }

    const currentPrefs = prefs || getUserPreferences();
    const defaultOptions: Intl.DateTimeFormatOptions = {
      timeZone: currentPrefs.timezone || 'Australia/Sydney',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...options,
    };

    return new Intl.DateTimeFormat(currentPrefs.language || 'en-AU', defaultOptions).format(date);
  } catch (err) {
    console.warn('[i18n] Error formatting date with user preferences:', err);
    return new Date(dateInput).toLocaleString();
  }
}

/**
 * Formats a monetary amount according to the user's preferred locale and currency code (ISO 4217).
 */
export function formatCurrency(
  amount: number,
  prefs?: UserPreferences,
  options?: Intl.NumberFormatOptions
): string {
  try {
    const currentPrefs = prefs || getUserPreferences();
    return new Intl.NumberFormat(currentPrefs.language || 'en-AU', {
      style: 'currency',
      currency: currentPrefs.currency || 'AUD',
      ...options,
    }).format(amount);
  } catch (err) {
    console.warn('[i18n] Error formatting currency:', err);
    return `$${amount.toFixed(2)}`;
  }
}

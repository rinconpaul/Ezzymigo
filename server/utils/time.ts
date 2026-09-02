// Format local time & i18n context for LLM prompt
export function formatLocalTimeContext(
  clientNow?: string,
  clientTimeZone?: string,
  clientLanguage?: string,
  clientRegion?: string
) {
  const date = clientNow ? new Date(clientNow) : new Date();
  const timeZone = clientTimeZone || 'Australia/Sydney';
  const language = clientLanguage || 'en-AU';
  const region = clientRegion || 'AU';

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
      timeZoneName: 'longOffset'
    });

    const parts = formatter.formatToParts(date);
    const getPart = (type: string) => parts.find(p => p.type === type)?.value || '';

    const weekday = getPart('weekday');
    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hour = getPart('hour');
    const minute = getPart('minute');
    const second = getPart('second');
    const tzPart = getPart('timeZoneName');

    let offsetStr = '+00:00';
    if (tzPart) {
      const match = tzPart.match(/GMT([+-]\d{1,2}(?::\d{2})?)/);
      if (match) {
        let off = match[1];
        if (!off.includes(':')) off = off + ':00';
        if (off.length === 5) off = off[0] + '0' + off.slice(1);
        offsetStr = off;
      }
    }

    return {
      referenceDate: date,
      timeZone,
      language,
      region,
      weekday,
      offsetStr,
      localDateTimeStr: `${weekday}, ${day} ${month} ${year} at ${hour}:${minute}:${second} (${timeZone}, UTC${offsetStr})`,
      utcIso: date.toISOString(),
    };
  } catch (err) {
    return {
      referenceDate: date,
      timeZone: 'Australia/Sydney',
      language: 'en-AU',
      region: 'AU',
      weekday: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getUTCDay()],
      offsetStr: '+10:00',
      localDateTimeStr: date.toUTCString(),
      utcIso: date.toISOString(),
    };
  }
}

// Convert any ISO timestamp into user's localized human date/time string
export function formatIsoToLocal(isoString: string | null | undefined, timeZone: string = 'Australia/Sydney', language: string = 'en-AU'): string | null {
  if (!isoString) return null;
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat(language || 'en-AU', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(d);
  } catch {
    return null;
  }
}

// Helper to format Date to YYYY-MM-DD in client's timezone
export function getYMDInTz(d: Date, tz: string = 'Australia/Sydney'): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(d);
  } catch {
    return d.toISOString().split('T')[0];
  }
}

// Helper to shift a YYYY-MM-DD date string by a given number of days in UTC math (safe from DST shifts)
export function getRelativeYMD(baseYMD: string, dayOffset: number): string {
  const [y, m, d] = baseYMD.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + dayOffset));
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper to get lowercase weekday name ('sunday'..'saturday') for a YYYY-MM-DD string
export function getWeekdayFromYMD(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return weekdays[date.getUTCDay()];
}

// Helper to extract time string in client's timezone
export function getTimeStrInTz(d: Date, tz: string = 'Australia/Sydney', language: string = 'en-AU'): string {
  try {
    return d.toLocaleTimeString(language || 'en-AU', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

// Helper to parse time strings like "9am", "9:30pm", "16:00", "5:51am"
export function parseTimeStringToHM(timeStr: string): { hour: number; minute: number } | null {
  if (!timeStr) return null;
  const cleaned = timeStr.trim().toLowerCase();
  const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];

  if (meridiem === 'pm') {
    if (hour < 12) hour += 12;
  } else if (meridiem === 'am') {
    if (hour === 12) hour = 0;
  } else {
    // No explicit am/pm: Bare 1-12 clock hours without meridiem are ambiguous and must NOT silently resolve
    if (hour >= 1 && hour <= 12) {
      return null;
    }
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { hour, minute };
}

export interface ParsedNumericDate {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  isoDate: string; // YYYY-MM-DD
  isAmbiguous: boolean;
  confidence: 'explicit' | 'locale_resolved' | 'unambiguous_value' | 'ambiguous';
}

/**
 * Locale-sensitive numeric date parser.
 * Handles D/M/Y (AU, UK, Europe), M/D/Y (US), and Y/M/D (ISO/East Asia).
 * When values exceed 12 (e.g. 25/8/2026), it resolves unambiguously regardless of locale.
 * If values are <= 12 and no locale is provided, it marks the date as ambiguous.
 */
export function parseNumericDateWithLocale(
  dateStr: string,
  locale?: string,
  region?: string,
  referenceYear: number = 2026
): ParsedNumericDate | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();

  // Pattern 1: YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  const ymdMatch = trimmed.match(/^(\d{4})[./\-](\d{1,2})[./\-](\d{1,2})$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10);
    const day = parseInt(ymdMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { year, month, day, isoDate, isAmbiguous: false, confidence: 'explicit' };
    }
  }

  // Pattern 2: D/M/Y or M/D/Y (e.g. 3/9/2026 or 03/09/2026 or 3-9-2026 or 3.9.2026)
  const dmyOrMdyMatch = trimmed.match(/^(\d{1,2})[./\-](\d{1,2})(?:[./\-](\d{2,4}))?$/);
  if (dmyOrMdyMatch) {
    const p1 = parseInt(dmyOrMdyMatch[1], 10);
    const p2 = parseInt(dmyOrMdyMatch[2], 10);
    let year = dmyOrMdyMatch[3] ? parseInt(dmyOrMdyMatch[3], 10) : referenceYear;
    if (year < 100) year += 2000;

    // Case A: p1 > 12 -> p1 MUST be day, p2 is month (e.g. 25/8/2026)
    if (p1 > 12 && p1 <= 31 && p2 >= 1 && p2 <= 12) {
      const isoDate = `${year}-${String(p2).padStart(2, '0')}-${String(p1).padStart(2, '0')}`;
      return { year, month: p2, day: p1, isoDate, isAmbiguous: false, confidence: 'unambiguous_value' };
    }

    // Case B: p2 > 12 -> p2 MUST be day, p1 is month (e.g. 8/25/2026)
    if (p2 > 12 && p2 <= 31 && p1 >= 1 && p1 <= 12) {
      const isoDate = `${year}-${String(p1).padStart(2, '0')}-${String(p2).padStart(2, '0')}`;
      return { year, month: p1, day: p2, isoDate, isAmbiguous: false, confidence: 'unambiguous_value' };
    }

    // Case C: Both p1 <= 12 and p2 <= 12 (e.g. 3/9/2026) -> strictly locale-sensitive
    if (p1 >= 1 && p1 <= 12 && p2 >= 1 && p2 <= 12) {
      const loc = (locale || '').toLowerCase();
      const reg = (region || '').toUpperCase();

      const isUS = loc.includes('en-us') || loc === 'us' || reg === 'US';
      const isDmyLocale = loc.includes('en-au') || loc.includes('en-gb') || loc.includes('en-nz') ||
                          loc.startsWith('fr') || loc.startsWith('de') || loc.startsWith('es') ||
                          loc.startsWith('it') || loc.startsWith('pt') || loc.startsWith('nl') ||
                          reg === 'AU' || reg === 'GB' || reg === 'NZ' || reg === 'FR' || reg === 'DE' ||
                          reg === 'ES' || reg === 'IT' || reg === 'PT';

      if (isUS) {
        // MDY: p1 is month, p2 is day
        const isoDate = `${year}-${String(p1).padStart(2, '0')}-${String(p2).padStart(2, '0')}`;
        return { year, month: p1, day: p2, isoDate, isAmbiguous: false, confidence: 'locale_resolved' };
      } else if (isDmyLocale || !loc) {
        // DMY default for Australia / UK / International: p1 is day, p2 is month
        const isoDate = `${year}-${String(p2).padStart(2, '0')}-${String(p1).padStart(2, '0')}`;
        return { year, month: p2, day: p1, isoDate, isAmbiguous: false, confidence: 'locale_resolved' };
      } else {
        // Genuinely ambiguous
        const isoDate = `${year}-${String(p2).padStart(2, '0')}-${String(p1).padStart(2, '0')}`;
        return { year, month: p2, day: p1, isoDate, isAmbiguous: true, confidence: 'ambiguous' };
      }
    }
  }

  return null;
}

// Multilingual month dictionary mapping for semantic month interpretation
const MULTILINGUAL_MONTHS: { [key: string]: number } = {
  // English
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  // French
  janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
  juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10, décembre: 11, decembre: 11,
  // Spanish
  enero: 0, setiembre: 8,
  // German
  januar: 0, jänner: 0, jaenner: 0, feber: 1, märz: 2, maerz: 2, dezember: 11,
  // Italian
  gennaio: 0,
  // Portuguese
  janeiro: 0, marco: 2, março: 2, julho: 6, dezembro: 11,
};

// Reminder Trigger Timestamp Parser (legacy fallback & month recognition)
export function parseReminderTriggerTime(text: string, timing: string = '', now: Date = new Date()): string | null {
  const combined = `${text} ${timing}`.toLowerCase();

  // "in X minutes / mins / min / m"
  const inMinMatch = combined.match(/\b(?:in|dans|en)\s+(\d+)\s*(?:minutes?|mins?|min|m|minutos?|minuten?)\b/i);
  if (inMinMatch) {
    const mins = parseInt(inMinMatch[1], 10);
    if (!isNaN(mins) && mins > 0) {
      return new Date(now.getTime() + mins * 60 * 1000).toISOString();
    }
  }

  // "in X seconds / secs / s"
  const inSecMatch = combined.match(/\b(?:in|dans|en)\s+(\d+)\s*(?:seconds?|secs?|s|segundos?|sekunden?)\b/i);
  if (inSecMatch) {
    const secs = parseInt(inSecMatch[1], 10);
    if (!isNaN(secs) && secs > 0) {
      return new Date(now.getTime() + secs * 1000).toISOString();
    }
  }

  // "in X hours / hrs / hr / h"
  const inHourMatch = combined.match(/\b(?:in|dans|en)\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr|h|heures?|horas?|stunden?)\b/i);
  if (inHourMatch) {
    const hrs = parseFloat(inHourMatch[1]);
    if (!isNaN(hrs) && hrs > 0) {
      return new Date(now.getTime() + Math.round(hrs * 60 * 60 * 1000)).toISOString();
    }
  }

  // "in X days"
  const inDayMatch = combined.match(/\b(?:in|dans|en)\s+(\d+)\s*(?:days?|d|jours?|días?|dias?|tagen?)\b/i);
  if (inDayMatch) {
    const days = parseInt(inDayMatch[1], 10);
    if (!isNaN(days) && days > 0) {
      return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  // "in X months"
  const inMonthMatch = combined.match(/\b(?:in|dans|en)\s+(\d+)\s*(?:months?|mths?|mth|mo|mois|meses|monaten?)\b/i);
  if (inMonthMatch) {
    const months = parseInt(inMonthMatch[1], 10);
    if (!isNaN(months) && months > 0) {
      const d = new Date(now);
      d.setMonth(d.getMonth() + months);
      return d.toISOString();
    }
  }

  // Multilingual Month-name expression: e.g. "in September", "en septembre", "en septiembre", "im September", "in settembre", "em setembro"
  const monthNamesPattern = Object.keys(MULTILINGUAL_MONTHS).join('|');
  const monthRegex = new RegExp(`\\b(?:in\\s+|en\\s+|im\\s+|em\\s+)?(${monthNamesPattern})\\b`, 'i');
  const monthMatch = combined.match(monthRegex);
  if (monthMatch) {
    const matchedStr = monthMatch[1].toLowerCase();
    const targetMonthIdx = MULTILINGUAL_MONTHS[matchedStr];
    if (targetMonthIdx !== undefined) {
      const targetDate = new Date(now);
      const currentMonthIdx = now.getMonth();
      const currentYear = now.getFullYear();
      let targetYear = currentYear;
      // If the target month has already passed in current year, target next year
      if (targetMonthIdx < currentMonthIdx) {
        targetYear += 1;
      }
      targetDate.setFullYear(targetYear, targetMonthIdx, 1);
      targetDate.setHours(9, 0, 0, 0);
      return targetDate.toISOString();
    }
  }

  // Specific ISO string inside timing
  if (timing && !isNaN(Date.parse(timing))) {
    const parsed = new Date(timing);
    if (parsed.getTime() > now.getTime()) {
      return parsed.toISOString();
    }
  }

  return null;
}

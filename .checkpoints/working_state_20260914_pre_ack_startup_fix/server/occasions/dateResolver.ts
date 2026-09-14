import {
  CatalogOccasion,
  OccasionDateRule,
  OccasionOccurrence,
} from '../../src/types';

// ============================================================================
// DYNAMIC MODULE LOADERS (Supports both ESM & CJS runtime environments)
// ============================================================================

let hebcalModule: any = null;
async function getHebcal() {
  if (!hebcalModule) {
    hebcalModule = await import('@hebcal/core');
  }
  return hebcalModule;
}

let hijriModule: any = null;
async function getHijri() {
  if (!hijriModule) {
    hijriModule = await import('@tabby_ai/hijri-converter');
  }
  return hijriModule;
}

let lunarModule: any = null;
async function getLunar() {
  if (!lunarModule) {
    lunarModule = await import('lunar-javascript');
  }
  return lunarModule;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatYMD(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return formatYMD(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function daysBetween(ymd1: string, ymd2: string): number {
  const [y1, m1, d1] = ymd1.split('-').map(Number);
  const [y2, m2, d2] = ymd2.split('-').map(Number);
  const dt1 = Date.UTC(y1, m1 - 1, d1);
  const dt2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((dt2 - dt1) / (24 * 60 * 60 * 1000));
}

// ============================================================================
// 1. NTH WEEKDAY OF MONTH RESOLVER
// ============================================================================

/**
 * Resolves the Nth weekday of a given month in a year.
 * @param year e.g. 2026
 * @param month 1-12 (1 = January, 9 = September)
 * @param nth 1-5 (e.g. 1 for first Sunday, 2 for second Sunday)
 * @param weekday 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
 */
export function resolveNthWeekdayOfMonth(
  year: number,
  month: number,
  nth: number,
  weekday: number
): string {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const firstDayOfWeek = firstDay.getUTCDay();
  const offset = (weekday - firstDayOfWeek + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;

  // Verify within month days
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > lastDay) {
    throw new Error(`Invalid Nth weekday: ${nth}th weekday ${weekday} does not exist in month ${month} of ${year}`);
  }

  return formatYMD(year, month, day);
}

// ============================================================================
// 2. LAST WEEKDAY OF MONTH RESOLVER
// ============================================================================

/**
 * Resolves the last weekday of a given month in a year.
 * @param year e.g. 2026
 * @param month 1-12 (e.g. 5 for May)
 * @param weekday 0=Sunday, 1=Monday... (e.g. 1 for Monday)
 */
export function resolveLastWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number
): string {
  const lastDayObj = new Date(Date.UTC(year, month, 0));
  const lastDay = lastDayObj.getUTCDate();
  const lastDayOfWeek = lastDayObj.getUTCDay();
  const offset = (lastDayOfWeek - weekday + 7) % 7;
  const day = lastDay - offset;

  return formatYMD(year, month, day);
}

// ============================================================================
// 3. COMPUTED GREGORIAN (WESTERN COMPUTUS - EASTER & CYCLE)
// ============================================================================

/**
 * Computes Western Easter Sunday using the Meeus/Jones/Butcher Gregorian algorithm.
 * Valid for all Gregorian years.
 */
export function getEasterSunday(year: number): { year: number; month: number; day: number; ymd: string } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return {
    year,
    month,
    day,
    ymd: formatYMD(year, month, day),
  };
}

/**
 * Resolves dates in the Western liturgical / computed Gregorian cycle.
 */
export function resolveComputedGregorian(
  year: number,
  computedKey: string
): { startDate: string; endDate: string } | null {
  const easter = getEasterSunday(year);

  switch (computedKey) {
    case 'easter_sunday':
      return { startDate: easter.ymd, endDate: easter.ymd };

    case 'good_friday': {
      const goodFridayYmd = addDays(easter.ymd, -2);
      return { startDate: goodFridayYmd, endDate: goodFridayYmd };
    }

    case 'easter_monday': {
      const easterMondayYmd = addDays(easter.ymd, 1);
      return { startDate: easterMondayYmd, endDate: easterMondayYmd };
    }

    case 'ash_wednesday': {
      const ashWednesdayYmd = addDays(easter.ymd, -46);
      return { startDate: ashWednesdayYmd, endDate: ashWednesdayYmd };
    }

    case 'uk_mothering_sunday': {
      // 4th Sunday in Lent (exactly 3 weeks before Easter Sunday)
      const motheringYmd = addDays(easter.ymd, -21);
      return { startDate: motheringYmd, endDate: motheringYmd };
    }

    case 'advent_sunday': {
      // 4th Sunday before Christmas: Sunday nearest November 30
      const nov30 = new Date(Date.UTC(year, 10, 30));
      const dayOfWeek = nov30.getUTCDay();
      // Nearest Sunday
      const diff = dayOfWeek <= 3 ? -dayOfWeek : 7 - dayOfWeek;
      const adventDate = new Date(Date.UTC(year, 10, 30 + diff));
      const ymd = formatYMD(adventDate.getUTCFullYear(), adventDate.getUTCMonth() + 1, adventDate.getUTCDate());
      return { startDate: ymd, endDate: ymd };
    }

    default:
      return null;
  }
}

// ============================================================================
// 4. JEWISH CALENDAR (HEBCAL PERPETUAL ENGINE)
// ============================================================================

/**
 * Resolves Jewish holidays for a given Gregorian year using @hebcal/core.
 * Returns exact start and end dates (multi-day where applicable).
 */
export async function resolveHebrewOccasion(
  year: number,
  eventKey: string
): Promise<{ startDate: string; endDate: string }[]> {
  try {
    const { HebrewCalendar } = await getHebcal();
    const events = HebrewCalendar.calendar({
      year,
      isHebrewYear: false,
      il: false, // Diaspora standard
    });

    const results: { startDate: string; endDate: string }[] = [];

    switch (eventKey) {
      case 'rosh_hashanah': {
        const day1 = events.find((e: any) => e.getDesc()?.startsWith('Rosh Hashana') && !e.getDesc()?.includes('II'));
        if (day1) {
          const start = day1.getDate().greg().toISOString().slice(0, 10);
          const end = addDays(start, 1); // 2 days
          results.push({ startDate: start, endDate: end });
        }
        break;
      }

      case 'yom_kippur': {
        const yk = events.find((e: any) => e.getDesc() === 'Yom Kippur');
        if (yk) {
          const ymd = yk.getDate().greg().toISOString().slice(0, 10);
          results.push({ startDate: ymd, endDate: ymd });
        }
        break;
      }

      case 'hanukkah': {
        const day1 = events.find((e: any) => e.getDesc()?.includes('Chanukah: 1 Candle'));
        if (day1) {
          const start = day1.getDate().greg().toISOString().slice(0, 10);
          const end = addDays(start, 7); // 8 days total
          results.push({ startDate: start, endDate: end });
        }
        break;
      }

      case 'passover': {
        const day1 = events.find((e: any) => e.getDesc() === 'Pesach I');
        if (day1) {
          const start = day1.getDate().greg().toISOString().slice(0, 10);
          const end = addDays(start, 7); // 8 days
          results.push({ startDate: start, endDate: end });
        }
        break;
      }

      case 'purim': {
        const purim = events.find((e: any) => e.getDesc() === 'Purim');
        if (purim) {
          const ymd = purim.getDate().greg().toISOString().slice(0, 10);
          results.push({ startDate: ymd, endDate: ymd });
        }
        break;
      }

      case 'sukkot': {
        const day1 = events.find((e: any) => e.getDesc() === 'Sukkot I');
        if (day1) {
          const start = day1.getDate().greg().toISOString().slice(0, 10);
          const end = addDays(start, 6); // 7 days
          results.push({ startDate: start, endDate: end });
        }
        break;
      }
    }

    return results;
  } catch (err) {
    console.error(`[DateResolver] Error resolving Hebrew occasion ${eventKey} for year ${year}:`, err);
    return [];
  }
}

// ============================================================================
// 5. ISLAMIC (HIJRI) CALENDAR (UMM AL-QURA ENGINE)
// ============================================================================

/**
 * Resolves Islamic occasions in a Gregorian year using Umm al-Qura standard converter.
 * Accurately finds occasions that occur within the target Gregorian year.
 */
export async function resolveIslamicOccasion(
  year: number,
  eventKey: string
): Promise<{ startDate: string; endDate: string }[]> {
  try {
    const { gregorianToHijri, hijriToGregorian } = await getHijri();
    const hStart = gregorianToHijri({ year, month: 1, day: 1 });
    const hEnd = gregorianToHijri({ year, month: 12, day: 31 });

    const results: { startDate: string; endDate: string }[] = [];

    for (let hYear = hStart.year - 1; hYear <= hEnd.year + 1; hYear++) {
      let candStart: { year: number; month: number; day: number } | null = null;
      let candEnd: { year: number; month: number; day: number } | null = null;

      if (eventKey === 'ramadan') {
        const ramadan1 = hijriToGregorian({ year: hYear, month: 9, day: 1 });
        const shawwal1 = hijriToGregorian({ year: hYear, month: 10, day: 1 });
        candStart = ramadan1;
        const shawwal1Ymd = formatYMD(shawwal1.year, shawwal1.month, shawwal1.day);
        const ramadanEndYmd = addDays(shawwal1Ymd, -1);
        const [ey, em, ed] = ramadanEndYmd.split('-').map(Number);
        candEnd = { year: ey, month: em, day: ed };
      } else if (eventKey === 'eid_al_fitr') {
        const day1 = hijriToGregorian({ year: hYear, month: 10, day: 1 });
        const day1Ymd = formatYMD(day1.year, day1.month, day1.day);
        const endYmd = addDays(day1Ymd, 2);
        const [ey, em, ed] = endYmd.split('-').map(Number);
        candStart = day1;
        candEnd = { year: ey, month: em, day: ed };
      } else if (eventKey === 'eid_al_adha') {
        const day1 = hijriToGregorian({ year: hYear, month: 12, day: 10 });
        const day1Ymd = formatYMD(day1.year, day1.month, day1.day);
        const endYmd = addDays(day1Ymd, 3);
        const [ey, em, ed] = endYmd.split('-').map(Number);
        candStart = day1;
        candEnd = { year: ey, month: em, day: ed };
      } else if (eventKey === 'islamic_new_year') {
        const day1 = hijriToGregorian({ year: hYear, month: 1, day: 1 });
        candStart = day1;
        candEnd = day1;
      } else if (eventKey === 'mawlid_an_nabi') {
        const day1 = hijriToGregorian({ year: hYear, month: 3, day: 12 });
        candStart = day1;
        candEnd = day1;
      }

      if (candStart && candEnd) {
        const startYmd = formatYMD(candStart.year, candStart.month, candStart.day);
        const endYmd = formatYMD(candEnd.year, candEnd.month, candEnd.day);

        const startInYear = candStart.year === year;
        const endInYear = candEnd.year === year;

        if (startInYear || endInYear) {
          results.push({ startDate: startYmd, endDate: endYmd });
        }
      }
    }

    return results;
  } catch (err) {
    console.error(`[DateResolver] Error resolving Islamic occasion ${eventKey} for year ${year}:`, err);
    return [];
  }
}

// ============================================================================
// 6. CHINESE & VIETNAMESE LUNISOLAR CALENDAR (LUNAR-JAVASCRIPT)
// ============================================================================

/**
 * Resolves Chinese and Vietnamese lunisolar occasions for a Gregorian year.
 */
export async function resolveLunisolarOccasion(
  year: number,
  eventKey: string,
  lunarMonth?: number,
  lunarDay?: number
): Promise<{ startDate: string; endDate: string } | null> {
  try {
    const { Lunar, Solar } = await getLunar();

    switch (eventKey) {
      case 'tet':
      case 'lunar_new_year': {
        const solarDay1 = Lunar.fromYmd(year, 1, 1).getSolar();
        const startYmd = formatYMD(solarDay1.getYear(), solarDay1.getMonth(), solarDay1.getDay());
        const endYmd = addDays(startYmd, 2); // 3-day core period
        return { startDate: startYmd, endDate: endYmd };
      }

      case 'lantern_festival': {
        const solar = Lunar.fromYmd(year, 1, 15).getSolar();
        const ymd = formatYMD(solar.getYear(), solar.getMonth(), solar.getDay());
        return { startDate: ymd, endDate: ymd };
      }

      case 'cold_food': {
        const solar = Lunar.fromYmd(year, 3, 3).getSolar();
        const ymd = formatYMD(solar.getYear(), solar.getMonth(), solar.getDay());
        return { startDate: ymd, endDate: ymd };
      }

      case 'qingming': {
        for (const d of [4, 5, 6]) {
          const s = Solar.fromYmd(year, 4, d);
          if (s.getLunar().getJieQi() === '清明') {
            const ymd = formatYMD(year, 4, d);
            return { startDate: ymd, endDate: ymd };
          }
        }
        const ymd = formatYMD(year, 4, 5);
        return { startDate: ymd, endDate: ymd };
      }

      case 'dragon_boat': {
        const solar = Lunar.fromYmd(year, 5, 5).getSolar();
        const ymd = formatYMD(solar.getYear(), solar.getMonth(), solar.getDay());
        return { startDate: ymd, endDate: ymd };
      }

      case 'vu_lan': {
        const solar = Lunar.fromYmd(year, 7, 15).getSolar();
        const ymd = formatYMD(solar.getYear(), solar.getMonth(), solar.getDay());
        return { startDate: ymd, endDate: ymd };
      }

      case 'mid_autumn': {
        const solar = Lunar.fromYmd(year, 8, 15).getSolar();
        const ymd = formatYMD(solar.getYear(), solar.getMonth(), solar.getDay());
        return { startDate: ymd, endDate: ymd };
      }

      case 'double_ninth': {
        const solar = Lunar.fromYmd(year, 9, 9).getSolar();
        const ymd = formatYMD(solar.getYear(), solar.getMonth(), solar.getDay());
        return { startDate: ymd, endDate: ymd };
      }

      case 'kitchen_gods': {
        const sol1 = Lunar.fromYmd(year - 1, 12, 23).getSolar();
        if (sol1.getYear() === year) {
          const ymd = formatYMD(sol1.getYear(), sol1.getMonth(), sol1.getDay());
          return { startDate: ymd, endDate: ymd };
        }
        const sol2 = Lunar.fromYmd(year, 12, 23).getSolar();
        if (sol2.getYear() === year) {
          const ymd = formatYMD(sol2.getYear(), sol2.getMonth(), sol2.getDay());
          return { startDate: ymd, endDate: ymd };
        }
        const ymd = formatYMD(sol1.getYear(), sol1.getMonth(), sol1.getDay());
        return { startDate: ymd, endDate: ymd };
      }

      default: {
        if (lunarMonth && lunarDay) {
          const solar = Lunar.fromYmd(year, lunarMonth, lunarDay).getSolar();
          const ymd = formatYMD(solar.getYear(), solar.getMonth(), solar.getDay());
          return { startDate: ymd, endDate: ymd };
        }
        return null;
      }
    }
  } catch (err) {
    console.error(`[DateResolver] Error resolving lunisolar occasion ${eventKey} for year ${year}:`, err);
    return null;
  }
}

// ============================================================================
// 7. CORE OCCASION RESOLVER
// ============================================================================

/**
 * Resolves an occasion date rule for a given Gregorian year and user region.
 * Handles REGION_SPECIFIC delegation and dispatches to appropriate rule engine.
 */
export async function resolveOccasionDates(
  occasion: CatalogOccasion,
  year: number,
  countryCode = 'AU',
  subdivisionCode?: string
): Promise<Array<{ startDate: string; endDate: string }>> {
  // If explicitly marked pending / unsupported, do not fabricate dates
  if (occasion.status === 'pending' || occasion.dateRule?.status === 'pending') {
    return [];
  }

  const rule = occasion.dateRule;
  if (!rule) {
    return [];
  }

  // 1. REGION_SPECIFIC: delegate to matched regional rule
  if (rule.type === 'REGION_SPECIFIC') {
    const regionKeyFull = subdivisionCode ? `${countryCode}-${subdivisionCode}`.toUpperCase() : countryCode.toUpperCase();
    const regionKeyCountry = countryCode.toUpperCase();

    const selectedRule =
      rule.regionRules?.[regionKeyFull] ||
      rule.regionRules?.[regionKeyCountry] ||
      rule.defaultRule;

    if (!selectedRule) {
      return [];
    }

    return resolveOccasionDates(
      { ...occasion, dateRule: selectedRule },
      year,
      countryCode,
      subdivisionCode
    );
  }

  // 2. FIXED_GREGORIAN
  if (rule.type === 'FIXED_GREGORIAN') {
    if (!rule.month || !rule.day) return [];
    const startDate = formatYMD(year, rule.month, rule.day);
    const duration = rule.durationDays && rule.durationDays > 1 ? rule.durationDays : 1;
    const endDate = addDays(startDate, duration - 1);
    return [{ startDate, endDate }];
  }

  // 3. NTH_WEEKDAY_OF_MONTH
  if (rule.type === 'NTH_WEEKDAY_OF_MONTH') {
    if (!rule.month || rule.nth === undefined || rule.weekday === undefined) return [];
    const startDate = resolveNthWeekdayOfMonth(year, rule.month, rule.nth, rule.weekday);
    const duration = rule.durationDays && rule.durationDays > 1 ? rule.durationDays : 1;
    const endDate = addDays(startDate, duration - 1);
    return [{ startDate, endDate }];
  }

  // 4. LAST_WEEKDAY_OF_MONTH
  if (rule.type === 'LAST_WEEKDAY_OF_MONTH') {
    if (!rule.month || rule.weekday === undefined) return [];
    const startDate = resolveLastWeekdayOfMonth(year, rule.month, rule.weekday);
    const duration = rule.durationDays && rule.durationDays > 1 ? rule.durationDays : 1;
    const endDate = addDays(startDate, duration - 1);
    return [{ startDate, endDate }];
  }

  // 5. COMPUTED_GREGORIAN
  if (rule.type === 'COMPUTED_GREGORIAN') {
    if (!rule.computedKey) return [];
    const res = resolveComputedGregorian(year, rule.computedKey);
    return res ? [res] : [];
  }

  // 6. LUNAR_OR_RELIGIOUS_CALENDAR / MULTI_DAY_PERIOD
  if (rule.type === 'LUNAR_OR_RELIGIOUS_CALENDAR' || rule.type === 'MULTI_DAY_PERIOD') {
    const calendarSys = rule.calendarSystem;

    if (calendarSys === 'hebrew' && rule.calendarEventKey) {
      return resolveHebrewOccasion(year, rule.calendarEventKey);
    }

    if (calendarSys === 'islamic_hijri' && rule.calendarEventKey) {
      return resolveIslamicOccasion(year, rule.calendarEventKey);
    }

    if ((calendarSys === 'chinese_lunar' || calendarSys === 'vietnamese_lunar') && rule.calendarEventKey) {
      const res = await resolveLunisolarOccasion(year, rule.calendarEventKey, rule.lunarMonth, rule.lunarDay);
      return res ? [res] : [];
    }
  }

  return [];
}

// ============================================================================
// 8. OCCURRENCE GENERATION & ROLLING FUTURE RESOLUTION
// ============================================================================

/**
 * Resolves all active occurrences for a catalog occasion across a rolling time window.
 * This guarantees seamless boundary transitions across year boundaries (e.g. December -> January).
 */
export async function resolveOccasionOccurrencesForWindow(
  occasion: CatalogOccasion,
  windowStart: string, // YYYY-MM-DD
  windowEnd: string,   // YYYY-MM-DD
  countryCode = 'AU',
  subdivisionCode?: string
): Promise<OccasionOccurrence[]> {
  const startYear = parseInt(windowStart.slice(0, 4), 10);
  const endYear = parseInt(windowEnd.slice(0, 4), 10);

  const occurrences: OccasionOccurrence[] = [];

  for (let yr = startYear; yr <= endYear; yr++) {
    const dateSpans = await resolveOccasionDates(occasion, yr, countryCode, subdivisionCode);

    for (const span of dateSpans) {
      if (span.startDate <= windowEnd && span.endDate >= windowStart) {
        const occurrenceId = `${occasion.id}:${span.startDate}`;
        const isMultiDay = span.startDate !== span.endDate;

        occurrences.push({
          occasionId: occasion.id,
          occurrenceId,
          title: occasion.name,
          startDate: span.startDate,
          endDate: span.endDate,
          isMultiDay,
          countryCode: occasion.countryCode || countryCode,
          subdivisionCode: occasion.subdivisionCode || subdivisionCode,
          traditionId: occasion.traditionId,
          anticipatoryMode: occasion.defaultAnticipatoryMode,
          metadata: {
            category: occasion.category,
            description: occasion.description,
          },
        });
      }
    }
  }

  return occurrences;
}

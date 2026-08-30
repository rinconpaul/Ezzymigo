import { getYMDInTz } from './time';

export interface ClockTimeAmbiguity {
  isAmbiguous: boolean;
  hour?: number;
  minute?: number;
  hourStr?: string;
  question?: string;
  candidateOptions?: string[];
  dayPart?: 'am' | 'pm' | null;
  targetDate?: string | null;
  timeExpr?: string;
}

// Multilingual dayparts mapping
const MORNING_REGEX = /\b(morning|in the morning|this morning|tomorrow morning|yesterday morning|du matin|le matin|ce matin|demain matin|de la mañana|por la mañana|esta mañana|morgens|am morgen|am vormittag|vormittags|heute morgen|morgen früh|del mattino|di mattina|stamattina|questa mattina|domattina|da manhã|pela manhã|esta manhã|amanhã de manhã)\b|早上|上午|早晨|清晨|朝|午前/i;
const AFTERNOON_REGEX = /\b(afternoon|in the afternoon|this afternoon|tomorrow afternoon|yesterday afternoon|de l'après-midi|l'après-midi|cet après-midi|après-midi|de la tarde|por la tarde|esta tarde|nachmittags|am nachmittag|heute nachmittag|del pomeriggio|nel pomeriggio|questo pomeriggio|pomeriggio|da tarde|à tarde|esta tarde)\b|下午|午后|午後/i;
const EVENING_REGEX = /\b(evening|in the evening|this evening|tomorrow evening|yesterday evening|du soir|le soir|ce soir|demain soir|abends|am abend|heute abend|della sera|di sera|questa sera|stasera|do fim de tarde|à noitinha)\b|晚上|傍晚|夕方|夕刻/i;
const NIGHT_REGEX = /\b(tonight|at night|tomorrow night|this night|night|la nuit|de la nuit|cette nuit|la noche|de noche|por la noche|esta noche|nachts|in der nacht|heute nacht|la notte|di notte|stanotte|a noite|à noite|esta noite|de noite)\b|夜里|今晚|夜间|半夜|今夜|夜間|夜/i;
const NOON_REGEX = /\b(noon|midday|midi|mediodía|mittag|mezzogiorno|meio-dia)\b|中午|正午/i;
const MIDNIGHT_REGEX = /\b(midnight|minuit|medianoche|mitternacht|mezzanotte|meia-noite)\b|午夜|真夜中/i;

/**
 * Detects whether a temporal expression or unit text contains an ambiguous clock time
 * (e.g. "at 4", "4 o'clock", "Monday at 7", "tomorrow at 4") that lacks an explicit meridiem (am/pm),
 * 24-hour notation, or natural daypart qualifier across supported languages.
 */
export function detectClockTimeAmbiguity(
  text: string,
  timingExpr?: string | null,
  referenceDate: Date = new Date(),
  timeZone: string = 'Australia/Sydney',
  offsetStr: string = '+10:00',
  language: string = 'en-AU'
): ClockTimeAmbiguity {
  const combined = `${timingExpr || ''} ${text || ''}`.trim();
  if (!combined) {
    return { isAmbiguous: false };
  }

  const lower = combined.toLowerCase();

  // 1. Check for explicit 24-hour times across languages
  // e.g. "16:00", "14:30", "21:45", "00:30", "16h", "16h00", "16h30", "16 Uhr", "16点", "16時"
  const standard24Match = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (standard24Match) {
    const h = parseInt(standard24Match[1], 10);
    if (h >= 13 || standard24Match[1].startsWith('0')) {
      return { isAmbiguous: false, dayPart: h >= 12 ? 'pm' : 'am' };
    }
  }

  // European 'h' or 'uhr' notation: "16h30", "16h", "16 uhr", "16:00 uhr"
  const europeanHMatch = lower.match(/\b([01]?\d|2[0-3])\s*(?:h|uhr)\s*([0-5]\d)?\b/i);
  if (europeanHMatch) {
    const h = parseInt(europeanHMatch[1], 10);
    if (h >= 13 || europeanHMatch[1].startsWith('0')) {
      return { isAmbiguous: false, dayPart: h >= 12 ? 'pm' : 'am' };
    }
  }

  // Asian 24h notation: e.g. "16点", "16時", "16点30分", "16時30分"
  const asian24Match = combined.match(/([01]?\d|2[0-3])\s*(?:点|時|点钟|点鐘)\s*([0-5]\d)?(?:分)?/);
  if (asian24Match) {
    const h = parseInt(asian24Match[1], 10);
    if (h >= 13 || (asian24Match[1].startsWith('0') && asian24Match[1].length === 2)) {
      return { isAmbiguous: false, dayPart: h >= 12 ? 'pm' : 'am' };
    }
  }

  // 2. Check for explicit AM / PM meridiem in the text
  // e.g. "4am", "4 pm", "4:00pm", "7 am", "7:30 a.m.", "8p.m."
  const explicitMeridiemMatch = lower.match(/\b\d{1,2}(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\b/i);
  if (explicitMeridiemMatch) {
    const m = explicitMeridiemMatch[1].toLowerCase().replace(/\./g, '');
    return { isAmbiguous: false, dayPart: m === 'pm' ? 'pm' : 'am' };
  }

  // 3. Check for natural dayparts associated with time across languages
  const hasMorning = MORNING_REGEX.test(combined);
  const hasAfternoon = AFTERNOON_REGEX.test(combined);
  const hasEvening = EVENING_REGEX.test(combined);
  const hasNight = NIGHT_REGEX.test(combined);
  const hasNoon = NOON_REGEX.test(combined);
  const hasMidnight = MIDNIGHT_REGEX.test(combined);

  if (hasMorning || hasAfternoon || hasEvening || hasNight || hasNoon || hasMidnight) {
    const dayPart = (hasAfternoon || hasEvening || hasNight || hasNoon) ? 'pm' : 'am';
    return { isAmbiguous: false, dayPart };
  }

  // 4. Check for relative durations: "in 10 minutes", "in 2 hours", "in 3 days"
  if (/\bin\s+\d+\s*(?:minutes?|mins?|min|m|hours?|hrs?|hr|h|seconds?|secs?|s|days?|d)\b/i.test(lower) ||
      /\bdans\s+\d+\s*(?:minutes?|heures?|jours?)\b/i.test(lower) ||
      /\ben\s+\d+\s*(?:minutos?|horas?|días?)\b/i.test(lower) ||
      /\bin\s+\d+\s*(?:minuten?|stunden?|tagen?)\b/i.test(lower)) {
    return { isAmbiguous: false };
  }

  // 5. Look for bare clock time hour patterns that lack meridiem and lack dayparts:
  let hour: number | null = null;
  let minute: number = 0;
  let matchedExpr = '';

  // Pattern A: "X o'clock" (English) or "X heures" (French) or "X Uhr" (German) or "las X" (Spanish) or "le X" (Italian) or "às X" (Portuguese)
  const oclockMatch = lower.match(/\b(\d{1,2})\s*o'?clock\b/i);
  if (oclockMatch) {
    hour = parseInt(oclockMatch[1], 10);
    minute = 0;
    matchedExpr = oclockMatch[0];
  }

  // French "à 4h", "à 4 heures"
  if (hour === null) {
    const frHourMatch = lower.match(/\b(?:à|a)\s*(\d{1,2})\s*(?:h|heures?)\s*([0-5]\d)?\b/i);
    if (frHourMatch) {
      hour = parseInt(frHourMatch[1], 10);
      minute = frHourMatch[2] ? parseInt(frHourMatch[2], 10) : 0;
      matchedExpr = frHourMatch[0];
    }
  }

  // German "um 4 Uhr", "um 4"
  if (hour === null) {
    const deHourMatch = lower.match(/\bum\s*(\d{1,2})(?::([0-5]\d))?\s*(?:uhr)?\b/i);
    if (deHourMatch) {
      hour = parseInt(deHourMatch[1], 10);
      minute = deHourMatch[2] ? parseInt(deHourMatch[2], 10) : 0;
      matchedExpr = deHourMatch[0];
    }
  }

  // Spanish "a las 4", "a la 1", "las 4"
  if (hour === null) {
    const esHourMatch = lower.match(/\b(?:a\s+)?(?:las?|la)\s*(\d{1,2})(?::([0-5]\d))?\b/i);
    if (esHourMatch) {
      hour = parseInt(esHourMatch[1], 10);
      minute = esHourMatch[2] ? parseInt(esHourMatch[2], 10) : 0;
      matchedExpr = esHourMatch[0];
    }
  }

  // Italian "alle 4", "all'1"
  if (hour === null) {
    const itHourMatch = lower.match(/\b(?:alle|all['’]|ai)\s*(\d{1,2})(?::([0-5]\d))?\b/i);
    if (itHourMatch) {
      hour = parseInt(itHourMatch[1], 10);
      minute = itHourMatch[2] ? parseInt(itHourMatch[2], 10) : 0;
      matchedExpr = itHourMatch[0];
    }
  }

  // Portuguese "às 4", "à 1"
  if (hour === null) {
    const ptHourMatch = lower.match(/\b(?:às|as|à|a)\s*(\d{1,2})(?::([0-5]\d))?\b/i);
    if (ptHourMatch) {
      hour = parseInt(ptHourMatch[1], 10);
      minute = ptHourMatch[2] ? parseInt(ptHourMatch[2], 10) : 0;
      matchedExpr = ptHourMatch[0];
    }
  }

  // Chinese/Japanese bare hour: "4点", "4時"
  if (hour === null) {
    const asianHourMatch = combined.match(/(\d{1,2})\s*(?:点|時|点钟|点鐘)\s*([0-5]\d)?(?:分)?/);
    if (asianHourMatch) {
      hour = parseInt(asianHourMatch[1], 10);
      minute = asianHourMatch[2] ? parseInt(asianHourMatch[2], 10) : 0;
      matchedExpr = asianHourMatch[0];
    }
  }

  // Pattern B: "at X" or "at X:YY" or "@ X"
  if (hour === null) {
    const atMatch = lower.match(/\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\b/i);
    if (atMatch) {
      hour = parseInt(atMatch[1], 10);
      minute = atMatch[2] ? parseInt(atMatch[2], 10) : 0;
      matchedExpr = atMatch[0];
    }
  }

  // Pattern C: Relative day / weekday followed by bare hour across languages
  if (hour === null) {
    const dayHourMatch = lower.match(/\b(?:tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|demain|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|aujourd'hui|morgen|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|heute|mañana|lunes|martes|miércoles|jueves|viernes|sábado|domingo|hoy|domani|lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|oggi|amanhã|hoje)\s+(?:at\s+|à\s+|um\s+|a\s+las\s+|alle\s+|às\s+)?(\d{1,2})(?::(\d{2}))?\b/i);
    if (dayHourMatch) {
      hour = parseInt(dayHourMatch[1], 10);
      minute = dayHourMatch[2] ? parseInt(dayHourMatch[2], 10) : 0;
      matchedExpr = dayHourMatch[0];
    }
  }

  // Pattern D: Bare colon time e.g. "4:30" (when not part of date or other number)
  if (hour === null) {
    const colonMatch = lower.match(/\b(\d{1,2}):(\d{2})\b/);
    if (colonMatch) {
      hour = parseInt(colonMatch[1], 10);
      minute = parseInt(colonMatch[2], 10);
      matchedExpr = colonMatch[0];
    }
  }

  // Pattern E: "remind me at X" or "due at X"
  if (hour === null) {
    const remindMatch = lower.match(/\b(?:remind me|due|by|around|about|from|until|till|rappel|rappeler|recordar|recuérdame|erinnere|ricordami|lembre-me)\s+(?:at\s+|à\s+|um\s+|a\s+las\s+|alle\s+|às\s+)?(\d{1,2})(?::(\d{2}))?\b/i);
    if (remindMatch) {
      hour = parseInt(remindMatch[1], 10);
      minute = remindMatch[2] ? parseInt(remindMatch[2], 10) : 0;
      matchedExpr = remindMatch[0];
    }
  }

  if (hour !== null && hour >= 1 && hour <= 12) {
    const hourStr = minute > 0 ? `${hour}:${String(minute).padStart(2, '0')}` : `${hour}`;

    // Determine target date from text or referenceDate
    let targetDateStr = getYMDInTz(referenceDate, timeZone);
    if (lower.includes('tomorrow') || lower.includes('demain') || lower.includes('morgen') || lower.includes('mañana') || lower.includes('domani') || lower.includes('amanhã') || combined.includes('明天') || combined.includes('明日')) {
      const tom = new Date(referenceDate.getTime() + 24 * 60 * 60 * 1000);
      targetDateStr = getYMDInTz(tom, timeZone);
    } else {
      const weekdaysEn = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const weekdaysFr = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
      const weekdaysEs = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
      const weekdaysDe = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
      const weekdaysIt = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
      const weekdaysPt = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

      for (let i = 0; i < 7; i++) {
        if (lower.includes(weekdaysEn[i]) || lower.includes(weekdaysFr[i]) || lower.includes(weekdaysEs[i]) || lower.includes(weekdaysDe[i]) || lower.includes(weekdaysIt[i]) || lower.includes(weekdaysPt[i])) {
          const currentDay = referenceDate.getDay();
          let diff = i - currentDay;
          if (diff <= 0) diff += 7;
          const targetDay = new Date(referenceDate.getTime() + diff * 24 * 60 * 60 * 1000);
          targetDateStr = getYMDInTz(targetDay, timeZone);
          break;
        }
      }
    }

    // Build localized question and options based on user language
    const langPrefix = (language || 'en').toLowerCase().split('-')[0];
    let question = `Did you mean ${hourStr} am or ${hourStr} pm?`;
    let candidateOptions = [`${hourStr} am`, `${hourStr} pm`];

    if (langPrefix === 'fr') {
      question = `Vouliez-vous dire ${hourStr}h du matin ou ${hourStr}h de l'après-midi ?`;
      candidateOptions = [`${hourStr}h du matin`, `${hourStr}h de l'après-midi`];
    } else if (langPrefix === 'es') {
      question = `¿Te referías a las ${hourStr} de la mañana o a las ${hourStr} de la tarde?`;
      candidateOptions = [`${hourStr} de la mañana`, `${hourStr} de la tarde`];
    } else if (langPrefix === 'de') {
      question = `Meinten Sie ${hourStr} Uhr morgens oder ${hourStr} Uhr nachmittags?`;
      candidateOptions = [`${hourStr} Uhr morgens`, `${hourStr} Uhr nachmittags`];
    } else if (langPrefix === 'it') {
      question = `Intendevi le ${hourStr} del mattino o le ${hourStr} del pomeriggio?`;
      candidateOptions = [`${hourStr} del mattino`, `${hourStr} del pomeriggio`];
    } else if (langPrefix === 'pt') {
      question = `Você quis dizer ${hourStr} da manhã ou ${hourStr} da tarde?`;
      candidateOptions = [`${hourStr} da manhã`, `${hourStr} da tarde`];
    } else if (langPrefix === 'zh') {
      question = `你是说上午 ${hourStr} 点还是下午 ${hourStr} 点？`;
      candidateOptions = [`上午 ${hourStr} 点`, `下午 ${hourStr} 点`];
    } else if (langPrefix === 'ja') {
      question = `午前${hourStr}時ですか、それとも午後${hourStr}時ですか？`;
      candidateOptions = [`午前${hourStr}時`, `午後${hourStr}時`];
    }

    return {
      isAmbiguous: true,
      hour,
      minute,
      hourStr,
      question,
      candidateOptions,
      targetDate: targetDateStr,
      timeExpr: matchedExpr || `${hourStr} o'clock`,
    };
  }

  return { isAmbiguous: false };
}

/**
 * Resolves an ambiguous clock time into an absolute ISO-8601 timestamp given the target date, hour, minute, and chosen meridiem.
 */
export function resolveAmbiguousTimeToIso(
  targetDate: string,
  hour: number,
  minute: number,
  meridiem: 'am' | 'pm',
  offsetStr: string = '+10:00'
): string {
  let finalHour = hour;
  if (meridiem === 'pm' && finalHour < 12) {
    finalHour += 12;
  } else if (meridiem === 'am' && finalHour === 12) {
    finalHour = 0;
  }

  const cleanDate = targetDate.includes('T') ? targetDate.split('T')[0] : targetDate;
  const hh = String(finalHour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${cleanDate}T${hh}:${mm}:00${offsetStr}`;
}

/**
 * Updates a human-readable timing string with the user's chosen meridiem.
 */
export function formatTimingWithResolvedMeridiem(
  originalTiming: string,
  hour: number,
  minute: number,
  meridiem: 'am' | 'pm'
): string {
  const timeFormatted = minute > 0
    ? `${hour}:${String(minute).padStart(2, '0')} ${meridiem}`
    : `${hour} ${meridiem}`;

  if (!originalTiming) {
    return timeFormatted;
  }

  // Replace "at X o'clock" -> "at X pm" / "at X am"
  let replaced = originalTiming.replace(
    new RegExp(`(?:at\\s+)?${hour}(?::\\d{2})?\\s*o'?clock`, 'i'),
    `at ${timeFormatted}`
  );

  // Replace "at X" -> "at X pm" / "at X am"
  if (replaced === originalTiming) {
    replaced = originalTiming.replace(
      new RegExp(`(?:at\\s+)?${hour}(?::\\d{2})?`, 'i'),
      `at ${timeFormatted}`
    );
  }

  // Clean up any double "at at"
  replaced = replaced.replace(/\bat\s+at\b/i, 'at').trim();
  return replaced;
}

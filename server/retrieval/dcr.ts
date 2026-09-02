import { normalizeRoleName, resolveRelationshipsInQuery } from '../relationships/index';
import { LocalContextInfo, MemoryTodayLifecycleBounds, evaluateMemoryTodayLifecycle } from '../today/relevance';
import { getYMDInTz, getTimeStrInTz, parseTimeStringToHM, getRelativeYMD, getWeekdayFromYMD } from '../utils/time';

// -------------------------------------------------------------
// DYNAMIC CONTEXT RETRIEVAL v1 (Context Builder Engine)
// -------------------------------------------------------------

export interface ResolvedTemporalTarget {
  expression: string;
  targetYMD: string;
  targetWeekday: string;
  dayOffset: number;
  isFuture: boolean;
  isPast: boolean;
  isToday: boolean;
}

export interface DynamicRetrievalResult {
  candidateMemories: any[];
  candidateCalendarEvents: any[];
  retrievalMetadata: {
    resolvedPeople: string[];
    resolvedRoles: string[];
    detectedPlaces: string[];
    topicsAndKeywords: string[];
    temporalAnchors: {
      hasTemporalConstraint: boolean;
      months: string[];
      relativeExpressions: string[];
      resolvedTargets?: Array<{ expression: string; targetYMD: string; targetWeekday: string; dayOffset: number }>;
    };
    expandedTokens: string[];
    resolvedEntities: Array<{ roleMatch: string; normalizedRole: string; resolvedPerson: string }>;
    ambiguousEntities: Array<{ roleMatch: string; normalizedRole: string; candidatePeople: string[] }>;
    candidateCount: number;
    totalMemories: number;
  };
}

export const ASK_STOP_WORDS = new Set([
  'what', 'when', 'where', 'who', 'whom', 'why', 'how', 'which',
  'did', 'do', 'does', 'done', 'doing',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'my', 'our', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'about', 'of', 'and', 'or', 'by', 'as',
  'i', 'me', 'mine', 'you', 'your', 'yours', 'we', 'us', 'they', 'them', 'he', 'him', 'she', 'her', 'it', 'its',
  'this', 'that', 'these', 'those', 'there', 'here',
  'say', 'said', 'tell', 'told', 'have', 'had', 'has', 'having',
  'got', 'get', 'getting', 'need', 'needed', 'needs', 'want', 'wanted', 'wants',
  'supposed', 'going', 'would', 'could', 'should', 'can', 'will', 'please',
  'know', 'any', 'some', 'thing', 'things', 'much', 'many', 'more', 'also', 'just'
]);

export const GENERIC_SCHEDULE_TERMS = new Set([
  'appointment', 'appointments',
  'calendar',
  'schedule', 'schedules', 'scheduled',
  'event', 'events',
  'meeting', 'meetings',
  'upcoming',
  'coming',
  'plan', 'plans',
  'agenda', 'agendas',
  'booked', 'booking', 'bookings'
]);

export function detectGenericScheduleIntent(qLower: string): boolean {
  const schedulePatterns = [
    /\b(?:what(?:'s|\s+is|\s+are|\s+do\s+i\s+have)?\s+(?:on\s+my\s+calendar|my\s+schedule|coming\s+up|upcoming|scheduled|my\s+agenda|on\s+the\s+agenda))\b/i,
    /\b(?:what|any|list|show|check|got|have)\s+(?:upcoming\s+)?(?:appointments|meetings|events|schedule|calendar|plans)\b/i,
    /\b(?:what(?:\s+have\s+i|\s+do\s+i)\s+got\s+coming\s+up)\b/i,
    /\b(?:what\s+am\s+i\s+doing)\b/i,
    /\b(?:what's\s+on|what\s+is\s+on)\b/i,
    /\b(?:on\s+my\s+calendar|in\s+my\s+calendar)\b/i,
    /\b(?:calendar|schedule|appointments?|meetings?|agenda)\b/i
  ];
  return schedulePatterns.some(p => p.test(qLower));
}

export const RETRIEVAL_MONTHS = [
  { name: 'january', abbr: 'jan', index: 0 },
  { name: 'february', abbr: 'feb', index: 1 },
  { name: 'march', abbr: 'mar', index: 2 },
  { name: 'april', abbr: 'apr', index: 3 },
  { name: 'may', abbr: 'may', index: 4 },
  { name: 'june', abbr: 'jun', index: 5 },
  { name: 'july', abbr: 'jul', index: 6 },
  { name: 'august', abbr: 'aug', index: 7 },
  { name: 'september', abbr: 'sep', index: 8 },
  { name: 'october', abbr: 'oct', index: 9 },
  { name: 'november', abbr: 'nov', index: 10 },
  { name: 'december', abbr: 'dec', index: 11 },
];

export const KNOWN_PLACE_KEYWORDS = [
  'bunnings', 'bunnings warehouse', 'woolies', 'woolworths', 'coles', 'aldi', 'iga', 'chemist', 'pharmacy',
  'chemist warehouse', 'priceline', 'kmart', 'target', 'big w', 'officeworks', 'ikea', 'dan murphy', "dan murphy's",
  'post office', 'australia post', 'hospital', 'clinic', 'medical centre', 'doctor', "doctor's", 'dentist',
  'physio', 'optometrist', 'gym', 'library', 'school', 'park', 'airport', 'cafe', 'restaurant', 'bakery',
  'butcher', 'hardware', 'mechanic', 'service station', 'petrol station', 'bws', 'liquorland', 'amazon', 'qbd', 'dymocks', 'booktopia'
];

export interface RequestedTimeWindow {
  isTodayQuery: boolean;
  daypart: 'morning' | 'afternoon' | 'evening' | 'today';
  startHour: number;
  endHour: number;
}

export function detectRequestedDaypartWindow(qLower: string, localContextWeekday?: string): RequestedTimeWindow | null {
  const hasPastOrFutureModifier = /\b(?:yesterday|tomorrow|last\s+week|next\s+week|last\s+month|next\s+month)\b/i.test(qLower);
  if (hasPastOrFutureModifier) {
    return null;
  }

  if (localContextWeekday) {
    const todayWeekdayLower = localContextWeekday.toLowerCase();
    const allWeekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const mentionedWeekdays = allWeekdays.filter(wd => new RegExp(`\\b${wd}\\b`, 'i').test(qLower));
    if (mentionedWeekdays.length > 0 && !mentionedWeekdays.includes(todayWeekdayLower)) {
      return null;
    }
  }

  const hasMorning = /\b(?:this\s+morning|in\s+the\s+morning|morning|mornings)\b/i.test(qLower);
  const hasAfternoon = /\b(?:this\s+afternoon|in\s+the\s+afternoon|afternoon|afternoons)\b/i.test(qLower);
  const hasEvening = /\b(?:this\s+evening|in\s+the\s+evening|evening|evenings|tonight|this\s+night)\b/i.test(qLower);
  const hasToday = /\b(?:today|todays|today's|what(?:\s+am\s+i|\s+do\s+i\s+have|\s+'s|\s+is)\s+(?:doing|on|scheduled|up\s+to)|schedule|plans|agenda)\b/i.test(qLower);

  if (hasMorning) {
    return { isTodayQuery: true, daypart: 'morning', startHour: 0, endHour: 12 };
  }
  if (hasAfternoon) {
    return { isTodayQuery: true, daypart: 'afternoon', startHour: 12, endHour: 17 };
  }
  if (hasEvening) {
    return { isTodayQuery: true, daypart: 'evening', startHour: 17, endHour: 24 };
  }
  if (hasToday) {
    return { isTodayQuery: true, daypart: 'today', startHour: 0, endHour: 24 };
  }

  return null;
}

export function doesOccurrenceOverlapWindow(
  lifecycle: MemoryTodayLifecycleBounds,
  reqWindow: RequestedTimeWindow
): boolean {
  if (!lifecycle || !lifecycle.isScheduledToday) return false;

  if (lifecycle.startTimeFormatted) {
    const sParsed = parseTimeStringToHM(lifecycle.startTimeFormatted);
    const eParsed = lifecycle.endTimeFormatted ? parseTimeStringToHM(lifecycle.endTimeFormatted) : null;
    
    let evStart = sParsed ? sParsed.hour + sParsed.minute / 60 : 9;
    let evEnd = eParsed ? eParsed.hour + eParsed.minute / 60 : evStart + 1;
    if (evEnd <= evStart) {
      evEnd = evStart + 1;
    }

    const overlapStart = Math.max(evStart, reqWindow.startHour);
    const overlapEnd = Math.min(evEnd, reqWindow.endHour);
    return overlapStart < overlapEnd;
  }

  if (reqWindow.daypart === 'today') {
    return true;
  }

  return false;
}

/**
 * Resolves relative date expressions (e.g. 'tomorrow', 'yesterday', 'today', 'Friday')
 * against localContext.referenceDate and localContext.timeZone into concrete target dates and weekdays.
 */
export function resolveQueryTemporalTargets(
  qLower: string,
  localContext: LocalContextInfo
): ResolvedTemporalTarget[] {
  const targets: ResolvedTemporalTarget[] = [];
  const clientTodayYMD = getYMDInTz(localContext.referenceDate, localContext.timeZone);

  // 1. Day after tomorrow
  if (/\b(?:day\s+after\s+tomorrow)\b/i.test(qLower)) {
    const targetYMD = getRelativeYMD(clientTodayYMD, 2);
    targets.push({
      expression: 'day after tomorrow',
      targetYMD,
      targetWeekday: getWeekdayFromYMD(targetYMD),
      dayOffset: 2,
      isFuture: true,
      isPast: false,
      isToday: false,
    });
  }
  // 2. Tomorrow (if not already matched by day after tomorrow)
  else if (/\b(?:tomorrow|tomorrows|tomorrow's)\b/i.test(qLower)) {
    const targetYMD = getRelativeYMD(clientTodayYMD, 1);
    targets.push({
      expression: 'tomorrow',
      targetYMD,
      targetWeekday: getWeekdayFromYMD(targetYMD),
      dayOffset: 1,
      isFuture: true,
      isPast: false,
      isToday: false,
    });
  }

  // 3. Day before yesterday
  if (/\b(?:day\s+before\s+yesterday)\b/i.test(qLower)) {
    const targetYMD = getRelativeYMD(clientTodayYMD, -2);
    targets.push({
      expression: 'day before yesterday',
      targetYMD,
      targetWeekday: getWeekdayFromYMD(targetYMD),
      dayOffset: -2,
      isFuture: false,
      isPast: true,
      isToday: false,
    });
  }
  // 4. Yesterday (if not matched by day before yesterday)
  else if (/\b(?:yesterday|yesterdays|yesterday's)\b/i.test(qLower)) {
    const targetYMD = getRelativeYMD(clientTodayYMD, -1);
    targets.push({
      expression: 'yesterday',
      targetYMD,
      targetWeekday: getWeekdayFromYMD(targetYMD),
      dayOffset: -1,
      isFuture: false,
      isPast: true,
      isToday: false,
    });
  }

  // 5. Today / Tonight / This morning / This afternoon / This evening
  if (/\b(?:today|todays|today's|tonight|this\s+morning|this\s+afternoon|this\s+evening)\b/i.test(qLower)) {
    const targetYMD = clientTodayYMD;
    if (!targets.some(t => t.targetYMD === targetYMD)) {
      targets.push({
        expression: 'today',
        targetYMD,
        targetWeekday: getWeekdayFromYMD(targetYMD),
        dayOffset: 0,
        isFuture: false,
        isPast: false,
        isToday: true,
      });
    }
  }

  // 6. Explicit Weekdays (e.g. "on Friday", "this Friday", "next Friday", "Friday")
  const allWeekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let wIdx = 0; wIdx < allWeekdays.length; wIdx++) {
    const wd = allWeekdays[wIdx];
    const wdRegex = new RegExp(`\\b(?:on\\s+|this\\s+|next\\s+)?${wd}\\b`, 'i');
    if (wdRegex.test(qLower)) {
      const todayWd = getWeekdayFromYMD(clientTodayYMD);
      const todayIdx = allWeekdays.indexOf(todayWd);
      let diff = wIdx - todayIdx;
      if (new RegExp(`\\bnext\\s+${wd}\\b`, 'i').test(qLower)) {
        diff = diff <= 0 ? diff + 7 : diff + 7;
      } else if (diff < 0 && !new RegExp(`\\blast\\s+${wd}\\b`, 'i').test(qLower)) {
        diff += 7;
      } else if (new RegExp(`\\blast\\s+${wd}\\b`, 'i').test(qLower)) {
        diff = diff >= 0 ? diff - 7 : diff;
      }
      const targetYMD = getRelativeYMD(clientTodayYMD, diff);
      if (!targets.some(t => t.targetYMD === targetYMD)) {
        targets.push({
          expression: wd,
          targetYMD,
          targetWeekday: wd,
          dayOffset: diff,
          isFuture: diff > 0,
          isPast: diff < 0,
          isToday: diff === 0,
        });
      }
    }
  }

  return targets;
}

/**
 * Evaluates whether an active memory represents a recurring schedule that applies to a target weekday.
 * Strictly distinguishes genuine recurring patterns ('every Friday', 'each Friday', 'Fridays') from
 * non-recurring single events on a specific date (e.g. 'on Friday, 4 September 2026').
 */
export function doesMemoryMatchRecurringWeekday(m: any, targetWeekday: string): boolean {
  if (m.isDone === true || m.interpretation?.status === 'done' || m.interpretation?.status === 'dismissed') {
    return false;
  }

  const isRecurringMode = m.interpretation?.resurfacing?.mode === 'recurring' ||
    m.interpretation?.intent === 'recurring_schedule' ||
    m.interpretation?.recurrence !== undefined;

  const interpText = [
    m.interpretation?.resurfacing?.timing || '',
    m.interpretation?.original_time_expression || '',
    m.interpretation?.event_time_expression || '',
    m.interpretation?.content || '',
  ].join(' ').toLowerCase();

  const textToCheck = interpText.trim().length > 0 ? interpText : (m.originalText || '').toLowerCase();

  const targetDay = targetWeekday.toLowerCase();
  const targetShort = targetDay.slice(0, 3);

  const hasEveryOrDaily = /\b(?:every|each|daily|weekly|fortnightly|monthly)\b/i.test(textToCheck);
  const hasPluralWeekday = new RegExp(`\\b${targetDay}s\\b`, 'i').test(textToCheck);

  if (!isRecurringMode && !hasEveryOrDaily && !hasPluralWeekday) {
    return false;
  }

  const isEveryDay = textToCheck.includes('every day') || textToCheck.includes('daily');
  const isEveryWeekday = textToCheck.includes('every weekday') && !['saturday', 'sunday'].includes(targetDay);
  const isEveryWeekend = textToCheck.includes('every weekend') && ['saturday', 'sunday'].includes(targetDay);

  const isTargetDayMatch =
    new RegExp(`\\b(?:every|each)\\s+[^.!?]*\\b${targetDay}\\b`, 'i').test(textToCheck) ||
    new RegExp(`\\b(?:every|each)\\s+[^.!?]*\\b${targetShort}\\b`, 'i').test(textToCheck) ||
    new RegExp(`\\b${targetDay}s\\b`, 'i').test(textToCheck);

  return isEveryDay || isEveryWeekday || isEveryWeekend || isTargetDayMatch;
}

export function buildDynamicRetrievalContext(
  query: string,
  memories: any[],
  calendarEvents: any[],
  activeRelationships: Array<{ person: string; role: string; normalized_role: string }>,
  localContext: LocalContextInfo
): DynamicRetrievalResult {
  const qLower = query.toLowerCase();

  // 1. Resolve Relationships and Entity Cues
  const { resolvedEntities, ambiguousEntities, expandedTokens } = resolveRelationshipsInQuery(query, activeRelationships);
  const resolvedPeople: string[] = [];
  const resolvedRoles: string[] = [];

  for (const re of resolvedEntities) {
    if (!resolvedPeople.includes(re.resolvedPerson)) resolvedPeople.push(re.resolvedPerson);
    if (!resolvedRoles.includes(re.normalizedRole)) resolvedRoles.push(re.normalizedRole);
  }

  // Include direct mentions of active people in the query
  for (const rel of activeRelationships) {
    if (rel.person && qLower.includes(rel.person.toLowerCase())) {
      if (!resolvedPeople.includes(rel.person)) resolvedPeople.push(rel.person);
      if (rel.role && !resolvedRoles.includes(rel.role)) resolvedRoles.push(rel.role);
      if (rel.normalized_role && !resolvedRoles.includes(rel.normalized_role)) resolvedRoles.push(rel.normalized_role);
    }
  }

  // If ambiguous entities exist (e.g. 2 brothers), include all candidates without arbitrarily dropping one
  for (const amb of ambiguousEntities) {
    for (const cand of amb.candidatePeople) {
      if (!resolvedPeople.includes(cand)) resolvedPeople.push(cand);
    }
    if (!resolvedRoles.includes(amb.normalizedRole)) resolvedRoles.push(amb.normalizedRole);
  }

  // 2. Extract Places from Query
  const detectedPlaces: string[] = [];

  // Match known place keywords
  for (const kp of KNOWN_PLACE_KEYWORDS) {
    const regex = new RegExp(`\\b${kp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(qLower)) {
      if (!detectedPlaces.includes(kp)) detectedPlaces.push(kp);
    }
  }

  // Match places from stored memories
  for (const m of memories) {
    const mPlaces: string[] = Array.isArray(m.interpretation?.places) ? m.interpretation.places : [];
    for (const p of mPlaces) {
      const pStr = (p || '').trim();
      if (pStr.length >= 3 && qLower.includes(pStr.toLowerCase())) {
        if (!detectedPlaces.includes(pStr)) detectedPlaces.push(pStr);
      }
    }
  }

  // Match prepositional place patterns: "at [Place]", "from [Place]", "in [Place]"
  const prepPlaceRegex = /\b(?:at|from|to|in|near)\s+([A-Za-z0-9'&]+(?:\s+[A-Za-z0-9'&]+)?)\b/g;
  let prepMatch: RegExpExecArray | null;
  while ((prepMatch = prepPlaceRegex.exec(query)) !== null) {
    const candidate = prepMatch[1].trim();
    const candLower = candidate.toLowerCase();
    if (
      candLower.length >= 3 &&
      !ASK_STOP_WORDS.has(candLower) &&
      !RETRIEVAL_MONTHS.some(m => m.name === candLower || m.abbr === candLower) &&
      !/\b(?:today|tomorrow|yesterday|morning|afternoon|evening|night|week|month|year|do|see|get|have|make|buy)\b/i.test(candLower)
    ) {
      if (!detectedPlaces.some(dp => dp.toLowerCase() === candLower)) {
        detectedPlaces.push(candidate);
      }
    }
  }

  // 3. Extract Topics & Meaningful Concept Keywords
  const isGenericScheduleIntent = detectGenericScheduleIntent(qLower);
  const rawTokens = qLower.replace(/[^\w\s$]/g, ' ').split(/\s+/).filter(Boolean);
  const topicsAndKeywords: string[] = [];

  for (const token of rawTokens) {
    if (
      token.length >= 3 &&
      !ASK_STOP_WORDS.has(token) &&
      !GENERIC_SCHEDULE_TERMS.has(token) &&
      !resolvedPeople.some(p => p.toLowerCase() === token) &&
      !resolvedRoles.some(r => r.toLowerCase() === token) &&
      !detectedPlaces.some(pl => pl.toLowerCase() === token)
    ) {
      topicsAndKeywords.push(token);
    }
  }

  // Check 2-word ngrams that match memory topics, cues, or explicit subjects
  for (let i = 0; i < rawTokens.length - 1; i++) {
    const w1 = rawTokens[i];
    const w2 = rawTokens[i + 1];
    if (GENERIC_SCHEDULE_TERMS.has(w1) && GENERIC_SCHEDULE_TERMS.has(w2)) continue;
    if ((ASK_STOP_WORDS.has(w1) || GENERIC_SCHEDULE_TERMS.has(w1)) && (ASK_STOP_WORDS.has(w2) || GENERIC_SCHEDULE_TERMS.has(w2))) continue;
    const bigram = `${w1} ${w2}`;
    if (bigram.length >= 5) {
      for (const m of memories) {
        const mTopics = (m.interpretation?.topics || []).map((t: string) => t.toLowerCase());
        const mCues = (m.interpretation?.retrieval_cues || []).map((c: string) => c.toLowerCase());
        const mSubject = (m.interpretation?.subject || '').toLowerCase();
        if (
          mTopics.some((t: string) => t.includes(bigram)) ||
          mCues.some((c: string) => c.includes(bigram)) ||
          (mSubject && (mSubject.includes(bigram) || bigram.includes(mSubject)))
        ) {
          if (!topicsAndKeywords.includes(bigram)) {
            topicsAndKeywords.push(bigram);
          }
        }
      }
    }
  }

  // Also check full explicit subjects against the query
  for (const m of memories) {
    const mSub = (m.interpretation?.subject || '').trim();
    if (mSub && mSub.length >= 2) {
      const mSubLower = mSub.toLowerCase();
      if (qLower.includes(mSubLower)) {
        if (!topicsAndKeywords.includes(mSubLower)) {
          topicsAndKeywords.push(mSubLower);
        }
      }
    }
  }

  // 4. Extract Temporal Anchors
  const detectedMonths: string[] = [];
  const detectedRelativeExprs: string[] = [];

  for (const m of RETRIEVAL_MONTHS) {
    const mRegex = new RegExp(`\\b(?:in\\s+)?(${m.name}|${m.abbr})\\b`, 'i');
    if (mRegex.test(qLower)) {
      if (!detectedMonths.includes(m.name)) detectedMonths.push(m.name);
    }
  }

  const relativeTimePatterns = [
    'today', 'tomorrow', 'yesterday', 'this morning', 'yesterday morning', 'yesterday afternoon',
    'last night', 'this weekend', 'last weekend', 'next weekend', 'this week', 'last week', 'next week',
    'this month', 'last month', 'next month', 'black friday', 'christmas', 'easter',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
  ];

  for (const relTime of relativeTimePatterns) {
    if (qLower.includes(relTime)) {
      if (!detectedRelativeExprs.includes(relTime)) detectedRelativeExprs.push(relTime);
    }
  }

  const clientTodayYMD = getYMDInTz(localContext.referenceDate, localContext.timeZone);
  const resolvedTemporalTargets = resolveQueryTemporalTargets(qLower, localContext);
  const reqWindow = detectRequestedDaypartWindow(qLower, localContext.weekday);
  const hasTemporalConstraint = detectedMonths.length > 0 || detectedRelativeExprs.length > 0 || reqWindow !== null || resolvedTemporalTargets.length > 0;

  // 5. Score and Rank Memories
  const memoryScores = new Map<string, number>();
  const nowMs = Date.now();

  for (const m of memories) {
    let score = 0;
    const mContent = (m.interpretation?.content || '').toLowerCase();
    const mOrig = (m.originalText || '').toLowerCase();
    const mCombinedText = `${mOrig} ${mContent}`;
    const mPeople: string[] = (m.interpretation?.people || []).map((p: string) => p.toLowerCase());
    const mPlaces: string[] = (m.interpretation?.places || []).map((p: string) => p.toLowerCase());
    const mTopics: string[] = (m.interpretation?.topics || []).map((t: string) => t.toLowerCase());
    const mContexts: string[] = (m.interpretation?.contexts || []).map((c: string) => c.toLowerCase());
    const mCues: string[] = (m.interpretation?.retrieval_cues || []).map((rc: string) => rc.toLowerCase());
    const mRels: Array<{ person: string; role: string; norm: string }> = (m.interpretation?.relationships || []).map((r: any) => ({
      person: (r.person || '').toLowerCase(),
      role: (r.role || '').toLowerCase(),
      norm: normalizeRoleName(r.role || '')
    }));
    const mTiming = `${m.interpretation?.original_time_expression || ''} ${m.interpretation?.reminder_time_expression || ''} ${m.interpretation?.event_time_expression || ''} ${m.interpretation?.resurfacing?.timing || ''}`.toLowerCase();

    // A. Person / Resolved Entity Match
    for (const p of resolvedPeople) {
      const pLower = p.toLowerCase();
      if (mPeople.includes(pLower)) {
        score += 45;
      } else if (mCombinedText.includes(pLower)) {
        score += 35;
      }
      if (mRels.some(r => r.person === pLower)) {
        score += 25;
      }
      if (mCues.some(c => c.includes(pLower))) {
        score += 20;
      }
    }

    // B. Role / Relationship Match
    for (const r of resolvedRoles) {
      const rLower = r.toLowerCase();
      const rNorm = normalizeRoleName(r);
      if (mRels.some(rel => rel.norm === rNorm || rel.role === rLower)) {
        score += 30;
      }
      if (mCues.some(c => c.includes(rLower) || (rNorm && c.includes(rNorm)))) {
        score += 25;
      }
      if (mCombinedText.includes(rLower) || (rNorm && mCombinedText.includes(rNorm))) {
        score += 15;
      }
    }

    // C. Place Match
    for (const pl of detectedPlaces) {
      const plLower = pl.toLowerCase();
      if (mPlaces.some(p => p.includes(plLower) || plLower.includes(p))) {
        score += 40;
      } else if (mCombinedText.includes(plLower)) {
        score += 30;
      }
      if (mCues.some(c => c.includes(plLower)) || mContexts.some(c => c.includes(plLower))) {
        score += 20;
      }
    }

    // D. Topic / Context / Retrieval Cue Match
    for (const kw of topicsAndKeywords) {
      const kwLower = kw.toLowerCase();
      if (mTopics.some(t => t.includes(kwLower) || kwLower.includes(t))) {
        score += 25;
      }
      if (mContexts.some(c => c.includes(kwLower) || kwLower.includes(c))) {
        score += 20;
      }
      if (mCues.some(rc => rc.includes(kwLower))) {
        score += 15;
      }
      if (mCombinedText.includes(kwLower)) {
        score += 10;
      }
    }

    // D2. Explicit Subject Match (Strong Retrieval Cue)
    const mSubject = (m.interpretation?.subject || '').trim().toLowerCase();
    if (mSubject) {
      if (qLower.includes(mSubject)) {
        score += 60;
      } else {
        const subTokens = mSubject.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2 && !ASK_STOP_WORDS.has(t));
        if (subTokens.length > 0) {
          const matchedCount = subTokens.filter(t => qLower.includes(t)).length;
          if (matchedCount > 0) {
            score += Math.round((matchedCount / subTokens.length) * 45);
          }
        }
      }
    }

    // E. Temporal Match
    if (hasTemporalConstraint) {
      // 1. Present-day / recurring occurrence resolution using deterministic single lifecycle engine
      if (reqWindow) {
        const lifecycle = evaluateMemoryTodayLifecycle(m, localContext, clientTodayYMD, getTimeStrInTz);
        if (lifecycle && doesOccurrenceOverlapWindow(lifecycle, reqWindow)) {
          score += 50;
        }
      }

      // 2. Resolved relative temporal targets (e.g. tomorrow, yesterday, specific weekday)
      for (const tt of resolvedTemporalTargets) {
        const matchesTargetDate = (iso?: string | null) => {
          if (!iso) return false;
          try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return false;
            return getYMDInTz(d, localContext.timeZone) === tt.targetYMD;
          } catch {
            return false;
          }
        };

        if (
          matchesTargetDate(m.interpretation?.resolved_datetime) ||
          matchesTargetDate(m.interpretation?.event_datetime) ||
          matchesTargetDate(m.interpretation?.reminder_datetime) ||
          matchesTargetDate(m.interpretation?.subject_resolved_date) ||
          (tt.isPast && matchesTargetDate(m.createdAt))
        ) {
          score += 50;
        }

        if (doesMemoryMatchRecurringWeekday(m, tt.targetWeekday)) {
          score += 50;
        }
      }

      // 3. Month matching
      for (const month of detectedMonths) {
        if (mTiming.includes(month) || mCombinedText.includes(month)) {
          score += 40;
        }
        const checkIsoMonth = (iso?: string | null) => {
          if (!iso) return false;
          try {
            const d = new Date(iso);
            return RETRIEVAL_MONTHS[d.getMonth()]?.name === month;
          } catch {
            return false;
          }
        };
        if (
          checkIsoMonth(m.interpretation?.resolved_datetime) ||
          checkIsoMonth(m.interpretation?.event_datetime) ||
          checkIsoMonth(m.interpretation?.reminder_datetime) ||
          checkIsoMonth(m.createdAt)
        ) {
          score += 30;
        }
      }

      // 4. Relative expression matching (supplementary evidence)
      for (const relExpr of detectedRelativeExprs) {
        const isPresentDayWord = ['today', 'this morning', 'this afternoon', 'this evening', 'tonight'].includes(relExpr);
        if (reqWindow && isPresentDayWord) {
          continue;
        }

        if (mTiming.includes(relExpr) || mCombinedText.includes(relExpr)) {
          score += 35;
        }
      }
    } else {
      // Minor recency bonus when no temporal constraint exists (0 to +2 max)
      const ageHours = (nowMs - new Date(m.createdAt).getTime()) / (1000 * 60 * 60);
      const recencyBoost = Math.max(0, 2 - (ageHours / (24 * 30)) * 2);
      score += recencyBoost;
    }

    // Boost reminder or scheduled items for generic schedule queries
    if (isGenericScheduleIntent) {
      if (m.interpretation?.kind === 'reminder' || m.interpretation?.intent === 'appointment' || m.interpretation?.resolved_datetime) {
        score += 15;
      }
    }

    // Direct token coverage ratio
    if (topicsAndKeywords.length > 0) {
      const matchedKwCount = topicsAndKeywords.filter(kw => mCombinedText.includes(kw.toLowerCase())).length;
      const coverage = matchedKwCount / topicsAndKeywords.length;
      score += Math.round(coverage * 15);
    }

    memoryScores.set(m.id, score);
  }

  // F. Sibling / Same-Capture Relationship Expansion
  // If a high-scoring memory was split from a multi-memory capture, allow its siblings with matching originalText to enter
  const highScoringMemories = memories.filter(m => (memoryScores.get(m.id) || 0) >= 25);
  for (const highM of highScoringMemories) {
    if (highM.originalText && highM.originalText.trim().length > 10) {
      const siblings = memories.filter(m =>
        m.id !== highM.id &&
        m.originalText === highM.originalText &&
        Math.abs(new Date(m.createdAt).getTime() - new Date(highM.createdAt).getTime()) <= 5000
      );
      for (const sib of siblings) {
        const currentScore = memoryScores.get(sib.id) || 0;
        memoryScores.set(sib.id, currentScore + 15);
      }
    }
  }

  // Assemble candidate memories (cap at MAX_DYNAMIC_MEMORIES)
  const MAX_DYNAMIC_MEMORIES = 8;
  const hasSpecificContentAnchors = resolvedPeople.length > 0 || resolvedRoles.length > 0 || detectedPlaces.length > 0 || topicsAndKeywords.length > 0;
  const hasSpecificAnchors = hasSpecificContentAnchors || hasTemporalConstraint;

  const scoredMemories = memories
    .map(m => ({ memory: m, score: memoryScores.get(m.id) || 0 }))
    .sort((a, b) => b.score - a.score);

  let candidateMemories: any[] = [];

  if (hasSpecificAnchors || isGenericScheduleIntent) {
    // Only include memories with meaningful positive score
    candidateMemories = scoredMemories
      .filter(item => item.score > 0)
      .slice(0, MAX_DYNAMIC_MEMORIES)
      .map(item => item.memory);
  } else {
    // Broad general question fallback: most recent memories
    candidateMemories = scoredMemories
      .slice(0, Math.min(MAX_DYNAMIC_MEMORIES, 5))
      .map(item => item.memory);
  }

  // 6. Filter & Rank Calendar Events
  const MAX_DYNAMIC_CALENDAR = 8;
  const startOfTodayMs = nowMs - (12 * 60 * 60 * 1000);

  const scoredCalendarEvents = calendarEvents.map(e => {
    let calScore = 0;
    const eTitle = (e.title || '').toLowerCase();
    const eDesc = (e.description || '').toLowerCase();
    const eLoc = (e.location || '').toLowerCase();
    const eAttendees = (e.attendees || []).map((a: string) => a.toLowerCase());
    const eText = `${eTitle} ${eDesc} ${eLoc} ${eAttendees.join(' ')}`;

    for (const p of resolvedPeople) {
      const pLower = p.toLowerCase();
      if (eAttendees.some((a: string) => a.includes(pLower)) || eText.includes(pLower)) {
        calScore += 40;
      }
    }
    for (const r of resolvedRoles) {
      if (eText.includes(r.toLowerCase())) calScore += 25;
    }
    for (const pl of detectedPlaces) {
      if (eLoc.includes(pl.toLowerCase()) || eText.includes(pl.toLowerCase())) calScore += 35;
    }
    for (const kw of topicsAndKeywords) {
      const kwLower = kw.toLowerCase();
      const kwSingular = kwLower.endsWith('s') && kwLower.length > 3 ? kwLower.slice(0, -1) : kwLower;
      if (eText.includes(kwLower) || eText.includes(kwSingular)) calScore += 20;
    }

    if (hasTemporalConstraint) {
      // 1. Resolved relative temporal targets (e.g. tomorrow, yesterday, specific weekday)
      for (const tt of resolvedTemporalTargets) {
        if (e.start_datetime) {
          try {
            const eStartDate = new Date(e.start_datetime);
            const eEndDate = e.end_datetime ? new Date(e.end_datetime) : eStartDate;
            const eStartYMD = getYMDInTz(eStartDate, localContext.timeZone);
            const eEndYMD = getYMDInTz(eEndDate, localContext.timeZone);
            // Match if target date is start date, or falls within multi-day/all-day event range
            if (eStartYMD === tt.targetYMD || (tt.targetYMD >= eStartYMD && tt.targetYMD <= eEndYMD)) {
              calScore += 50;
            }
          } catch {}
        }
      }

      // 2. Present-day window matching
      if (reqWindow && e.start_datetime) {
        try {
          const eStartDate = new Date(e.start_datetime);
          const eEndDate = e.end_datetime ? new Date(e.end_datetime) : new Date(eStartDate.getTime() + 60 * 60 * 1000);
          const eStartYMD = getYMDInTz(eStartDate, localContext.timeZone);
          if (eStartYMD === clientTodayYMD) {
            if (e.is_all_day) {
              if (reqWindow.daypart === 'today') {
                calScore += 50;
              }
            } else {
              const sTimeStr = getTimeStrInTz(eStartDate, localContext.timeZone, localContext.language);
              const eTimeStr = getTimeStrInTz(eEndDate, localContext.timeZone, localContext.language);
              const sParsed = parseTimeStringToHM(sTimeStr);
              const eParsed = parseTimeStringToHM(eTimeStr);
              let evStart = sParsed ? sParsed.hour + sParsed.minute / 60 : 0;
              let evEnd = eParsed ? eParsed.hour + eParsed.minute / 60 : evStart + 1;
              if (evEnd <= evStart) evEnd = evStart + 1;

              const overlapStart = Math.max(evStart, reqWindow.startHour);
              const overlapEnd = Math.min(evEnd, reqWindow.endHour);
              if (overlapStart < overlapEnd) {
                calScore += 50;
              }
            }
          }
        } catch {}
      }

      for (const month of detectedMonths) {
        try {
          const d = new Date(e.start_datetime);
          if (RETRIEVAL_MONTHS[d.getMonth()]?.name === month || eText.includes(month)) {
            calScore += 35;
          }
        } catch {}
      }
      for (const relExpr of detectedRelativeExprs) {
        const isPresentDayWord = ['today', 'this morning', 'this afternoon', 'this evening', 'tonight'].includes(relExpr);
        if (reqWindow && isPresentDayWord) {
          continue;
        }
        if (eText.includes(relExpr)) calScore += 30;
      }
    }

    // Generic schedule / upcoming intent: include upcoming / future calendar events
    if (isGenericScheduleIntent) {
      if (e.start_datetime) {
        try {
          const evStartDate = new Date(e.start_datetime);
          const evTime = evStartDate.getTime();
          if (evTime >= startOfTodayMs) {
            calScore += 30;
          }
        } catch {}
      }
    }

    return { event: e, score: calScore };
  });

  let candidateCalendarEvents: any[] = [];
  if (hasSpecificContentAnchors || hasTemporalConstraint || isGenericScheduleIntent) {
    candidateCalendarEvents = scoredCalendarEvents
      .filter(item => item.score > 0)
      .sort((a, b) => {
        // High specific relevance takes precedence if significantly different
        if (Math.abs(b.score - a.score) >= 15) {
          return b.score - a.score;
        }
        // Otherwise, preserve chronological ordering (earliest upcoming event first)
        const timeA = a.event.start_datetime ? new Date(a.event.start_datetime).getTime() : 0;
        const timeB = b.event.start_datetime ? new Date(b.event.start_datetime).getTime() : 0;
        return timeA - timeB;
      })
      .slice(0, MAX_DYNAMIC_CALENDAR)
      .map(item => item.event);
  } else {
    candidateCalendarEvents = [];
  }

  return {
    candidateMemories,
    candidateCalendarEvents,
    retrievalMetadata: {
      resolvedPeople,
      resolvedRoles,
      detectedPlaces,
      topicsAndKeywords,
      temporalAnchors: {
        hasTemporalConstraint,
        months: detectedMonths,
        relativeExpressions: detectedRelativeExprs,
        resolvedTargets: resolvedTemporalTargets.map(t => ({
          expression: t.expression,
          targetYMD: t.targetYMD,
          targetWeekday: t.targetWeekday,
          dayOffset: t.dayOffset,
        })),
      },
      expandedTokens,
      resolvedEntities,
      ambiguousEntities,
      candidateCount: candidateMemories.length,
      totalMemories: memories.length,
    }
  };
}

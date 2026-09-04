import { formatLocalTimeContext, getYMDInTz, getTimeStrInTz, parseTimeStringToHM } from '../utils/time';
import { readMemories } from '../db/memories';
import { readCalendarEvents } from '../calendar/store';
import { readActiveRelationships } from '../relationships/index';
import { isDependentReminderClause } from '../ai/splitter';
import { AnticipatoryMode, OccasionOccurrence } from '../../src/types';
import { classifyAnticipatoryMode, isRecurringRoutineText } from '../anticipatory/classifier';
import { buildAnticipatoryPrompt } from '../anticipatory/promptBuilder';
import { getActiveUserOccasionOccurrences } from '../occasions/manager';
import { daysBetween } from '../occasions/dateResolver';

export function getOccasionTemporalDescription(targetYMD: string, todayYMD: string, timeZone = 'Australia/Sydney'): string {
  const diff = daysBetween(todayYMD, targetYMD);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff > 1 && diff <= 7) {
    const [y, m, d] = targetYMD.split('-').map(Number);
    const targetDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(targetDate);
    return `this ${dayName}`;
  }
  const [y, m, d] = targetYMD.split('-').map(Number);
  const targetDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(targetDate);
}

export type LocalContextInfo = ReturnType<typeof formatLocalTimeContext>;

export interface MemoryTodayLifecycleBounds {
  isScheduledToday: boolean;
  startDate: Date | null;
  endDate: Date | null;
  startTimeFormatted: string;
  endTimeFormatted: string;
  lifecycleStage: 'upcoming' | 'current' | 'post_event' | 'all_day';
  cleanTitle: string;
  isRecurring: boolean;
}

// Extract clean preparation item strings from stored preparation memories
export function extractCleanPrepItems(prepMemories: any[] = []): string[] {
  const items: string[] = [];
  for (const m of prepMemories) {
    let raw = (m.interpretation?.content || m.originalText || '').trim();
    // remove leading bullet, numbers, or dashes
    raw = raw.replace(/^[-•*0-9.)\s]+/, '').trim();
    if (raw.length > 0) {
      // Capitalize first letter
      const cap = raw.charAt(0).toUpperCase() + raw.slice(1);
      // Check deduplication (e.g. avoid repeating "Ask about blood test" and "Ask about my 6mnth blood test" if they are the same intent)
      const isDup = items.some((existing) => {
        const eLower = existing.toLowerCase();
        const cLower = cap.toLowerCase();
        return (
          eLower === cLower ||
          (eLower.includes('blood test') && cLower.includes('blood test')) ||
          (eLower.includes('script') && cLower.includes('script'))
        );
      });
      if (!isDup) {
        items.push(cap);
      }
    }
  }
  return items;
}

// Find preparation memories associated with a calendar appointment
export function findPreparationMemoriesForEvent(
  ev: any,
  memories: any[],
  activeRelationships: Array<{ person: string; role: string; normalized_role: string }> = []
): any[] {
  const matched: any[] = [];
  const seenIds = new Set<string>();

  const rawTitle = (ev.title || '').trim();
  const cleanTitle = rawTitle
    .replace(/\s*(?:—|-|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?\s*$/i, '')
    .trim();
  const titleLower = cleanTitle.toLowerCase();

  let eventPerson = '';
  const drMatch = cleanTitle.match(/^(?:Dr\.?|Doctor)\s+([A-Za-z0-9\s'-]+)/i);
  if (drMatch) {
    eventPerson = drMatch[1].trim();
  } else {
    const withMatch = cleanTitle.match(
      /^(?:Meeting|Sync|Catch\s*up|Catchup|Call|Discussion|Lunch|Dinner|Coffee|Breakfast|Drinks|Seeing)\s+(?:with\s+)?([A-Za-z0-9\s'-]+)/i
    );
    if (withMatch) {
      eventPerson = withMatch[1].trim();
    }
  }

  const isMedicalEvent =
    Boolean(drMatch) ||
    /^(?:Dentist|Physio|Physiotherapist|GP|Doctor|Specialist|Therapist|Psychiatrist|Psychologist|Optometrist|Vet|Veterinarian|Chiropractor|Podiatrist)\b/i.test(
      cleanTitle
    ) ||
    activeRelationships.some(
      (r) =>
        r.normalized_role === 'doctor' &&
        (titleLower.includes(r.person.toLowerCase()) || titleLower.includes('dr'))
    );

  for (const m of memories) {
    if (
      m.isDone ||
      m.interpretation?.status === 'completed' ||
      m.interpretation?.status === 'dismissed'
    )
      continue;

    // Preparation memories for an upcoming event must have been created before the appointment completed
    if (ev.start_datetime && m.createdAt) {
      const evStart = new Date(ev.start_datetime).getTime();
      const memCreated = new Date(m.createdAt).getTime();
      if (!isNaN(evStart) && !isNaN(memCreated) && memCreated > evStart + 15 * 60 * 1000) {
        continue;
      }
    }

    // 1. Direct explicit link
    if (
      m.interpretation?.linked_event_id &&
      String(m.interpretation.linked_event_id) === String(ev.id)
    ) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        matched.push(m);
      }
      continue;
    }

    const kind = (m.interpretation?.kind || '').toLowerCase();
    // Exclude static entity relationships, directory contact records, or preferences
    if (['relationship', 'profile', 'preference'].includes(kind)) continue;

    const content = (m.interpretation?.content || '').toLowerCase();
    const origText = (m.originalText || '').toLowerCase();

    // Exclude fact definitions like "X is my doctor" or phone numbers
    if (
      /\bis my (?:doctor|gp|physio|dentist|lawyer|accountant|wife|husband|friend)\b/i.test(content) ||
      /\bphone number\b/i.test(content)
    ) {
      continue;
    }

    const people = (m.interpretation?.people || []).map((p: string) => p.toLowerCase());
    const topics = (m.interpretation?.topics || []).map((t: string) => t.toLowerCase());
    const contexts = (m.interpretation?.contexts || []).map((c: string) => c.toLowerCase());
    const cues = (m.interpretation?.retrieval_cues || []).map((c: string) => c.toLowerCase());

    const hasActionOrDiscussionIntent =
      /(?:ask|discuss|mention|check|prepare|renew|scripts?|prescription|blood test|referral|scan|x-ray|symptoms?|results?|follow up|remember)/i.test(
        content
      ) ||
      /(?:ask|discuss|mention|check|prepare|renew|scripts?|prescription|blood test|referral|scan|x-ray|symptoms?|results?|follow up|remember)/i.test(
        origText
      );

    // 2. Specific person match with discussion intent
    if (
      eventPerson &&
      (people.includes(eventPerson.toLowerCase()) ||
        content.includes(eventPerson.toLowerCase()) ||
        origText.includes(eventPerson.toLowerCase())) &&
      hasActionOrDiscussionIntent
    ) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        matched.push(m);
      }
      continue;
    }

    // 3. Medical / Doctor appointment preparation matching
    if (isMedicalEvent) {
      const isPrepContext =
        contexts.some(
          (c) =>
            c.includes('appointment') ||
            c.includes('medical') ||
            c.includes('doctor')
        ) ||
        cues.some(
          (c) =>
            c.includes('doctor') ||
            c.includes('appointment') ||
            c.includes('checkup')
        );

      const isMedicalTopic =
        topics.some((t) =>
          [
            'blood test',
            'health',
            'medical',
            'medication',
            'prescriptions',
            'pharmacy',
            'skin check',
            'referral',
            'scan',
          ].includes(t)
        ) ||
        /(?:blood\s*test|script|prescription|refill|referral|scan|x-ray|medication|ask\s+about|renew\s+scripts?)/i.test(
          content
        ) ||
        /(?:blood\s*test|script|prescription|refill|referral|scan|x-ray|medication|ask\s+about|renew\s+scripts?)/i.test(
          origText
        );

      if (isPrepContext && isMedicalTopic && hasActionOrDiscussionIntent) {
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          matched.push(m);
        }
        continue;
      }
    }
  }

  return matched;
}

// -------------------------------------------------------------
// Deterministic Anticipatory Intelligence for Post-Event Reflection (V2)
// -------------------------------------------------------------
export function extractPreparationPhrases(prepMemories: any[] = [], cleanTitle: string): string[] {
  const extracted: string[] = [];
  const titleWords = new Set(
    cleanTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  );

  for (const m of prepMemories) {
    const text = (m.interpretation?.content || m.originalText || '').trim();
    const topics: string[] = Array.isArray(m.interpretation?.topics) ? m.interpretation.topics : [];

    // Extract action intent from capture phrases like "Ask about my 6mnth blood test and script renewals"
    const askMatch = text.match(
      /(?:ask\s+about|ask\s+if|discuss|mention|check\s+about|prepare\s+for|talk\s+about|remember\s+to\s+ask\s+about|renew)\s+(?:my\s+|the\s+)?(.+)/i
    );
    if (askMatch && askMatch[1]) {
      const parts = askMatch[1].split(/\s+(?:and|&)\s+/i);
      for (const part of parts) {
        let cleanPart = part.replace(/[.,?!]+$/, '').trim();
        cleanPart = cleanPart.replace(/^(?:my|the|a|an)\s+/i, '');
        if (cleanPart && cleanPart.length > 2) {
          extracted.push(cleanPart);
        }
      }
    }

    // Specific topics only (filter out generic categorizations)
    const genericTopics = [
      'appointment',
      'calendar',
      'doctor',
      'meeting',
      'remember',
      'event',
      'today',
      'health',
      'medical',
      'personal',
      'general',
      'household',
    ];
    for (const t of topics) {
      const lower = t.toLowerCase().trim();
      if (
        lower &&
        lower.length > 2 &&
        !genericTopics.includes(lower) &&
        !titleWords.has(lower)
      ) {
        extracted.push(t.trim());
      }
    }
  }

  // Deduplicate and retain cleanest unique phrases
  const unique: string[] = [];
  for (const item of extracted) {
    const lower = item.toLowerCase();
    if (
      !unique.some(
        (u) =>
          u.toLowerCase() === lower ||
          u.toLowerCase().includes(lower) ||
          lower.includes(u.toLowerCase())
      )
    ) {
      unique.push(item);
    }
  }

  return unique;
}

export function formatTopicToActionPhrase(phrase: string): string {
  const lower = phrase.toLowerCase().trim();

  // Blood test
  if (lower.includes('blood test') || lower.includes('blood work') || lower.includes('pathology') || lower.includes('lab test')) {
    return 'your blood test';
  }
  // Script / prescription
  if (lower.includes('script') || lower.includes('prescription') || lower.includes('medication') || lower.includes('refill')) {
    return 'scripts';
  }
  // Referral
  if (lower.includes('referral') || lower.includes('specialist')) {
    return 'that referral';
  }
  // X-ray / scan / MRI / ultrasound
  if (lower.includes('x-ray') || lower.includes('scan') || lower.includes('mri') || lower.includes('ultrasound')) {
    return 'that scan';
  }
  // Follow-up appointment
  if (lower.includes('follow up') || lower.includes('next appointment') || lower.includes('checkup')) {
    return 'the follow-up';
  }
  // General: if phrase already starts with a verb like "book", "schedule", "call", "email", "send"
  if (/^(?:book|schedule|call|email|send|order|check|buy|pay)\s+/i.test(phrase)) {
    return phrase.toLowerCase().trim();
  }

  // Fallback for general topics: "follow up on <phrase>"
  const cleaned = phrase.replace(/^(?:my|the|a|an)\s+/i, '').trim();
  return cleaned;
}

export function generatePostEventReflectionPrompt(
  rawTitle: string,
  prepMemories: any[] = [],
  activeRelationships: any[] = []
): { prompt: string; isAnticipatory: boolean; cleanTitle: string } {
  const res = buildAnticipatoryPrompt({
    stage: 'POST',
    title: rawTitle,
    memories: prepMemories,
    activeRelationships,
  });
  return {
    prompt: res.prompt,
    isAnticipatory: true,
    cleanTitle: res.cleanTitle,
  };
}

// Helper to extract clean event person/subject from title or relationships
export function extractEventPerson(title: string, activeRelationships: any[] = []): string {
  const titleTrimmed = (title || '').trim();
  const titleLower = titleTrimmed.toLowerCase();

  // 1. Check active relationships (e.g. Mum -> Mother)
  const matchedRel = activeRelationships.find(
    (r) =>
      r &&
      r.is_active &&
      r.person &&
      (titleLower.includes(r.person.toLowerCase()) || (r.role && titleLower.includes(r.role.toLowerCase())))
  );
  if (matchedRel) return matchedRel.person;

  // 2. Strip leading verbs, pronouns, and visit/meeting phrases
  // e.g. "I visit Mum", "Visit Mum", "Visiting Mum", "See Mum", "Seeing Dr. Smith", "Meet with John"
  let cleaned = titleTrimmed
    .replace(/^(?:i\s+)?(?:visit|visiting|see|seeing|meet|meeting\s+with|meet\s+with|catch\s*up\s+with|call|calling|phone|have\s+lunch\s+with|have\s+dinner\s+with|lunch\s+with|dinner\s+with)\s+(?:with\s+)?/i, '')
    .replace(/^(?:dr\.?|doctor)\s+/i, '')
    .trim();

  // Strip trailing recurrence/timing clauses e.g. "every Wednesday from 9am to 11am"
  cleaned = cleaned.replace(/\s*(?:every\s+[a-z]+|on\s+[a-z]+days?|from\s+\d{1,2}.*|at\s+\d{1,2}.*)$/i, '').trim();

  return cleaned || titleTrimmed;
}

// Helper to check if a post-event reflection already has an associated saved response for this occurrence
export function hasCompletedReflectionForEvent(
  ev: any,
  memories: any[],
  activeRelationships: any[],
  prepMemories: any[] = [],
  timeZone: string = 'Australia/Sydney',
  clientTodayYMD: string = ''
): boolean {
  if (!ev.start_datetime) return false;
  const evStartDate = new Date(ev.start_datetime);
  const evStartTime = evStartDate.getTime();
  if (isNaN(evStartTime)) return false;

  const occurrenceYMD = clientTodayYMD || getYMDInTz(evStartDate, timeZone);
  const titleLower = (ev.title || '').toLowerCase();
  const eventPerson = extractEventPerson(ev.title, activeRelationships);

  const isMedical =
    /\b(?:dr\.?|doctor|gp|physio|dentist|specialist|clinic|hospital|checkup|optometrist|cardiologist)\b/i.test(
      ev.title || ''
    ) ||
    activeRelationships.some(
      (r) =>
        r.is_active &&
        ['doctor', 'gp', 'physician', 'specialist', 'physio', 'dentist'].includes(
          r.role.toLowerCase()
        ) &&
        titleLower.includes(r.person.toLowerCase())
    );

  // Extract key topic words from prep memories
  const prepKeywords = new Set<string>();
  for (const pm of prepMemories || []) {
    const text = (
      (pm.interpretation?.content || '') +
      ' ' +
      (pm.originalText || '')
    ).toLowerCase();
    const words = text
      .split(/[^a-z0-9]+/i)
      .filter(
        (w) =>
          w.length > 3 &&
          ![
            'about',
            'with',
            'your',
            'from',
            'this',
            'that',
            'have',
            'need',
            'remember',
            'will',
            'what',
          ].includes(w)
      );
    words.forEach((w) => prepKeywords.add(w));
  }

  const baseId = String(ev.id).replace(/:\d{4}-\d{2}-\d{2}$/, '');
  const occurrenceKey = `${baseId}:${occurrenceYMD}`;

  for (const m of memories) {
    if (!m.createdAt) continue;
    const memDate = new Date(m.createdAt);
    const memTime = memDate.getTime();
    if (isNaN(memTime)) continue;

    // Occurrence-scoped date check: Memory must be created on or after the occurrence start time window
    // and strictly on the same occurrence date (in local time zone)
    const memYMD = getYMDInTz(memDate, timeZone);
    if (memYMD !== occurrenceYMD) continue;

    // 1. Explicit link to event occurrence (saved from reflection tray or with linkedEventId)
    if (m.interpretation?.linked_event_id) {
      const linked = String(m.interpretation.linked_event_id);
      if (
        linked === occurrenceKey ||
        linked === String(ev.id) ||
        linked === String(ev.source_event_id) ||
        linked.startsWith(`${baseId}:${occurrenceYMD}`)
      ) {
        if (memTime >= evStartTime - 30 * 60 * 1000) {
          return true;
        }
      }
    }

    // Invariant: Unrelated facts, profiles, preferences, contacts, and relationship memories
    // mentioning the person MUST NEVER count as completion of an event/visit reflection.
    const kind = (m.interpretation?.kind || '').toLowerCase();
    const intent = (m.interpretation?.intent || '').toLowerCase();
    if (
      ['fact', 'profile', 'preference', 'contact', 'relationship'].includes(kind) ||
      ['fact', 'profile', 'preference', 'contact', 'relationship'].includes(intent)
    ) {
      continue;
    }

    // Temporal check: memory must be created at or after the event start time
    if (memTime < evStartTime - 10 * 60 * 1000) continue;

    const content = (m.interpretation?.content || '').toLowerCase();
    const orig = (m.originalText || '').toLowerCase();
    const people = (m.interpretation?.people || []).map((p: string) => p.toLowerCase());

    // Check for explicit visit outcome/report language
    const hasVisitOutcomeLanguage =
      /\b(?:went\s+well|visited|saw|had\s+(?:a\s+)?(?:good|great|nice|lovely|hard|rough|quiet)\s+(?:time|visit|chat|catchup)|talked\s+about|chatted\s+with|spoke\s+to|caught\s+up\s+with|feeling\s+(?:better|worse|good|well))\b/i.test(content) ||
      /\b(?:went\s+well|visited|saw|had\s+(?:a\s+)?(?:good|great|nice|lovely|hard|rough|quiet)\s+(?:time|visit|chat|catchup)|talked\s+about|chatted\s+with|spoke\s+to|caught\s+up\s+with|feeling\s+(?:better|worse|good|well))\b/i.test(orig);

    // 2. Mentions the event person with explicit visit outcome language
    if (
      eventPerson &&
      eventPerson.length >= 2 &&
      (people.includes(eventPerson.toLowerCase()) ||
        content.includes(eventPerson.toLowerCase()) ||
        orig.includes(eventPerson.toLowerCase())) &&
      hasVisitOutcomeLanguage
    ) {
      return true;
    }

    // 3. For medical events: check if memory has discussion/outcome around the appointment topics
    if (isMedical) {
      let matchCount = 0;
      for (const kw of prepKeywords) {
        if (content.includes(kw) || orig.includes(kw)) {
          matchCount++;
        }
      }
      const hasOutcomeOrMedicalTerm =
        /(?:script|prescription|blood\s*test|pathology|referral|scan|x-ray|ordered|prescribed|got|picked\s*up|saw\s+the\s+dr|went\s+to\s+the\s+doctor|appointment\s+went)/i.test(
          content
        ) ||
        /(?:script|prescription|blood\s*test|pathology|referral|scan|x-ray|ordered|prescribed|got|picked\s*up|saw\s+the\s+dr|went\s+to\s+the\s+doctor|appointment\s+went)/i.test(
          orig
        );

      if ((matchCount >= 1 && hasOutcomeOrMedicalTerm) || (hasOutcomeOrMedicalTerm && (m.interpretation?.contexts || []).includes('appointment'))) {
        return true;
      }
    }
  }

  return false;
}

// Helper to extract clean intention/action text removing obsolete/redundant temporal prefixes and suffixes
export function cleanActionText(text: string): string {
  if (!text) return '';
  let cleaned = text.trim().replace(/[.,;!?:\-–—\s]+$/, '');
  // Remove trailing or standalone reminder clauses like "Remind me at 10am", "remind me at 3:30pm", "give me a reminder at 10"
  cleaned = cleaned.replace(/[.,;!?–—\s]*(?:remind\s+me|give\s+me\s+a\s+reminder|send\s+me\s+a\s+reminder|set\s+a\s+reminder)\s+(?:at|@|for|by)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[.,;!?–—\s]*$/i, '');
  // Remove temporal suffix words like "today", "tomorrow", "tonight", "this morning", "this afternoon", "this evening"
  cleaned = cleaned.replace(/\s*\b(?:today|tomorrow|tonight|this\s+(?:morning|afternoon|evening|night))\b\s*[.,;!?–—\s]*$/gi, '');
  // Remove trailing time patterns like "at 10:00am", "at 3:30pm", "@ 10am", "for 3:30pm"
  cleaned = cleaned.replace(/[.,;!?–—\s]*(?:at|@|for|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[.,;!?–—\s]*$/i, '');
  // Clean up trailing and leading punctuation
  cleaned = cleaned.replace(/^[.,;!?:\-–—\s]+|[.,;!?:\-–—\s]+$/g, '').trim();
  return cleaned || text;
}

export function formatContextualTaskHeadline(content: string, timeExpr?: string | null, originalText?: string): string {
  let base = (content || originalText || '').trim().replace(/[.,;:\-–—\s]+$/, '');
  const time = (timeExpr || '').trim().replace(/^[.,;:\-–—\s]+|[.,;:\-–—\s]+$/g, '');

  if (!time) return base;

  // If base already contains the time expression (case-insensitive), return base
  if (base.toLowerCase().includes(time.toLowerCase())) {
    return base;
  }

  // Remove any trailing period before appending
  base = base.replace(/[.]+$/, '').trim();
  return `${base} ${time}`.trim();
}

export function isContextualTodayMemory(
  m: any,
  todayWeekdayName: string,
  clientTodayYMD: string,
  timeZone: string
): { isMatch: boolean; headline: string } {
  // If memory has a pending prerequisite, it is blocked and not active today
  if (m.interpretation?.prerequisite && m.interpretation.prerequisite.status === 'pending') {
    return { isMatch: false, headline: '' };
  }

  // If memory is completed, dismissed, or done
  if (m.isDone || m.interpretation?.status === 'completed' || m.interpretation?.status === 'dismissed') {
    return { isMatch: false, headline: '' };
  }

  const kind = (m.interpretation?.kind || '').toLowerCase();
  const intent = (m.interpretation?.intent || '').toLowerCase();

  // If not_sure, definitely not an active today task/memory
  if (kind === 'not_sure' || intent === 'not_sure') {
    return { isMatch: false, headline: '' };
  }

  // Relationship, profile, and preference records are never active today items
  if (
    ['relationship', 'profile', 'preference'].includes(kind) ||
    ['relationship', 'profile', 'preference'].includes(intent)
  ) {
    return { isMatch: false, headline: '' };
  }

  const content = (m.interpretation?.content || '').trim();
  const origTime = (m.interpretation?.original_time_expression || '').trim();
  const resurfTiming = (m.interpretation?.resurfacing?.timing || '').trim();
  const eventTime = (m.interpretation?.event_time_expression || '').trim();

  // Unit-isolated text inspection: use unit's distilled content or fallback to originalText if content is empty
  const unitText = content || (m.originalText || '').trim();
  const combined = `${unitText} ${origTime} ${resurfTiming} ${eventTime}`.toLowerCase();

  // 1. Check for Contextual / Sequence / Routine timing phrases:
  // e.g. "after breakfast", "before breakfast", "after lunch", "before lunch", "after dinner", "before dinner", "after work", "before bed", "this morning", "this afternoon", "this evening", "tonight", "today"
  const contextualTimingRegex = /\b(?:(?:after|before|during|around|at)\s+(?:breakfast|lunch|dinner|tea|supper|work|school|bed|nap|exercise|gym|the\s+meeting|eating|food)|this\s+(?:morning|afternoon|evening|night)|today|tonight|first\s+thing(?:\s+in\s+the\s+morning)?)\b/i;

  const hasContextualTiming = contextualTimingRegex.test(combined);
  if (!hasContextualTiming) {
    return { isMatch: false, headline: '' };
  }

  // 2. Check for explicit different date / future date overrides:
  // If user explicitly stated "tomorrow", "yesterday", "next week", "next month", "in 3 days", etc.
  const explicitFutureRegex = /\b(?:tomorrow|yesterday|next\s+(?:week|month|year)|in\s+\d+\s+(?:days?|weeks?|months?))\b/i;
  if (explicitFutureRegex.test(combined)) {
    return { isMatch: false, headline: '' };
  }

  // If user specified an explicit day of the week (e.g. "Saturday", "Monday") that is NOT today:
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const d of dayNames) {
    if (d !== todayWeekdayName.toLowerCase()) {
      const explicitOtherDayRegex = new RegExp(`\\b${d}\\b`, 'i');
      if (explicitOtherDayRegex.test(combined)) {
        return { isMatch: false, headline: '' };
      }
    }
  }

  // If memory has a resolved_datetime or reminder_datetime anchored to another day:
  const resolvedIso = m.interpretation?.resolved_datetime || m.interpretation?.reminder_datetime || m.interpretation?.event_datetime;
  if (resolvedIso) {
    const resDate = new Date(resolvedIso);
    if (!isNaN(resDate.getTime())) {
      const resYMD = getYMDInTz(resDate, timeZone);
      if (resYMD !== clientTodayYMD) {
        return { isMatch: false, headline: '' };
      }
    }
  }

  const cleanText = content || (m.originalText || '').trim();
  if (!cleanText) return { isMatch: false, headline: '' };

  // Past observation pattern (e.g. "Barb went to Pilates", "Peter bought a car") -> NOT an active task
  const pastObservationPattern = /^[A-Z][a-z]+\s+(?:went|visited|bought|called|had|was|were|saw|told|said|came|left|arrived)\b/i;
  if (pastObservationPattern.test(cleanText)) {
    return { isMatch: false, headline: '' };
  }

  // Relationship assertion pattern (e.g. "Peter is my brother", "Barb is my wife") -> NOT an active task
  if (Array.isArray(m.interpretation?.relationships) && m.interpretation.relationships.length > 0) {
    const isRelStatement = /^[A-Z][a-z]+\s+(?:is|isn't|is\s+not|was)\s+(?:my|our)\s+/i.test(cleanText);
    if (isRelStatement) {
      return { isMatch: false, headline: '' };
    }
  }

  // Extract cleanest contextual headline
  const baseContent = content || (m.originalText || '').trim();
  const timeExpr = origTime || (combined.match(contextualTimingRegex)?.[0] ?? '');
  const headline = formatContextualTaskHeadline(baseContent, timeExpr, m.originalText);

  return { isMatch: true, headline };
}

export function isUndatedActionableTaskMemory(
  m: any,
  todayWeekdayName: string,
  clientTodayYMD: string,
  timeZone: string
): { isMatch: boolean; headline: string } {
  // If memory has a pending prerequisite, it is blocked and not active today
  if (m.interpretation?.prerequisite && m.interpretation.prerequisite.status === 'pending') {
    return { isMatch: false, headline: '' };
  }

  // If memory is completed, dismissed, or done
  if (m.isDone || m.interpretation?.status === 'completed' || m.interpretation?.status === 'dismissed') {
    return { isMatch: false, headline: '' };
  }

  const content = (m.interpretation?.content || '').trim();
  const kind = (m.interpretation?.kind || '').toLowerCase();
  const intent = (m.interpretation?.intent || '').toLowerCase();
  const origTime = (m.interpretation?.original_time_expression || '').trim();
  const resurfTiming = (m.interpretation?.resurfacing?.timing || '').trim();
  const eventTime = (m.interpretation?.event_time_expression || '').trim();

  // If not_sure, definitely not an actionable task
  if (kind === 'not_sure' || intent === 'not_sure') {
    return { isMatch: false, headline: '' };
  }

  // Relationship, profile, and preference records are never actionable tasks
  if (
    ['relationship', 'profile', 'preference'].includes(kind) ||
    ['relationship', 'profile', 'preference'].includes(intent)
  ) {
    return { isMatch: false, headline: '' };
  }

  // Only reminders (kind === 'reminder') are eligible as undated actionable tasks for the Today ticker
  if (kind !== 'reminder') {
    return { isMatch: false, headline: '' };
  }

  // If memory has a resolved_datetime, reminder_datetime, or event_datetime anchored to another day
  const resolvedIso = m.interpretation?.resolved_datetime || m.interpretation?.reminder_datetime || m.interpretation?.event_datetime;
  if (resolvedIso) {
    const resDate = new Date(resolvedIso);
    if (!isNaN(resDate.getTime())) {
      const resYMD = getYMDInTz(resDate, timeZone);
      if (resYMD !== clientTodayYMD) {
        return { isMatch: false, headline: '' };
      }
    }
  }

  // Unit-isolated text inspection: use unit's distilled content or fallback to originalText if content is empty
  const unitText = content || (m.originalText || '').trim();
  const combined = `${unitText} ${origTime} ${resurfTiming} ${eventTime}`.toLowerCase();

  // Check for explicit future / relative temporal wording (e.g. tomorrow, yesterday, next week, in 3 days)
  const explicitFutureRegex = /\b(?:tomorrow|yesterday|next\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in\s+\d+\s+(?:days?|weeks?|months?))\b/i;
  if (explicitFutureRegex.test(combined)) {
    return { isMatch: false, headline: '' };
  }

  // If user specified an explicit day of the week that is NOT today
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const d of dayNames) {
    if (d !== todayWeekdayName.toLowerCase()) {
      const explicitOtherDayRegex = new RegExp(`\\b${d}\\b`, 'i');
      if (explicitOtherDayRegex.test(combined)) {
        return { isMatch: false, headline: '' };
      }
    }
  }

  const cleanText = content || (m.originalText || '').trim();
  if (!cleanText) return { isMatch: false, headline: '' };

  // Past observation pattern (e.g. "Barb went to Pilates", "Peter bought a car") -> NOT an active task
  const pastObservationPattern = /^[A-Z][a-z]+\s+(?:went|visited|bought|called|had|was|were|saw|told|said|came|left|arrived)\b/i;
  if (pastObservationPattern.test(cleanText)) {
    return { isMatch: false, headline: '' };
  }

  // Relationship assertion pattern (e.g. "Peter is my brother", "Barb is my wife") -> NOT an active task
  if (Array.isArray(m.interpretation?.relationships) && m.interpretation.relationships.length > 0) {
    const isRelStatement = /^[A-Z][a-z]+\s+(?:is|isn't|is\s+not|was)\s+(?:my|our)\s+/i.test(cleanText);
    if (isRelStatement) {
      return { isMatch: false, headline: '' };
    }
  }

  // Clean the headline using cleanActionText
  const headline = cleanActionText(cleanText);
  return { isMatch: true, headline };
}

/**
 * Smallest semantic eligibility gate for memory post-event reflection / appointment lifecycle.
 * Invariant: A date/time does NOT make a memory an appointment or follow-up-worthy event.
 * Passive dated information (movie recommendations, bin schedules, sales ending, facts)
 * and celebrations/birthdays must NEVER receive appointment post-event reflection.
 */
export function isMemoryEligibleForReflection(m: any): boolean {
  if (!m || !m.interpretation) return false;
  const interp = m.interpretation;

  // 0. Check explicit anticipatory mode if present
  const mode: AnticipatoryMode | undefined = interp.anticipatory_mode || m.anticipatory_mode;
  if (mode === 'NONE' || mode === 'PRE_ONLY') return false;

  const isOptedIn = interp.anticipatory_opted_in !== undefined
    ? Boolean(interp.anticipatory_opted_in)
    : (m.anticipatory_opted_in !== undefined ? Boolean(m.anticipatory_opted_in) : false);

  if (mode === 'POST_ONLY' || mode === 'PRE_AND_POST') {
    return isOptedIn;
  }

  // 1. Facts, notes, observations, media, and reference knowledge are NEVER appointments requiring reflection
  if (
    interp.kind === 'fact' ||
    interp.intent === 'fact' ||
    interp.intent === 'note' ||
    interp.intent === 'observation' ||
    interp.intent === 'knowledge' ||
    interp.intent === 'media'
  ) {
    return false;
  }

  // 2. Birthdays, anniversaries, and celebrations must NEVER receive meeting-style post-event reflection
  const isBirthdayOrCelebration =
    Boolean(interp.contexts?.includes('birthday')) ||
    Boolean(interp.contexts?.includes('celebration')) ||
    interp.intent === 'celebration' ||
    /\b(birthday|bday|anniversary|jubilee)\b/i.test(interp.content || m.originalText || '');
  if (isBirthdayOrCelebration) {
    return false;
  }

  // 3. Must have explicit semantic evidence of being an appointment, meeting, consultation, or interactive event
  const hasAppointmentIntentOrContext =
    interp.intent === 'appointment' ||
    interp.intent === 'meeting' ||
    Boolean(interp.contexts?.includes('appointment')) ||
    Boolean(interp.contexts?.includes('meeting')) ||
    Boolean(interp.contexts?.includes('consultation'));

  return Boolean(hasAppointmentIntentOrContext);
}

export function evaluateMemoryTodayLifecycle(
  m: any,
  localContext: LocalContextInfo,
  clientTodayYMD: string,
  getTimeStrInTz: (d: Date, tz: string) => string
): MemoryTodayLifecycleBounds | null {
  // If memory has a pending prerequisite, it is blocked and cannot surface as active in TODAY
  if (m.interpretation?.prerequisite && m.interpretation.prerequisite.status === 'pending') {
    return null;
  }

  // If memory text or content is a dependent reminder clause, skip immediately
  const rawContent = m.interpretation?.content || '';
  const rawOriginal = m.originalText || '';
  if (isDependentReminderClause(rawContent) || isDependentReminderClause(rawOriginal)) {
    return null;
  }

  const cleanTitle = (m.interpretation?.content || m.originalText || '')
    .replace(/\s*(?:every\s+[a-z]+|on\s+[a-z]+days?|from\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:to|-)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/gi, '')
    .trim() || (m.interpretation?.content || m.originalText || 'Intention');

  const nowMs = localContext.referenceDate.getTime();
  const timeZone = localContext.timeZone;

  // 1. Check explicit reminder_datetime / event_datetime / resolved_datetime
  const dtIso = m.interpretation?.reminder_datetime || m.interpretation?.event_datetime || m.interpretation?.resolved_datetime;
  if (dtIso) {
    const dt = new Date(dtIso);
    if (!isNaN(dt.getTime())) {
      const dtYMD = getYMDInTz(dt, timeZone);
      if (dtYMD === clientTodayYMD) {
        const startMs = dt.getTime();
        const endMs = startMs + 60 * 60 * 1000;
        const endDate = new Date(endMs);

        const startTimeFormatted = getTimeStrInTz(dt, timeZone);
        const endTimeFormatted = getTimeStrInTz(endDate, timeZone);

        let lifecycleStage: 'upcoming' | 'current' | 'post_event' = 'upcoming';
        if (nowMs < startMs) {
          lifecycleStage = 'upcoming';
        } else if (nowMs >= startMs && nowMs <= endMs) {
          lifecycleStage = 'current';
        } else {
          lifecycleStage = 'post_event';
        }

        return {
          isScheduledToday: true,
          startDate: dt,
          endDate,
          startTimeFormatted,
          endTimeFormatted,
          lifecycleStage,
          cleanTitle,
          isRecurring: false,
        };
      }
    }
  }

  // 2. Check Recurring Expressions e.g. "every Wednesday from 9am to 11am", "Wednesdays 9-11am", "every weekday", "daily at 8am"
  const textToCheck = [
    m.interpretation?.resurfacing?.timing || '',
    m.interpretation?.original_time_expression || '',
    m.interpretation?.event_time_expression || '',
    m.interpretation?.content || m.originalText || '',
  ].join(' ').toLowerCase();

  // Get current weekday in client time zone
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(localContext.referenceDate).toLowerCase();
  const shortDayName = dayName.slice(0, 3);

  const isTodayDayMatch = 
    textToCheck.includes(`every ${dayName}`) ||
    textToCheck.includes(`every ${shortDayName}`) ||
    textToCheck.includes(`${dayName}s`) ||
    textToCheck.includes('every day') ||
    textToCheck.includes('daily') ||
    (textToCheck.includes('every weekday') && !['saturday', 'sunday'].includes(dayName)) ||
    (textToCheck.includes('every weekend') && ['saturday', 'sunday'].includes(dayName));

  if (!isTodayDayMatch) {
    // 3. Contextual Temporal Expression & Sequence Timing for TODAY (e.g. "after breakfast", "before lunch", "after dinner")
    const contextualCheck = isContextualTodayMemory(m, dayName, clientTodayYMD, timeZone);
    if (contextualCheck.isMatch) {
      return {
        isScheduledToday: true,
        startDate: null,
        endDate: null,
        startTimeFormatted: '',
        endTimeFormatted: '',
        lifecycleStage: 'all_day',
        cleanTitle: contextualCheck.headline,
        isRecurring: false,
      };
    }

    // 4. Undated Actionable Task / Intention (e.g. "Book a dentist appointment", "Vacuum the house", "Ring Peter")
    const actionableCheck = isUndatedActionableTaskMemory(m, dayName, clientTodayYMD, timeZone);
    if (actionableCheck.isMatch) {
      return {
        isScheduledToday: true,
        startDate: null,
        endDate: null,
        startTimeFormatted: '',
        endTimeFormatted: '',
        lifecycleStage: 'all_day',
        cleanTitle: actionableCheck.headline,
        isRecurring: false,
      };
    }

    return null;
  }

  // Extract time range or specific time
  const timeRangeMatch = textToCheck.match(/(?:from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|-|until)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  let startHour = 9;
  let startMin = 0;
  let endHour = 10;
  let endMin = 0;
  let hasSpecificTime = false;

  if (timeRangeMatch) {
    hasSpecificTime = true;
    const sTime = parseTimeStringToHM(timeRangeMatch[1]);
    const eTime = parseTimeStringToHM(timeRangeMatch[2]);
    if (sTime) {
      startHour = sTime.hour;
      startMin = sTime.minute;
    }
    if (eTime) {
      endHour = eTime.hour;
      endMin = eTime.minute;
      if (endHour <= startHour && endHour < 12 && (timeRangeMatch[2].includes('pm') || timeRangeMatch[1].includes('pm') || startHour >= 12)) {
        endHour += 12;
      }
    } else {
      endHour = startHour + 1;
    }
  } else {
    const singleTimeMatch = textToCheck.match(/(?:at\s+|@\s*)(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i) ||
                           textToCheck.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
    if (singleTimeMatch) {
      hasSpecificTime = true;
      const sTime = parseTimeStringToHM(singleTimeMatch[1]);
      if (sTime) {
        startHour = sTime.hour;
        startMin = sTime.minute;
        endHour = (startHour + 1) % 24;
        endMin = startMin;
      }
    }
  }

  if (!hasSpecificTime) {
    return {
      isScheduledToday: true,
      startDate: null,
      endDate: null,
      startTimeFormatted: '',
      endTimeFormatted: '',
      lifecycleStage: 'all_day',
      cleanTitle,
      isRecurring: true,
    };
  }

  const offset = localContext.offsetStr || '+00:00';
  const pad = (n: number) => String(n).padStart(2, '0');
  const startIso = `${clientTodayYMD}T${pad(startHour)}:${pad(startMin)}:00${offset}`;
  const startDate = new Date(startIso);

  let endDate: Date;
  if (endHour < 24) {
    const endIso = `${clientTodayYMD}T${pad(endHour)}:${pad(endMin)}:00${offset}`;
    const parsedEnd = new Date(endIso);
    if (!isNaN(parsedEnd.getTime()) && parsedEnd.getTime() > startDate.getTime()) {
      endDate = parsedEnd;
    } else {
      endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    }
  } else {
    // Rolls over midnight
    const durationHours = endHour - startHour;
    const durationMin = endMin - startMin;
    const totalMs = Math.max(30 * 60 * 1000, (durationHours * 60 + durationMin) * 60 * 1000);
    endDate = new Date(startDate.getTime() + totalMs);
  }

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  let lifecycleStage: 'upcoming' | 'current' | 'post_event' = 'upcoming';
  if (nowMs < startMs) {
    lifecycleStage = 'upcoming';
  } else if (nowMs >= startMs && nowMs <= endMs) {
    lifecycleStage = 'current';
  } else {
    lifecycleStage = 'post_event';
  }

  const startTimeFormatted = getTimeStrInTz(startDate, timeZone);
  const endTimeFormatted = getTimeStrInTz(endDate, timeZone);

  return {
    isScheduledToday: true,
    startDate,
    endDate,
    startTimeFormatted,
    endTimeFormatted,
    lifecycleStage,
    cleanTitle,
    isRecurring: true,
  };
}

export function evaluateTodayRelevanceCandidates(
  memories: any[],
  calendarEvents: any[],
  activeRelationships: any[],
  localContext: LocalContextInfo,
  dismissedReflectionIds: string[] = [],
  selectedOccasions: OccasionOccurrence[] = []
) {
  const clientTodayYMD = getYMDInTz(localContext.referenceDate, localContext.timeZone);
  const nowMs = localContext.referenceDate.getTime();

  // Filter memories to active / non-done items, applying deterministic safety filter
  const activeMemories = memories.filter(m => {
    if (m.isDone || m.interpretation?.status === 'completed' || m.interpretation?.status === 'dismissed') {
      return false;
    }
    const rawContent = m.interpretation?.content || '';
    const rawOriginal = m.originalText || '';
    if (isDependentReminderClause(rawContent) || isDependentReminderClause(rawOriginal)) {
      // Rule 1: A dependent timing/reminder clause is metadata, not ticker content. Suppress legacy/orphan records.
      return false;
    }
    return true;
  });
  
  const candidateList: Array<{
    source_type: 'memory' | 'calendar' | 'occasion';
    source_id: string;
    occurrence_id?: string;
    relevance_reason: string;
    display_text: string;
    priority: number;
    is_anticipatory?: boolean;
    anticipatory_stage?: 'prepare' | 'remind' | 'reflect';
    anticipatory_mode?: AnticipatoryMode;
    event_title?: string;
    event_time?: string;
    preparation_items?: string[];
    ticker_headlines?: string[];
    prep_memory_ids?: string[];
  }> = [];
  const seenSourceIds = new Set<string>();

  // 1. Explicit Reminders / Timed Intentions due today (Priority 1)
  for (const m of activeMemories) {
    const reminderIso = m.interpretation?.reminder_datetime;
    if (reminderIso) {
      const isDateOnly = !reminderIso.includes('T');
      const remDate = new Date(reminderIso);
      if (!isNaN(remDate.getTime())) {
        const remYMD = isDateOnly ? reminderIso.trim().slice(0, 10) : getYMDInTz(remDate, localContext.timeZone);
        if (remYMD === clientTodayYMD) {
          seenSourceIds.add(m.id);
          const baseAction = cleanActionText(m.interpretation?.content || m.originalText);

          if (isDateOnly) {
            const displayText = baseAction;
            const relevanceReason = 'Reminder scheduled for today';

            candidateList.push({
              source_type: 'memory',
              source_id: m.id,
              relevance_reason: relevanceReason,
              display_text: displayText,
              priority: 1,
              ticker_headlines: [displayText],
            });
          } else {
            const timeStr = getTimeStrInTz(remDate, localContext.timeZone);
            const cleanTime = timeStr ? timeStr.replace(/\s+/g, '').toLowerCase() : '';
            const remMs = remDate.getTime();
            const isBeforeReminder = nowMs < remMs;

            // Before reminder time: communicate action + useful future time (e.g. "Ring Bill at 10:00am", "Put the bins out at 3:30pm")
            // At / after reminder time: remove obsolete future-time wording and continue showing unfinished action (e.g. "Ring Bill", "Put the bins out")
            const displayText = isBeforeReminder && cleanTime
              ? `${baseAction} at ${cleanTime}`
              : baseAction;

            const relevanceReason = isBeforeReminder
              ? (cleanTime ? `Reminder set for ${cleanTime}` : 'Reminder scheduled for today')
              : (cleanTime ? `Reminder was for ${cleanTime}` : 'Action item for today');

            candidateList.push({
              source_type: 'memory',
              source_id: m.id,
              relevance_reason: relevanceReason,
              display_text: displayText,
              priority: 1,
              ticker_headlines: [displayText],
            });
          }
        }
      }
    }
  }

  // 2. Calendar Events today with strict 4-Stage Lifecycle Handling (Priority 2)
  for (const ev of calendarEvents) {
    if (!ev.start_datetime) continue;

    if (ev.is_all_day) {
      const startYMD = ev.start_datetime.slice(0, 10);
      const endYMDExcl = ev.end_datetime ? ev.end_datetime.slice(0, 10) : startYMD;
      const isToday = (endYMDExcl <= startYMD)
        ? (startYMD === clientTodayYMD)
        : (clientTodayYMD >= startYMD && clientTodayYMD < endYMDExcl);

      if (isToday && !seenSourceIds.has(ev.id)) {
        seenSourceIds.add(ev.id);
        const isBirthdayOrCelebration =
          ev.event_type === 'birthday' ||
          Boolean(ev.birthday_properties) ||
          (typeof ev.description === 'string' && (
            /"eventType"\s*:\s*"birthday"/i.test(ev.description) ||
            /birthdayProperties/i.test(ev.description) ||
            /\bbirthday\b/i.test(ev.description)
          )) ||
          /\b(birthday|bday|anniversary|jubilee)\b/i.test(ev.title || '');

        candidateList.push({
          source_type: 'calendar',
          source_id: ev.id,
          relevance_reason: isBirthdayOrCelebration
            ? 'Birthday / Celebration today'
            : 'All-day event today',
          display_text: ev.title,
          priority: 2,
          is_anticipatory: false,
          event_title: ev.title,
          ticker_headlines: [ev.title],
        });
      }
      continue;
    }

    const startDate = new Date(ev.start_datetime);
    if (isNaN(startDate.getTime())) continue;

    const eventStartYMD = getYMDInTz(startDate, localContext.timeZone);
    let eventEndYMD = eventStartYMD;
    let endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    if (ev.end_datetime) {
      const parsedEnd = new Date(ev.end_datetime);
      if (!isNaN(parsedEnd.getTime())) {
        endDate = parsedEnd;
        eventEndYMD = getYMDInTz(parsedEnd, localContext.timeZone);
      }
    }

    const isToday = eventStartYMD <= clientTodayYMD && eventEndYMD >= clientTodayYMD;
    if (isToday && !seenSourceIds.has(ev.id)) {
      seenSourceIds.add(ev.id);
      const timeStr = getTimeStrInTz(startDate, localContext.timeZone);
      const endTimeStr = getTimeStrInTz(endDate, localContext.timeZone);
      const startMs = startDate.getTime();
      const endMs = endDate.getTime();

      const isBirthdayOrCelebration =
        ev.event_type === 'birthday' ||
        Boolean(ev.birthday_properties) ||
        (typeof ev.description === 'string' && (
          /"eventType"\s*:\s*"birthday"/i.test(ev.description) ||
          /birthdayProperties/i.test(ev.description) ||
          /\bbirthday\b/i.test(ev.description)
        )) ||
        /\b(birthday|bday|anniversary|jubilee)\b/i.test(ev.title || '');

      const isSuitableAppointment = !ev.is_all_day && Boolean(ev.title) && !isBirthdayOrCelebration;
      const cleanTitle = (ev.title || '')
        .replace(/\s*(?:—|-|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?\s*$/i, '')
        .trim() || ev.title;
      const timeFormatted = timeStr ? timeStr.replace(/\s+/g, ' ').trim().toLowerCase() : '';
      const endTimeFormatted = endTimeStr ? endTimeStr.replace(/\s+/g, ' ').trim().toLowerCase() : '';
      const timePrefix = timeFormatted ? `${timeFormatted} · ` : '';

      // Determine anticipatory mode for this calendar event:
      let eventAnticipatoryMode: AnticipatoryMode = (ev.anticipatory_mode as AnticipatoryMode);
      if (!eventAnticipatoryMode) {
        if (ev.is_recurring || isRecurringRoutineText(ev.title || '')) {
          eventAnticipatoryMode = 'POST_ONLY';
        } else if (isSuitableAppointment) {
          eventAnticipatoryMode = 'PRE_AND_POST';
        } else {
          eventAnticipatoryMode = 'NONE';
        }
      }

      const isOptedIn = ev.anticipatory_opted_in !== undefined ? Boolean(ev.anticipatory_opted_in) : true;
      const baseEventId = String(ev.id).replace(/:\d{4}-\d{2}-\d{2}$/, '');
      const occurrenceKey = `${baseEventId}:${clientTodayYMD}`;

      // Stage 1: Upcoming Event (now < startMs)
      if (nowMs < startMs && isSuitableAppointment) {
        if ((eventAnticipatoryMode === 'PRE_AND_POST' || eventAnticipatoryMode === 'PRE_ONLY') && isOptedIn) {
          const prepMemories = findPreparationMemoriesForEvent(ev, memories, activeRelationships);
          const prepItems = extractCleanPrepItems(prepMemories);
          const prePromptRes = buildAnticipatoryPrompt({
            stage: 'PRE',
            title: ev.title,
            temporalDesc: timeStr ? `at ${timeStr}` : 'today',
            memories: prepMemories.length > 0 ? prepMemories : memories,
            activeRelationships,
            eventId: ev.id,
          });
          const prompt = prePromptRes.prompt;

          candidateList.push({
            source_type: 'calendar',
            source_id: ev.id,
            occurrence_id: occurrenceKey,
            relevance_reason: timeStr ? `Upcoming appointment at ${timeStr}` : 'Upcoming appointment today',
            display_text: prompt,
            priority: 2,
            is_anticipatory: true,
            anticipatory_stage: 'prepare',
            anticipatory_mode: eventAnticipatoryMode,
            event_title: prePromptRes.cleanTitle || cleanTitle,
            event_time: timeFormatted,
            preparation_items: prepItems,
            ticker_headlines: [prompt],
            prep_memory_ids: prepMemories.map((m) => m.id),
          });
        } else {
          // Regular scheduled event display (routine or not opted in)
          const locationSuffix = ev.location ? ` (${ev.location})` : '';
          const displayText = `${timePrefix}${cleanTitle}${locationSuffix}`;
          candidateList.push({
            source_type: 'calendar',
            source_id: ev.id,
            occurrence_id: occurrenceKey,
            relevance_reason: timeStr ? `Calendar event at ${timeStr}` : 'Calendar event today',
            display_text: displayText,
            priority: 2,
            is_anticipatory: false,
            anticipatory_mode: eventAnticipatoryMode,
            event_title: cleanTitle,
            event_time: timeStr || undefined,
            ticker_headlines: [displayText],
          });
        }
      }
      // Stage 2: Current Event in progress (startMs <= nowMs <= endMs)
      else if (nowMs >= startMs && nowMs <= endMs && isSuitableAppointment) {
        const currentDisplayText = endTimeFormatted ? `${cleanTitle} (until ${endTimeFormatted})` : cleanTitle;
        candidateList.push({
          source_type: 'calendar',
          source_id: ev.id,
          occurrence_id: occurrenceKey,
          relevance_reason: `Happening now (${timeFormatted} – ${endTimeFormatted})`,
          display_text: currentDisplayText,
          priority: 2,
          is_anticipatory: false,
          anticipatory_mode: eventAnticipatoryMode,
          event_title: cleanTitle,
          event_time: timeFormatted,
          ticker_headlines: [currentDisplayText],
        });
      }
      // Stage 3: Post-Event Reflection (nowMs > endMs)
      else if (nowMs > endMs && isSuitableAppointment) {
        if ((eventAnticipatoryMode === 'PRE_AND_POST' || eventAnticipatoryMode === 'POST_ONLY') && isOptedIn) {
          const isDismissed =
            Array.isArray(dismissedReflectionIds) &&
            dismissedReflectionIds.includes(occurrenceKey);
          const prepMemories = findPreparationMemoriesForEvent(ev, memories, activeRelationships);
          const hasCompletedResponse = hasCompletedReflectionForEvent(
            ev,
            memories,
            activeRelationships,
            prepMemories,
            localContext.timeZone,
            clientTodayYMD
          );

          if (!isDismissed && !hasCompletedResponse) {
            const prepItems = extractCleanPrepItems(prepMemories);
            const { prompt, isAnticipatory, cleanTitle: promptTitle } = generatePostEventReflectionPrompt(
              ev.title,
              prepMemories.length > 0 ? prepMemories : memories,
              activeRelationships
            );
            candidateList.push({
              source_type: 'calendar',
              source_id: ev.id,
              occurrence_id: occurrenceKey,
              relevance_reason: 'Post-event reflection',
              display_text: prompt,
              priority: 2,
              is_anticipatory: isAnticipatory,
              anticipatory_stage: 'reflect',
              anticipatory_mode: eventAnticipatoryMode,
              event_title: promptTitle || cleanTitle,
              preparation_items: prepItems,
              ticker_headlines: [prompt],
              prep_memory_ids: prepMemories.map((m) => m.id),
            });
          }
        }
        // If not eligible, dismissed, or completed, show nothing further for this occurrence
      } else {
        const locationSuffix = ev.location ? ` (${ev.location})` : '';
        let displayText = `${cleanTitle}${locationSuffix}`;
        if (!ev.is_all_day && timeStr) {
          displayText = `${timeStr} · ${cleanTitle}${locationSuffix}`;
        }
        candidateList.push({
          source_type: 'calendar',
          source_id: ev.id,
          relevance_reason: isBirthdayOrCelebration
            ? 'Birthday / Celebration today'
            : (timeStr ? `Calendar event at ${timeStr}` : 'Calendar event today'),
          display_text: displayText,
          priority: 2,
          is_anticipatory: false,
          event_title: cleanTitle,
          event_time: timeStr || undefined,
          ticker_headlines: [displayText],
        });
      }
    }
  }

  // 2B. Selected Occasions (Resolved Occurrences & Anticipatory Integration)
  for (const occ of selectedOccasions) {
    const mode: AnticipatoryMode = occ.anticipatoryMode || 'NONE';
    const diffStart = daysBetween(clientTodayYMD, occ.startDate);
    const diffEnd = daysBetween(clientTodayYMD, occ.endDate);
    const isTodayOrDuring = clientTodayYMD >= occ.startDate && clientTodayYMD <= occ.endDate;
    const isDismissed = Array.isArray(dismissedReflectionIds) && dismissedReflectionIds.includes(occ.occurrenceId);

    if (isDismissed) continue;

    // Stage 1: Post-Occasion Reflection (1-2 days after occasion has ended)
    if (diffEnd < 0 && (diffEnd === -1 || diffEnd === -2)) {
      // ONLY trigger POST if mode is POST_ONLY or PRE_AND_POST.
      // Strict rule: PRE_ONLY or NONE MUST NEVER trigger post-event reflection!
      if (mode === 'POST_ONLY' || mode === 'PRE_AND_POST') {
        const postPromptRes = buildAnticipatoryPrompt({
          stage: 'POST',
          title: occ.title,
          memories: activeMemories,
          activeRelationships,
          eventId: occ.occurrenceId,
        });

        candidateList.push({
          source_type: 'occasion',
          source_id: occ.occasionId,
          occurrence_id: occ.occurrenceId,
          relevance_reason: 'Occasion reflection check-in',
          display_text: postPromptRes.prompt,
          priority: 2,
          is_anticipatory: true,
          anticipatory_stage: 'reflect',
          anticipatory_mode: mode,
          event_title: occ.title,
          event_time: occ.endDate,
          ticker_headlines: [postPromptRes.prompt],
        });
      }
    }
    // Stage 2: Occasion Today / Ongoing Multi-Day Period
    else if (isTodayOrDuring) {
      if (occ.startDate === occ.endDate) {
        // Single day occasion today
        if (mode === 'PRE_ONLY' || mode === 'PRE_AND_POST') {
          const prePromptRes = buildAnticipatoryPrompt({
            stage: 'PRE',
            title: occ.title,
            temporalDesc: 'today',
            memories: activeMemories,
            activeRelationships,
            eventId: occ.occurrenceId,
          });
          candidateList.push({
            source_type: 'occasion',
            source_id: occ.occasionId,
            occurrence_id: occ.occurrenceId,
            relevance_reason: 'Occasion today',
            display_text: prePromptRes.prompt,
            priority: 2,
            is_anticipatory: true,
            anticipatory_stage: 'prepare',
            anticipatory_mode: mode,
            event_title: occ.title,
            event_time: occ.startDate,
            ticker_headlines: [prePromptRes.prompt],
          });
        } else {
          const text = `${occ.title} is today`;
          candidateList.push({
            source_type: 'occasion',
            source_id: occ.occasionId,
            occurrence_id: occ.occurrenceId,
            relevance_reason: 'Occasion today',
            display_text: text,
            priority: 2,
            is_anticipatory: false,
            anticipatory_mode: mode,
            event_title: occ.title,
            event_time: occ.startDate,
            ticker_headlines: [text],
          });
        }
      } else {
        // Multi-day period (e.g. Ramadan, Hanukkah, Tết)
        const isFirstDay = clientTodayYMD === occ.startDate;
        const text = isFirstDay ? `${occ.title} begins today` : occ.title;
        candidateList.push({
          source_type: 'occasion',
          source_id: occ.occasionId,
          occurrence_id: occ.occurrenceId,
          relevance_reason: isFirstDay ? 'Occasion begins today' : 'Ongoing occasion',
          display_text: text,
          priority: 2,
          is_anticipatory: false,
          anticipatory_mode: mode,
          event_title: occ.title,
          event_time: occ.startDate,
          ticker_headlines: [text],
        });
      }
    }
    // Stage 3: Advance Preparation (1 to 7 days before start)
    else if (diffStart >= 1 && diffStart <= 7) {
      // ONLY trigger PRE if mode is PRE_ONLY or PRE_AND_POST.
      // Strict rule: POST_ONLY or NONE MUST NEVER trigger advance preparation!
      if (mode === 'PRE_ONLY' || mode === 'PRE_AND_POST') {
        const temporalDesc = getOccasionTemporalDescription(occ.startDate, clientTodayYMD, localContext.timeZone);
        const prePromptRes = buildAnticipatoryPrompt({
          stage: 'PRE',
          title: occ.title,
          temporalDesc,
          memories: activeMemories,
          activeRelationships,
          eventId: occ.occurrenceId,
        });

        candidateList.push({
          source_type: 'occasion',
          source_id: occ.occasionId,
          occurrence_id: occ.occurrenceId,
          relevance_reason: `Upcoming occasion (${temporalDesc})`,
          display_text: prePromptRes.prompt,
          priority: 2,
          is_anticipatory: true,
          anticipatory_stage: 'prepare',
          anticipatory_mode: mode,
          event_title: occ.title,
          event_time: occ.startDate,
          ticker_headlines: [prePromptRes.prompt],
        });
      }
    }
  }

  // 3. Lists Scheduled for Today via Subject Temporal Resolution (Priority 3)
  // For active memories where subject_resolved_date matches clientTodayYMD, group by subject
  // and emit exactly ONE pointer candidate per distinct subject.
  const todayListGroups = new Map<string, typeof activeMemories>();
  for (const m of activeMemories) {
    const subjDate = m.interpretation?.subject_resolved_date;
    const subject = m.interpretation?.subject?.trim();
    if (subjDate && subject) {
      const isDateOnly = !subjDate.includes('T');
      const sDate = new Date(subjDate);
      if (!isNaN(sDate.getTime()) || isDateOnly) {
        const subjYMD = isDateOnly ? subjDate.trim().slice(0, 10) : getYMDInTz(sDate, localContext.timeZone);
        if (subjYMD === clientTodayYMD) {
          if (!todayListGroups.has(subject)) {
            todayListGroups.set(subject, []);
          }
          todayListGroups.get(subject)!.push(m);
        }
      }
    }
  }

  for (const [subject, groupMems] of todayListGroups.entries()) {
    // Check if any memories in this group are not yet consumed by prior tiers
    const unconsumedMems = groupMems.filter(m => !seenSourceIds.has(m.id));
    if (unconsumedMems.length === 0) {
      continue;
    }

    // Mark all memories in this subject group as seen so they are not double-counted in subsequent memory tiers
    for (const m of groupMems) {
      seenSourceIds.add(m.id);
    }

    const primaryMem = unconsumedMems[0] || groupMems[0];
    const displayText = `You have a list for today: ${subject}`;
    const relevanceReason = 'List scheduled for today';

    candidateList.push({
      source_type: 'memory',
      source_id: primaryMem.id,
      relevance_reason: relevanceReason,
      display_text: displayText,
      priority: 3,
      ticker_headlines: [displayText],
    });
  }

  // 4. Stored Memories with Recurring Patterns or Resolved Dates (Priority 4)
  for (const m of activeMemories) {
    if (seenSourceIds.has(m.id)) continue;

    const lifecycle = evaluateMemoryTodayLifecycle(m, localContext, clientTodayYMD, getTimeStrInTz);
    if (lifecycle && lifecycle.isScheduledToday) {
      seenSourceIds.add(m.id);

      const memMode: AnticipatoryMode = m.interpretation?.anticipatory_mode || m.anticipatory_mode || classifyAnticipatoryMode(m.interpretation || {}, m.originalText);
      const memOptedIn: boolean = m.interpretation?.anticipatory_opted_in !== undefined
        ? Boolean(m.interpretation.anticipatory_opted_in)
        : (m.anticipatory_opted_in !== undefined ? Boolean(m.anticipatory_opted_in) : false);

      const baseMemoryId = String(m.id).replace(/:\d{4}-\d{2}-\d{2}$/, '');
      const occurrenceKey = `${baseMemoryId}:${clientTodayYMD}`;

      if (lifecycle.lifecycleStage === 'upcoming') {
        if ((memMode === 'PRE_AND_POST' || memMode === 'PRE_ONLY') && memOptedIn) {
          const prePromptRes = buildAnticipatoryPrompt({
            stage: 'PRE',
            title: lifecycle.cleanTitle,
            temporalDesc: lifecycle.startTimeFormatted ? `at ${lifecycle.startTimeFormatted}` : 'today',
            memories,
            activeRelationships,
            eventId: m.id,
          });
          const prompt = prePromptRes.prompt;
          candidateList.push({
            source_type: 'memory',
            source_id: m.id,
            occurrence_id: occurrenceKey,
            relevance_reason: lifecycle.startTimeFormatted ? `Upcoming appointment at ${lifecycle.startTimeFormatted}` : 'Upcoming appointment today',
            display_text: prompt,
            priority: 4,
            is_anticipatory: true,
            anticipatory_stage: 'prepare',
            anticipatory_mode: memMode,
            event_title: prePromptRes.cleanTitle || lifecycle.cleanTitle,
            event_time: lifecycle.startTimeFormatted || undefined,
            ticker_headlines: [prompt],
          });
        } else {
          const timePrefix = lifecycle.startTimeFormatted ? `${lifecycle.startTimeFormatted} · ` : '';
          const displayText = `${timePrefix}${lifecycle.cleanTitle}`;
          candidateList.push({
            source_type: 'memory',
            source_id: m.id,
            occurrence_id: occurrenceKey,
            relevance_reason: lifecycle.startTimeFormatted ? `Scheduled for today at ${lifecycle.startTimeFormatted}` : 'Scheduled for today',
            display_text: displayText,
            priority: 4,
            is_anticipatory: false,
            anticipatory_mode: memMode,
            ticker_headlines: [displayText],
          });
        }
      } else if (lifecycle.lifecycleStage === 'current') {
        const currentDisplayText = lifecycle.endTimeFormatted ? `${lifecycle.cleanTitle} (until ${lifecycle.endTimeFormatted})` : lifecycle.cleanTitle;
        candidateList.push({
          source_type: 'memory',
          source_id: m.id,
          occurrence_id: occurrenceKey,
          relevance_reason: `Happening now (${lifecycle.startTimeFormatted} – ${lifecycle.endTimeFormatted})`,
          display_text: currentDisplayText,
          priority: 4,
          is_anticipatory: false,
          anticipatory_mode: memMode,
          ticker_headlines: [currentDisplayText],
        });
      } else if (lifecycle.lifecycleStage === 'post_event') {
        if ((memMode === 'PRE_AND_POST' || memMode === 'POST_ONLY') && memOptedIn && isMemoryEligibleForReflection(m)) {
          const isDismissed =
            Array.isArray(dismissedReflectionIds) &&
            dismissedReflectionIds.includes(occurrenceKey);
          const pseudoEvent = {
            id: m.id,
            title: lifecycle.cleanTitle,
            start_datetime: lifecycle.startDate ? lifecycle.startDate.toISOString() : new Date().toISOString(),
          };
          const hasCompletedReflection = hasCompletedReflectionForEvent(
            pseudoEvent,
            memories,
            activeRelationships,
            [],
            localContext.timeZone,
            clientTodayYMD
          );

          if (!isDismissed && !hasCompletedReflection) {
            const { prompt, isAnticipatory, cleanTitle: promptTitle } = generatePostEventReflectionPrompt(lifecycle.cleanTitle, memories, activeRelationships);
            candidateList.push({
              source_type: 'memory',
              source_id: m.id,
              occurrence_id: occurrenceKey,
              relevance_reason: 'Post-event reflection',
              display_text: prompt,
              priority: 4,
              is_anticipatory: isAnticipatory,
              anticipatory_stage: 'reflect',
              anticipatory_mode: memMode,
              event_title: promptTitle || lifecycle.cleanTitle,
              ticker_headlines: [prompt],
            });
          }
        }
        // If not eligible, dismissed, or completed, show nothing further for this occurrence (Rule 2 & 3)
      } else {
        // All day / general scheduled today
        const displayText = lifecycle.cleanTitle;
        candidateList.push({
          source_type: 'memory',
          source_id: m.id,
          relevance_reason: 'Scheduled for today',
          display_text: displayText,
          priority: 4,
          ticker_headlines: [displayText],
        });
      }
    }
  }

  // 5. Contextual intentions ONLY where explicitly pinned for today via showOnTodayTicker (Priority 5)
  for (const m of activeMemories) {
    if (seenSourceIds.has(m.id)) continue;

    if ((m as any).showOnTodayTicker) {
      seenSourceIds.add(m.id);
      const displayText = m.interpretation?.content || m.originalText;
      candidateList.push({
        source_type: 'memory',
        source_id: m.id,
        relevance_reason: 'Pinned for today',
        display_text: displayText,
        priority: 5,
        ticker_headlines: [displayText],
      });
    }
  }

  // Sort strictly by priority (1 is highest), preserving all eligible candidates
  candidateList.sort((a, b) => a.priority - b.priority);
  const candidates = candidateList;
  candidates.forEach((c, idx) => {
    c.priority = idx + 1;
  });

  return candidates;
}

export async function computeTodayRelevance(
  clientNow?: string,
  clientTimeZone?: string,
  clientLanguage?: string,
  clientRegion?: string,
  dismissedReflectionIds: string[] = []
) {
  const t0 = Date.now();
  const localContext = formatLocalTimeContext(clientNow, clientTimeZone, clientLanguage, clientRegion);

  // Parallel fetch memories, calendar events, active relationships, and resolved occasions
  const [memories, calendarEvents, activeRelationships, occasionOccurrences] = await Promise.all([
    readMemories(),
    readCalendarEvents(),
    readActiveRelationships(),
    getActiveUserOccasionOccurrences(localContext.referenceDate, localContext.timeZone),
  ]);
  const tDb = Date.now();

  const candidates = evaluateTodayRelevanceCandidates(
    memories,
    calendarEvents,
    activeRelationships,
    localContext,
    dismissedReflectionIds,
    occasionOccurrences
  );

  const tEnd = Date.now();
  const dbMs = tDb - t0;
  const rankMs = tEnd - tDb;
  const totalMs = tEnd - t0;

  console.log(`[API TODAY RELEVANCE] Finished in ${totalMs}ms (DB fetch: ${dbMs}ms, ranking: ${rankMs}ms, candidates: ${candidates.length})`);

  return {
    candidates,
    reference_time: localContext.localDateTimeStr,
    timezone: localContext.timeZone,
    count: candidates.length,
    timings: {
      db_ms: dbMs,
      rank_ms: rankMs,
      total_ms: totalMs,
    },
  };
}

export function evaluateTodayRelevance(
  memories: any[],
  calendarEvents: any[],
  activeRelationships: any[],
  referenceDate: Date,
  timeZone: string,
  clientTodayYMD: string,
  dismissedReflectionIds: string[] = [],
  selectedOccasions: OccasionOccurrence[] = []
) {
  const localContext = formatLocalTimeContext(referenceDate.toISOString(), timeZone);
  const candidates = evaluateTodayRelevanceCandidates(
    memories,
    calendarEvents,
    activeRelationships,
    localContext,
    dismissedReflectionIds,
    selectedOccasions
  );
  return {
    candidates,
    reference_time: localContext.localDateTimeStr,
    timezone: localContext.timeZone,
    count: candidates.length,
  };
}

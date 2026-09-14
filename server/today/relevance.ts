import { TodayRelevanceCandidate, TodayRelevanceResponse, CalendarEvent, MemoryItem, OccasionOccurrence } from '../../src/types';
import { buildAnticipatoryPrompt, isStronglyRelevantMemory } from '../anticipatory/promptBuilder';

export function isMemoryEligibleForReflection(memory: any): boolean {
  if (!memory) return false;
  const interp = memory.interpretation || {};
  const mode = memory.anticipatory_mode || interp.anticipatory_mode;
  const optedIn = memory.anticipatory_opted_in !== undefined ? memory.anticipatory_opted_in : interp.anticipatory_opted_in;

  if (optedIn === false) return false;
  if (mode === 'PRE_ONLY') return false;

  const kind = interp.kind;
  const intent = interp.intent;
  const contexts = interp.contexts || [];

  if (kind === 'fact' && (intent === 'general_statement' || !intent)) return false;
  if (intent === 'celebration' || contexts.includes('celebration') || contexts.includes('birthday')) return false;

  if (intent === 'appointment' || contexts.includes('appointment') || kind === 'appointment') {
    return true;
  }

  if (mode === 'PRE_AND_POST' || mode === 'POST_ONLY') {
    return true;
  }

  return false;
}

function getWeekdayName(ymd: string, timeZone: string = 'Australia/Sydney'): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date);
}

function getDaysBetween(ymd1: string, ymd2: string): number {
  const d1 = new Date(ymd1 + 'T00:00:00Z').getTime();
  const d2 = new Date(ymd2 + 'T00:00:00Z').getTime();
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

function getLocalDateYMD(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().split('T')[0];
  }
}

/**
 * Clean action text and format with time cleanly without duplications
 */
export function cleanActionText(text: string, timeStr?: string): string {
  if (!text) return '';
  let cleaned = text.trim();
  // Strip trailing periods
  cleaned = cleaned.replace(/\.+$/, '').trim();

  if (!timeStr) return cleaned;

  // Check if text already contains an explicit time pattern (e.g., "10:00", "10am", "10:30 pm")
  const hasEmbeddedTime = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b/i.test(cleaned);
  if (hasEmbeddedTime) {
    return cleaned;
  }

  return `${cleaned} at ${timeStr}`;
}

/**
 * Check if a reflection has already been recorded/completed for a given event or occasion
 */
export function hasCompletedReflectionForEvent(
  event: { id?: string; occurrenceId?: string; title?: string; start_datetime?: string },
  memories: any[] = [],
  calendarEvents?: any[],
  relationships?: any[],
  timeZone?: string,
  eventDate?: string
): boolean {
  if (!memories || memories.length === 0) return false;
  const eventId = event.occurrenceId || event.id;

  return memories.some((m) => {
    const interp = m.interpretation || {};
    if (interp.linked_event_id && eventId && (interp.linked_event_id === eventId || interp.linked_event_id.includes(eventId))) {
      return true;
    }
    if (interp.is_reflection_response && interp.linked_event_id === eventId) {
      return true;
    }
    if (interp.origin === 'reflection_outcome' && interp.linked_event_id === eventId) {
      return true;
    }
    return false;
  });
}

/**
 * Evaluates today candidates from memories, calendar events, and occasions
 */
export function evaluateTodayRelevanceCandidates(
  memories: any[] = [],
  calendarEvents: any[] = [],
  activeRelationships: any[] = [],
  localContextOrNow: any,
  dismissedList: string[] = [],
  occasions: any[] = []
): TodayRelevanceCandidate[] {
  const candidates: TodayRelevanceCandidate[] = [];
  const dismissedSet = new Set(dismissedList || []);

  let now: Date;
  let timeZone = 'Australia/Sydney';

  if (localContextOrNow instanceof Date) {
    now = localContextOrNow;
  } else if (localContextOrNow && typeof localContextOrNow === 'object') {
    now = localContextOrNow.referenceDate instanceof Date ? localContextOrNow.referenceDate : (localContextOrNow.referenceDate ? new Date(localContextOrNow.referenceDate) : new Date());
    timeZone = localContextOrNow.timeZone || 'Australia/Sydney';
  } else {
    now = new Date();
  }

  const todayYMD = getLocalDateYMD(now, timeZone);

  // 1. Process Occasions
  if (occasions && occasions.length > 0) {
    for (const occ of occasions) {
      const occurrenceId = occ.occurrenceId || occ.occurrence_id || `${occ.occasionId || occ.occasion_id || occ.id}:${occ.startDate || occ.start_date}`;
      if (dismissedSet.has(occurrenceId)) continue;

      const startDate = occ.startDate || occ.start_date;
      const endDate = occ.endDate || occ.end_date || startDate;
      const title = occ.title || occ.name || '';
      const mode = occ.anticipatoryMode || occ.anticipatory_mode || 'PRE_AND_POST';

      // Check if today is before, during, or after occasion
      const isPast = todayYMD > endDate;
      const isToday = todayYMD >= startDate && todayYMD <= endDate;
      const isPre = todayYMD < startDate;

      if (isPast) {
        // Occasion is in the past -> REFLECT stage (if not PRE_ONLY and not answered)
        if (mode === 'PRE_ONLY') continue;

        const hasCompleted = hasCompletedReflectionForEvent(
          { id: occ.occasionId || occ.id, occurrenceId, title, start_datetime: startDate },
          memories
        );
        if (hasCompleted) continue;

        candidates.push({
          source_type: 'occasion',
          source_id: occ.occasionId || occ.id || occurrenceId,
          occurrence_id: occurrenceId,
          relevance_reason: 'post_occasion_reflection',
          display_text: `How did ${title} go? Anything you want me to remember or remind you about?`,
          ticker_headlines: [`How did ${title} go?`],
          priority: 85,
          is_anticipatory: true,
          anticipatory_stage: 'reflect',
          event_title: title,
        });
      } else {
        // PRE stage (or on the day)
        // Find relevant context memories for this occasion (e.g. gifts, plans)
        const relevantMemories = memories.filter((m) => {
          const content = (m.interpretation?.content || m.originalText || '').toLowerCase();
          const occTitleLower = title.toLowerCase();
          // Check if memory mentions Father's Day or Dad for Father's Day
          if (occTitleLower.includes('father') && (content.includes('dad') || content.includes('father'))) {
            return true;
          }
          if (occTitleLower.includes('mother') && (content.includes('mum') || content.includes('mother'))) {
            return true;
          }
          return content.includes(occTitleLower);
        });

        const daysDiff = getDaysBetween(todayYMD, startDate);
        let timingPhrase = 'is coming up';
        if (daysDiff === 0) {
          timingPhrase = 'is today';
        } else if (daysDiff === 1) {
          timingPhrase = 'is tomorrow';
        } else if (daysDiff > 1 && daysDiff <= 7) {
          const weekday = getWeekdayName(startDate, timeZone);
          timingPhrase = `is this ${weekday}`;
        }

        let displayText = `${title} ${timingPhrase}. — Anything you want to remember?`;
        if (relevantMemories.length > 0) {
          const firstMemContent = relevantMemories[0].interpretation?.content || relevantMemories[0].originalText;
          displayText = `${title} ${timingPhrase}. You wanted to ${firstMemContent}. Anything you want to remember?`;
        }

        candidates.push({
          source_type: 'occasion',
          source_id: occ.occasionId || occ.id || occurrenceId,
          occurrence_id: occurrenceId,
          relevance_reason: 'upcoming_occasion',
          display_text: displayText,
          ticker_headlines: [title],
          priority: 80,
          is_anticipatory: true,
          anticipatory_stage: 'prepare',
          event_title: title,
          preparation_items: relevantMemories.map((m) => m.interpretation?.content || m.originalText),
        });
      }
    }
  }

  // 2. Process Calendar Events
  if (calendarEvents && calendarEvents.length > 0) {
    for (const evt of calendarEvents) {
      const eventId = evt.id;
      const occurrenceId = evt.occurrence_id || `${eventId}:${(evt.start_datetime || '').split('T')[0]}`;
      if (dismissedSet.has(occurrenceId) || dismissedSet.has(eventId)) continue;

      const startIso = evt.start_datetime || '';
      const endIso = evt.end_datetime || startIso;
      const eventDate = startIso.split('T')[0];

      // Check if event is on today's civil date
      if (eventDate !== todayYMD) continue;

      const isOptedIn = evt.anticipatory_opted_in !== false;
      const mode = evt.anticipatory_mode || 'PRE_AND_POST';
      const eventStartTime = startIso.includes('T') ? new Date(startIso).getTime() : 0;
      const eventEndTime = endIso.includes('T') ? new Date(endIso).getTime() : eventStartTime + 3600000;
      const nowTime = now.getTime();

      const isPost = nowTime > eventEndTime;

      if (!isOptedIn) {
        // Opted out of anticipatory intelligence -> regular calendar notification
        candidates.push({
          source_type: 'calendar',
          source_id: eventId,
          occurrence_id: occurrenceId,
          relevance_reason: 'calendar_event',
          display_text: evt.title || 'Calendar Event',
          priority: 70,
          is_anticipatory: false,
          event_title: evt.title,
        });
        continue;
      }

      if (isPost) {
        // Past event today -> Reflection stage if mode includes POST
        if (mode === 'PRE_ONLY') continue;

        const hasCompleted = hasCompletedReflectionForEvent(
          { id: eventId, occurrenceId, title: evt.title, start_datetime: startIso },
          memories
        );
        if (hasCompleted) continue;

        const cleanTitle = evt.title || 'appointment';
        const promptRes = buildAnticipatoryPrompt({
          stage: 'POST',
          title: cleanTitle,
        });

        candidates.push({
          source_type: 'calendar',
          source_id: eventId,
          occurrence_id: occurrenceId,
          relevance_reason: 'post_event_reflection',
          display_text: promptRes.prompt,
          ticker_headlines: promptRes.tickerHeadlines,
          priority: 75,
          is_anticipatory: true,
          anticipatory_stage: 'reflect',
          event_title: cleanTitle,
        });
      } else {
        // Upcoming event today
        // If POST_ONLY (e.g. routine event), do NOT show prepare prompt
        if (mode === 'POST_ONLY') {
          candidates.push({
            source_type: 'calendar',
            source_id: eventId,
            occurrence_id: occurrenceId,
            relevance_reason: 'calendar_event',
            display_text: evt.title || 'Upcoming Event',
            priority: 70,
            is_anticipatory: false,
            event_title: evt.title,
          });
        } else {
          // Prepare stage
          const promptRes = buildAnticipatoryPrompt({
            stage: 'PRE',
            title: evt.title || 'Appointment',
            temporalDesc: 'today',
          });

          candidates.push({
            source_type: 'calendar',
            source_id: eventId,
            occurrence_id: occurrenceId,
            relevance_reason: 'upcoming_appointment_prep',
            display_text: promptRes.prompt,
            ticker_headlines: promptRes.tickerHeadlines,
            priority: 80,
            is_anticipatory: true,
            anticipatory_stage: 'prepare',
            event_title: evt.title,
          });
        }
      }
    }
  }

  // 3. Process Memories (reminders, tasks for today)
  if (memories && memories.length > 0) {
    for (const mem of memories) {
      if (dismissedSet.has(mem.id)) continue;
      const interp = mem.interpretation || {};
      const reminderDt = interp.reminder_datetime || interp.resolved_datetime;

      if (reminderDt && reminderDt.startsWith(todayYMD)) {
        // Format time if available
        let timeStr = '';
        if (reminderDt.includes('T')) {
          try {
            const dt = new Date(reminderDt);
            timeStr = dt.toLocaleTimeString('en-US', {
              timeZone,
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            }).toLowerCase().replace(' ', '');
          } catch {}
        }

        const rawContent = interp.content || mem.originalText || '';
        const displayText = cleanActionText(rawContent, timeStr);

        candidates.push({
          source_type: 'memory',
          source_id: mem.id,
          occurrence_id: `${mem.id}:${todayYMD}`,
          relevance_reason: 'scheduled_reminder',
          display_text: displayText,
          priority: 85,
          is_anticipatory: false,
        });
      }
    }
  }

  return candidates;
}

/**
 * Main evaluateTodayRelevance wrapper returning { candidates }
 */
export function evaluateTodayRelevance(
  memories: any[] = [],
  calendarEvents: any[] = [],
  activeRelationships: any[] = [],
  now: Date = new Date(),
  timeZone: string = 'Australia/Sydney',
  todayYMD: string = '',
  dismissedList: string[] = [],
  occasions: any[] = []
): TodayRelevanceResponse {
  let dateYMD = todayYMD;
  if (!dateYMD) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateYMD = formatter.format(now);
  }

  const localContext = {
    referenceDate: now,
    timeZone,
    localDateTimeStr: dateYMD,
    utcIso: now.toISOString(),
  };

  const candidates = evaluateTodayRelevanceCandidates(
    memories,
    calendarEvents,
    activeRelationships,
    localContext,
    dismissedList,
    occasions
  );

  return {
    candidates,
    reference_time: now.toISOString(),
    timezone: timeZone,
  };
}

/**
 * High-level async Today Relevance evaluation for a specific instance/ezzyId
 */
export async function computeTodayRelevance(
  nowIso: string,
  timeZone: string = 'Australia/Sydney',
  locale: string = 'en-AU',
  country: string = 'AU',
  dismissed: string[] = [],
  ezzyId: string = 'ezzy_default'
): Promise<TodayRelevanceResponse> {
  const { readMemories } = await import('../db/memories');
  const { readCalendarEvents } = await import('../calendar/store');
  const { readActiveRelationships } = await import('../relationships');
  const memories = await readMemories(ezzyId).catch(() => []);
  const calendarEvents = await readCalendarEvents(ezzyId).catch(() => []);
  const relationships = await readActiveRelationships(ezzyId).catch(() => []);
  return evaluateTodayRelevance(memories, calendarEvents, relationships, new Date(nowIso), timeZone, '', dismissed);
}


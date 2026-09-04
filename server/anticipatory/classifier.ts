import { AnticipatoryMode, AnticipationOffer } from '../../src/types';

/**
 * Recurring routine regex patterns:
 * e.g. "every Monday", "every Mon, Wed and Fri 9-11am", "Mondays", "every day", "daily", "every weekday"
 */
export const RECURRING_ROUTINE_REGEX = /\b(?:every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|wensday|wens|thu|thur|thurs|fri|sat|sun|day|weekday|weekend|week|month|fortnight)|(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b|daily|weekly|fortnightly|monthly|on\s+[a-z]+days\b)/i;

/**
 * Common appointment/event keywords indicating scheduled interactive meetings/appointments:
 */
export const APPOINTMENT_KEYWORDS_REGEX = /\b(?:doctor|dr\.?|gp|dentist|physio|physiotherapist|specialist|therapist|psychiatrist|psychologist|optometrist|vet|veterinarian|chiropractor|podiatrist|clinic|hospital|appointment|consultation|checkup|meeting|conference|interview|dinner|lunch|breakfast|coffee|drinks|brunch|sync|catchup|catch\s*up|call\s+with|zoom|birthday|bday|anniversary|party|celebration)\b/i;

/**
 * Checks if the text has recurring routine wording
 */
export function isRecurringRoutineText(text: string): boolean {
  if (!text) return false;
  return RECURRING_ROUTINE_REGEX.test(text);
}

/**
 * Checks if the text has one-off appointment/event wording
 */
export function isOneOffAppointmentText(text: string): boolean {
  if (!text) return false;
  return APPOINTMENT_KEYWORDS_REGEX.test(text);
}

/**
 * Deterministic classifier for Ezzymigo Anticipatory Modes:
 * 
 * 1. NONE:
 *    - Undated/perpetual reminders and tasks.
 *    - Example: "Sharpen the knives", "Trim the hedge".
 *    - Stays active until Done/deleted.
 *    - No pre-event prompt.
 *    - No post-event prompt.
 * 
 * 2. POST_ONLY:
 *    - Recurring routines.
 *    - Example: "Visit Mum every Monday, Wednesday and Friday 9–11am".
 *    - No preparation prompt before each routine occurrence.
 *    - After each occurrence, generate a post-event check-in.
 *    - Each occurrence is independent; answering/dismissing one must never suppress future occurrences.
 * 
 * 3. PRE_AND_POST:
 *    - One-off dated appointments/events.
 *    - Examples: doctor, dentist, birthday, dinner, meeting, appointment.
 *    - Before the event, surface an anticipatory preparation prompt.
 *    - After the event, surface a follow-up/reflection prompt.
 */
export function classifyAnticipatoryMode(
  item: {
    content?: string;
    originalText?: string;
    kind?: string;
    intent?: string;
    resurfacing?: { mode?: string; timing?: string };
    resolved_datetime?: string | null;
    reminder_datetime?: string | null;
    event_datetime?: string | null;
    original_time_expression?: string | null;
    contexts?: string[];
    people?: string[];
  },
  originalText?: string
): AnticipatoryMode {
  const content = (item.content || '').trim();
  const rawOriginal = (originalText || item.originalText || '').trim();
  const resurfTiming = (item.resurfacing?.timing || '').trim();
  const origTime = (item.original_time_expression || '').trim();
  const resurfMode = (item.resurfacing?.mode || '').trim().toLowerCase();
  const intent = (item.intent || '').trim().toLowerCase();
  const kind = (item.kind || '').trim().toLowerCase();

  const combined = `${content} ${rawOriginal} ${resurfTiming} ${origTime}`.toLowerCase();

  // 1. RECURRING ROUTINE CHECK -> POST_ONLY
  // Must check recurring first, because a recurring visit like "Visit Mum every Monday, Wednesday and Friday 9–11am"
  // or "Dentist checkup every 6 months" has recurrence.
  if (resurfMode === 'recurring' || isRecurringRoutineText(combined)) {
    return 'POST_ONLY';
  }

  // 2. ONE-OFF DATED APPOINTMENT / EVENT CHECK -> PRE_AND_POST
  // If it's an appointment, meeting, consultation, dinner, birthday, or doctor/dentist:
  const hasAppointmentIntent = ['appointment', 'meeting', 'consultation', 'celebration'].includes(intent);
  const hasAppointmentContext = Array.isArray(item.contexts) &&
    (item.contexts.includes('appointment') || item.contexts.includes('meeting') || item.contexts.includes('consultation'));
  const hasAppointmentKeywords = isOneOffAppointmentText(combined);

  // Check if it has a specific date or time anchor:
  const hasResolvedDatetime = Boolean(item.resolved_datetime || item.event_datetime || item.reminder_datetime);
  const hasExplicitTimeExpr = Boolean(origTime && origTime !== 'Contextual / On retrieval' && origTime !== 'Unscheduled');

  if (hasAppointmentIntent || hasAppointmentContext || hasAppointmentKeywords) {
    return 'PRE_AND_POST';
  }

  // If it is a reminder with a specific dated time (e.g. "dinner with Sarah tomorrow at 7pm", "pickup dry cleaning Friday 4pm"),
  // treat as PRE_AND_POST if dated.
  if ((kind === 'reminder' || intent === 'task') && (hasResolvedDatetime || hasExplicitTimeExpr)) {
    // If it has social/event keywords like "dinner", "lunch", "meet", "visit", "coffee", "see", "party", "flight"
    if (/\b(?:dinner|lunch|breakfast|coffee|drinks|meet|meeting|visit|seeing|see|catchup|catch\s*up|party|flight|conference|interview)\b/i.test(combined)) {
      return 'PRE_AND_POST';
    }
    // Specific dated appointments (e.g. "Dentist", "Doctor") are already caught above.
  }

  // 3. ALL OTHER REMINDERS, UNDATED TASKS, AND FACTS -> NONE
  // Examples: "Sharpen the knives", "Trim the hedge", "Buy milk", "Clean the garage".
  // Perpetual tasks stay active until Done/deleted without pre/post event prompts.
  return 'NONE';
}

/**
 * Generates the explicit user opt-in offer for POST_ONLY and PRE_AND_POST items.
 */
export function generateAnticipationOffer(
  item: {
    id: string;
    originalText?: string;
    content?: string;
    people?: string[];
    interpretation?: any;
  },
  mode: AnticipatoryMode
): AnticipationOffer | null {
  if (mode === 'NONE') return null;

  const text = item.content || item.interpretation?.content || item.originalText || '';
  const people: string[] = item.people || item.interpretation?.people || [];

  // Extract person if available
  let person = people.length > 0 ? people[0] : '';
  if (!person) {
    const visitMatch = text.match(/\b(?:visit|visiting|see|seeing|meet|meeting\s+with)\s+([A-Z][a-z]+)/i);
    if (visitMatch) {
      person = visitMatch[1];
    }
  }

  if (mode === 'POST_ONLY') {
    // Recurring routine question:
    // "Want me to check in after your visits with Mum?" or "Want me to check in after your {routine}?"
    let question: string;
    if (person) {
      question = `Want me to check in after your visits with ${person}?`;
    } else {
      const cleanTitle = text
        .replace(/\s*(?:every\s+[a-z]+|on\s+[a-z]+days?|from\s+\d{1,2}.*|at\s+\d{1,2}.*)$/i, '')
        .trim();
      question = `Want me to check in after your ${cleanTitle || 'routine'}?`;
    }

    return {
      memoryId: item.id,
      mode: 'POST_ONLY',
      question,
      person: person || undefined,
      eventTitle: text,
    };
  }

  if (mode === 'PRE_AND_POST') {
    // One-off event question:
    // "Want me to give you a heads-up beforehand and check in afterward?"
    return {
      memoryId: item.id,
      mode: 'PRE_AND_POST',
      question: 'Want me to give you a heads-up beforehand and check in afterward?',
      person: person || undefined,
      eventTitle: text,
    };
  }

  return null;
}

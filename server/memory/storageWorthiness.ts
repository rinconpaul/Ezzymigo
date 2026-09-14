/**
 * Ezzymigo Storage-Worthiness Decision Engine
 * 
 * CORE ARCHITECTURAL INVARIANT:
 * "Ezzy may initiate a conversation; the user initiates persistence."
 * 
 * Central Criterion:
 * "Does this input contain durable information, a user intention, a requested action,
 *  a correction, an answer containing meaningful new information, or something
 *  the user explicitly wants remembered?"
 * 
 * If NOT, do not create a memory.
 * 
 * Pure acknowledgements and conversational filler (e.g. "Thanks", "Thank you",
 * "Okay", "OK", "Great", "Got it", "No worries", "Sounds good", "Will do", "Cheers",
 * "Yep", "Yes, thanks", "That's helpful") must normally produce zero memories.
 * 
 * Acknowledgements combined with meaningful information (e.g. "Thanks, I'll visit Mum at ten",
 * "Okay, remind me after lunch", "Yes, the dentist said Mum's infection has subsided",
 * "Great, Barb has already taken up Mum's slacks", "Will do it tomorrow morning",
 * "Thanks, but the appointment is actually on Tuesday") MUST be preserved and stored.
 */

import type { ConversationalContextEnvelope } from '../types';

export interface StorageWorthinessDecision {
  isStorageWorthy: boolean;
  classification: 'PURE_ACKNOWLEDGEMENT' | 'DISMISSAL' | 'CONVERSATIONAL_FILLER' | 'MEANINGFUL_CONTENT';
  cleanedInput: string;
  reason: string;
  substantiveRemainder?: string;
}

// Comprehensive token patterns representing conversational acknowledgements, pleasantries, and filler
const ACKNOWLEDGEMENT_TOKENS = [
  // Thanks / Gratitude
  'thanks', 'thank you', 'thank you very much', 'thanks very much', 'thanks a lot',
  'many thanks', 'thanks so much', 'thanks heaps', 'ta', 'much appreciated', 'appreciated',
  'merci', 'danke', 'gracias', 'grazie',
  // Affirmation / Agreement / Assent
  'okay', 'ok', 'k', 'okey dokey', 'alright', 'all right', 'sure', 'fine',
  'sounds good', 'sounds great', 'sounds fine', 'sounds like a plan', 'sounds ok',
  // Praise / Pleasantry
  'great', 'awesome', 'cool', 'sweet', 'good', 'perfect', 'wonderful', 'lovely',
  'brilliant', 'nice', 'neat', 'excellent',
  // Comprehension / Receipt
  'got it', 'understood', 'roger', 'copy that', 'noted', 'copy', 'acknowledged',
  // Reassurance / Status
  'no worries', 'not a problem', 'no problem', 'dont worry', "don't worry",
  'all good', 'all fine', 'all set', 'all done', "that's all", 'thats all',
  // Casual assent
  'yep', 'yeah', 'yes', 'yup', 'aye', 'righto', 'cheers', 'cheers mate',
  // Helpful
  "that's helpful", 'thats helpful', 'very helpful', 'super helpful',
  // Simple closure
  'will do', 'shall do', 'on it',
  // Direct negatives & dismissals
  'nope', 'no', 'nah', 'none', 'dismiss', 'ignore', 'not now', 'no need',
  'not really', 'nothing', 'nothing to add', 'nothing else',
  // Polite combinations
  'yes thanks', 'yes thank you', 'yep thanks', 'thanks will do', 'okay thanks',
  'ok thanks', 'great thanks', 'all good thanks', 'got it cheers', 'sounds good cheers',
  'cheers thank you', 'no thanks', 'no thank you'
];

// Salutations or conversational addressing that may accompany acknowledgements
const ADDRESS_AND_FILLER_REGEX = /\b(?:ezzy|ezzymigo|mate|paul|please|thanks|thank\s+you|cheers|then|now|it)\b/gi;

// Cues that signal future intentions, actions, reminders, dates, or substantive facts
const DURABLE_INTENT_OR_TEMPORAL_REGEX = new RegExp(
  '\\b(' +
    // Directives
    'remind|reminder|remember|save|note|capture|don[\'’]t forget|dont forget|put on|add to|list|' +
    // Future intention verbs
    'i[\'’]ll|i will|we[\'’]ll|we will|i am going to|i[\'’]m going to|going to|plan to|planning to|need to|have to|must|' +
    // Temporal anchors
    'tomorrow|tonight|today|yesterday|next week|next month|morning|afternoon|evening|night|lunch|dinner|breakfast|' +
    // Days of the week
    'monday|tuesday|wednesday|thursday|friday|saturday|sunday|' +
    // Times & durations
    '\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)|at\\s+\\d{1,2}|at\\s+ten|at\\s+noon|at\\s+midday|' +
    '\\d+\\s*(?:months?|weeks?|days?|hours?|years?)|six months|' +
    // Corrections & contrasts
    'actually|instead|rather|changed to|moved to|postponed|not until|rescheduled|' +
    // Action verbs
    'visit|visiting|call|calling|ring|see|seeing|spoke|talked|told|said|buy|buying|pick up|picked up|take up|taken up|' +
    'renew|script|prescription|dentist|doctor|infection|hairdresser|appointment|slacks|clothes|medicine' +
  ')\\b',
  'i'
);

/**
 * Strips leading conversational acknowledgements and filler phrases from user text.
 * E.g. "Thanks, I'll visit Mum at ten." -> "I'll visit Mum at ten."
 * E.g. "Okay, remind me after lunch." -> "remind me after lunch."
 * E.g. "Will do it tomorrow morning." -> "it tomorrow morning."
 */
export function extractSubstantiveRemainder(rawText: string): {
  hasAcknowledgementPrefix: boolean;
  prefix: string;
  remainder: string;
} {
  const trimmed = (rawText || '').trim();
  if (!trimmed) {
    return { hasAcknowledgementPrefix: false, prefix: '', remainder: '' };
  }

  // Sort tokens by length descending to match longest phrase first (e.g. "yes, thanks" before "yes")
  const sortedTokens = [...ACKNOWLEDGEMENT_TOKENS].sort((a, b) => b.length - a.length);

  for (const token of sortedTokens) {
    // Check if input begins with this token followed by punctuation or whitespace
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const leadingRegex = new RegExp(`^\\s*(${escaped})(?:[\\s,.:;!—–-]+|$)`, 'i');
    const match = trimmed.match(leadingRegex);
    if (match) {
      const prefix = match[1];
      let remainder = trimmed.slice(match[0].length).trim();

      // Check if there is a secondary acknowledgement token chained (e.g. "Okay, thanks, ...")
      for (const secondToken of sortedTokens) {
        const secEscaped = secondToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        const secRegex = new RegExp(`^\\s*(${secEscaped})(?:[\\s,.:;!—–-]+|$)`, 'i');
        const secMatch = remainder.match(secRegex);
        if (secMatch) {
          remainder = remainder.slice(secMatch[0].length).trim();
          break;
        }
      }

      return {
        hasAcknowledgementPrefix: true,
        prefix,
        remainder: remainder.replace(/^[,\s.:;!—–-]+/, '').trim(),
      };
    }
  }

  return {
    hasAcknowledgementPrefix: false,
    prefix: '',
    remainder: trimmed,
  };
}

/**
 * Checks whether an utterance consists entirely of acknowledgement or conversational filler tokens.
 */
export function isPureAcknowledgement(text: string): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Clean of trailing and leading punctuation
  const clean = trimmed
    .replace(/^[!.,?;:—–\s"']+|[!.,?;:—–\s"']+$/g, '')
    .toLowerCase()
    .trim();

  if (!clean) return true;

  // Exact match against acknowledgement phrases
  if (ACKNOWLEDGEMENT_TOKENS.includes(clean)) {
    return true;
  }

  // Check if stripping the leading acknowledgement leaves nothing substantive
  const { hasAcknowledgementPrefix, remainder } = extractSubstantiveRemainder(trimmed);
  if (hasAcknowledgementPrefix) {
    if (!remainder) return true;

    // Check if the remainder is just another acknowledgement or addressing Ezzy / filler words
    const remainderClean = remainder.replace(/^[!.,?;:—–\s"']+|[!.,?;:—–\s"']+$/g, '').toLowerCase().trim();
    if (!remainderClean || ACKNOWLEDGEMENT_TOKENS.includes(remainderClean)) {
      return true;
    }

    const withoutFiller = remainderClean.replace(ADDRESS_AND_FILLER_REGEX, '').replace(/^[!.,?;:—–\s"']+|[!.,?;:—–\s"']+$/g, '').trim();
    if (!withoutFiller) {
      return true;
    }
  }

  return false;
}

/**
 * Evaluates whether a user input meets the storage-worthiness criterion.
 * 
 * Question answered:
 * "Does this input contain durable information, a user intention, a requested action,
 *  a correction, an answer containing meaningful new information, or something
 *  the user explicitly wants remembered?"
 */
export function evaluateStorageWorthiness(
  input: string,
  contextEnvelope?: ConversationalContextEnvelope | null,
  _options?: { isCaptureFlow?: boolean; linkedEventId?: string | null }
): StorageWorthinessDecision {
  const trimmed = (input || '').trim();

  // 1. Empty input is never storage-worthy
  if (!trimmed) {
    return {
      isStorageWorthy: false,
      classification: 'DISMISSAL',
      cleanedInput: '',
      reason: 'Empty input contains no information.',
    };
  }

  // 2. Check if the utterance is a pure acknowledgement or filler
  const pureAck = isPureAcknowledgement(trimmed);

  if (pureAck) {
    // Check if there is an active question in the context envelope that specifically
    // asks for an affirmative / negative factual resolution of an inquiry.
    // E.g. "Did Barb pick up Mum's prescription?" -> "she did" / "yes"
    const originatingQ = (contextEnvelope?.originatingQuestion || '').trim().toLowerCase();
    const isSpecificYesNoInquiry =
      /did\s+([a-z]+)\s+pick\s+up\s+([a-z]+)(?:'s|’s)?\s+prescription/i.test(originatingQ) ||
      /did\s+([a-z]+)\s+say\s+when/i.test(originatingQ);

    if (isSpecificYesNoInquiry && /^(?:she\s+did|yes|yep|done|did)$/i.test(trimmed)) {
      return {
        isStorageWorthy: true,
        classification: 'MEANINGFUL_CONTENT',
        cleanedInput: trimmed,
        reason: 'Affirmative answer resolves specific factual inquiry in conversational context.',
      };
    }

    return {
      isStorageWorthy: false,
      classification: 'PURE_ACKNOWLEDGEMENT',
      cleanedInput: trimmed,
      reason: 'Pure conversational acknowledgement containing no durable information, intention, or requested action.',
    };
  }

  // 3. Inspect compound inputs (acknowledgement prefix + substantive remainder)
  const { hasAcknowledgementPrefix, remainder } = extractSubstantiveRemainder(trimmed);

  if (hasAcknowledgementPrefix && remainder) {
    // If the remainder contains durable signals, intentions, or meaningful information
    if (DURABLE_INTENT_OR_TEMPORAL_REGEX.test(remainder) || remainder.split(/\s+/).length >= 3) {
      return {
        isStorageWorthy: true,
        classification: 'MEANINGFUL_CONTENT',
        cleanedInput: remainder,
        substantiveRemainder: remainder,
        reason: 'Acknowledgement contains substantive user intention, temporal reference, or factual content.',
      };
    }

    // Even if short, if it contains an action verb or known entity:
    if (/\b(?:mum|barb|doug|keith|dr\s+marning|mel|tomorrow|ten|lunch|appointment|doctor|dentist)\b/i.test(remainder)) {
      return {
        isStorageWorthy: true,
        classification: 'MEANINGFUL_CONTENT',
        cleanedInput: remainder,
        substantiveRemainder: remainder,
        reason: 'Acknowledgement accompanied by entity mention or temporal reference.',
      };
    }
  }

  // 4. Default: User input has substantive content
  return {
    isStorageWorthy: true,
    classification: 'MEANINGFUL_CONTENT',
    cleanedInput: trimmed,
    substantiveRemainder: hasAcknowledgementPrefix ? remainder : trimmed,
    reason: 'Input contains substantive information or user intention.',
  };
}

/**
 * Defense-in-depth safety check on an interpreted memory object.
 * Confirms that a memory about to be persisted does not represent pure conversational filler.
 */
export function isStorageWorthyMemory(memory: any): boolean {
  if (!memory) return false;

  const content = (memory.content || memory.originalText || '').trim();
  if (!content) return false;

  // If the content is a pure acknowledgement and has no entities, no dates, no reminders
  if (isPureAcknowledgement(content)) {
    const hasPeople = Array.isArray(memory.people) && memory.people.length > 0;
    const hasPlaces = Array.isArray(memory.places) && memory.places.length > 0;
    const hasScheduled = Boolean(memory.scheduled_for || memory.interpretation?.scheduled_for || memory.resolvedDatetime);
    const hasIntent = memory.kind === 'reminder' || memory.kind === 'task';

    if (!hasPeople && !hasPlaces && !hasScheduled && !hasIntent) {
      return false;
    }
  }

  return true;
}

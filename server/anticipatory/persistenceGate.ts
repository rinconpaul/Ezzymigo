/**
 * Ezzymigo Anticipatory Response Persistence Gate
 * 
 * CORE ARCHITECTURAL INVARIANT:
 * "Ezzy may initiate a conversation; the user initiates persistence."
 * 
 * Strict Persistence Semantics:
 * 1. Ezzy may initiate an anticipatory check-in prompt (e.g. PRE/POST event or routine).
 * 2. An ordinary conversational response (e.g. "It went well", "We had a lovely time",
 *    or casual report) must NOT automatically create a permanent memory.
 * 3. Ignore / dismiss / nope ("nope", "no", "nothing", "all good", "dismiss") creates NOTHING.
 * 4. ONLY an explicit Save / capture / reminder instruction crosses into the existing Tell/reminder pipeline.
 */

export type AnticipatoryResponseClassification =
  | 'DISMISS'
  | 'CONVERSATIONAL'
  | 'EXPLICIT_PERSISTENCE';

export interface AnticipatoryPersistenceEvaluation {
  shouldPersist: boolean;
  classification: AnticipatoryResponseClassification;
  instructionType?: 'save' | 'remember' | 'reminder' | 'capture' | 'note';
  cleanContent?: string;
  reason: string;
}

// -----------------------------------------------------------------------------
// 1. DISMISSAL & NEGATIVE PATTERNS ("Ignore / dismiss / nope")
// -----------------------------------------------------------------------------

const DISMISSAL_EXACT_OR_LEADING_REGEX = new RegExp(
  '^\\s*(?:' +
    // Direct negatives & dismissals
    'nope|no|nah|none|dismiss|ignore|not\\s+now|no\\s+need|not\\s+really|' +
    // "Nothing" variants
    'nothing(?:\\s+(?:to\\s+(?:add|remember|note|save)|else|for\\s+now|right\\s+now|needed))?|' +
    'nothing\\s*,?\\s*(?:thanks|all\\s+good)?|' +
    // Polite declines
    'no\\s+(?:thanks|thank\\s+you)|' +
    // "All good" / "We're fine" variants
    'all\\s+good|all\\s+set|all\\s+done|all\\s+fine|that[\'’]s\\s+all|' +
    '(?:we|i)(?:[\'’]re|\\s+are|\\s+am|[\'’]m)?\\s+(?:fine|all\\s+good|good|okay|ok)|' +
    'don[\'’]t\\s+need\\s+anything|dont\\s+need\\s+anything|' +
    // Multilingual equivalents
    'nada|ninguno|todo\\s+bien|no\\s+gracias|' + // ES
    'rien|tout\\s+va\\s+bien|pas\\s+besoin|merci\\s+mais\\s+non|' + // FR
    'nichts|alles\\s+gut|kein\\s+bedarf|nein\\s+danke|' + // DE
    'niente|tutto\\s+(?:a\\s+posto|bene)' + // IT
  ')(?:\\s*[.!,]*)?$',
  'i'
);

const DISMISSAL_PREFIX_REGEX = new RegExp(
  '^\\s*(?:nope|no|nah|nothing)[,.]?\\s*(?:all\\s+good|thanks|thank\\s+you|we[\'’]re\\s+fine|i[\'’]m\\s+fine|nothing\\s+to\\s+(?:add|remember)|that[\'’]s\\s+all|no\\s+need)?(?:\\s*[.!,]*)?$',
  'i'
);

/**
 * Checks if the user's response is an ignore/dismiss/nope utterance.
 */
export function isAnticipatoryDismissal(text: string): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  return DISMISSAL_EXACT_OR_LEADING_REGEX.test(trimmed) || DISMISSAL_PREFIX_REGEX.test(trimmed);
}

// -----------------------------------------------------------------------------
// 2. EXPLICIT PERSISTENCE INSTRUCTION PATTERNS
// -----------------------------------------------------------------------------

// Explicit Save directives: "Save: ...", "Save that ...", "Please save ...", "Guarda: ...", "Sauvegarde: ..."
const EXPLICIT_SAVE_REGEX = /^\s*(?:(?:please\s+)?save(?:\s+(?:that|this|the\s+following))?[:\s]+|guarda(?:\s+(?:que|esto))?[:\s]+|guardar[:\s]+|sauvegarde(?:\s+(?:que|ceci))?[:\s]+|enregistre(?:\s+(?:que|ceci))?[:\s]+|speichern[:\s]+)(.+)$/is;

// Explicit Remember directives: "Remember that ...", "Please remember ...", "Don't forget ...", "Recuerda que ...", "N'oublie pas ..."
const EXPLICIT_REMEMBER_REGEX = /^\s*(?:(?:please\s+)?remember(?:\s+(?:that|this)|:)?\s+|make\s+sure\s+(?:to\s+remember|you\s+remember)\s+|don[\'’]t\s+(?:let\s+me\s+)?forget\s+|recuerda(?:\s+que)?\s+|no\s+olvides\s+|rappelle[- ]toi(?:\s+de|\s+que)?\s+|n[\'’]oublie\s+pas\s+|vergiss\s+nicht\s+)(.+)$/is;

// Explicit Reminder directives: "Remind me to ...", "Set a reminder for ...", "Reminder: ...", "Recuérdame ...", "Rappelle-moi ..."
const EXPLICIT_REMINDER_REGEX = /^\s*(?:(?:please\s+)?remind\s+me(?:\s+to|\s+that|\s+about)?\s+|set\s+(?:a\s+)?reminder(?:\s+to|\s+for)?\s+|reminder[:\s]+|give\s+me\s+a\s+reminder(?:\s+to|\s+for)?\s+|recu[eé]rdame(?:\s+que|\s+de)?\s+|rappelle[- ]moi(?:\s+de|\s+que)?\s+|erinnere\s+mich(?:\s+daran)?\s+)(.+)$/is;

// Explicit Capture / Note directives: "Capture: ...", "Note: ...", "Take a note: ...", "Record that: ..."
const EXPLICIT_CAPTURE_NOTE_REGEX = /^\s*(?:(?:please\s+)?capture(?:\s+(?:that|this))?[:\s]+|(?:take\s+(?:a\s+)?|keep\s+(?:a\s+)?|add\s+(?:a\s+)?)?note[:\s]+|record(?:\s+(?:that|this))?[:\s]+|notiz[:\s]+|toma\s+nota[:\s]+)(.+)$/is;

/**
 * Checks whether the input contains an explicit Save/capture/reminder instruction.
 */
export function isExplicitPersistenceInstruction(text: string): {
  isExplicit: boolean;
  instructionType?: 'save' | 'remember' | 'reminder' | 'capture' | 'note';
  cleanContent?: string;
} {
  if (!text) return { isExplicit: false };
  const trimmed = text.trim();
  if (!trimmed) return { isExplicit: false };

  // Never treat dismissals as explicit instructions
  if (isAnticipatoryDismissal(trimmed)) {
    return { isExplicit: false };
  }

  // 1. Explicit Save
  const saveMatch = trimmed.match(EXPLICIT_SAVE_REGEX);
  if (saveMatch && saveMatch[1]?.trim()) {
    return {
      isExplicit: true,
      instructionType: 'save',
      cleanContent: saveMatch[1].trim(),
    };
  }

  // 2. Explicit Remember
  const rememberMatch = trimmed.match(EXPLICIT_REMEMBER_REGEX);
  if (rememberMatch && rememberMatch[1]?.trim()) {
    return {
      isExplicit: true,
      instructionType: 'remember',
      cleanContent: rememberMatch[1].trim(),
    };
  }

  // 3. Explicit Reminder
  const reminderMatch = trimmed.match(EXPLICIT_REMINDER_REGEX);
  if (reminderMatch && reminderMatch[1]?.trim()) {
    return {
      isExplicit: true,
      instructionType: 'reminder',
      cleanContent: reminderMatch[1].trim(),
    };
  }

  // 4. Explicit Capture / Note
  const captureMatch = trimmed.match(EXPLICIT_CAPTURE_NOTE_REGEX);
  if (captureMatch && captureMatch[1]?.trim()) {
    const isNote = /note/i.test(trimmed.slice(0, 15));
    return {
      isExplicit: true,
      instructionType: isNote ? 'note' : 'capture',
      cleanContent: captureMatch[1].trim(),
    };
  }

  return { isExplicit: false };
}

// -----------------------------------------------------------------------------
// 3. MAIN EVALUATION FUNCTION
// -----------------------------------------------------------------------------

/**
 * Evaluates persistence semantics for a response to an Ezzy-initiated anticipatory prompt.
 * 
 * Invariant: "Ezzy may initiate a conversation; the user initiates persistence."
 * - Ignore / dismiss / nope creates nothing.
 * - Ordinary conversational response does not automatically create permanent memory.
 * - Only an explicit Save/capture/reminder instruction crosses into the existing Tell/reminder pipeline.
 */
export function evaluateAnticipatoryResponsePersistence(
  response: string
): AnticipatoryPersistenceEvaluation {
  const trimmed = (response || '').trim();

  // Case 1: Empty or Dismissal ("Ignore / dismiss / nope creates nothing")
  if (!trimmed || isAnticipatoryDismissal(trimmed)) {
    return {
      shouldPersist: false,
      classification: 'DISMISS',
      reason: 'User dismissed or declined persistence (ignore/dismiss/nope creates nothing).',
    };
  }

  // Case 2: Explicit Save / capture / reminder instruction
  const explicitCheck = isExplicitPersistenceInstruction(trimmed);
  if (explicitCheck.isExplicit) {
    return {
      shouldPersist: true,
      classification: 'EXPLICIT_PERSISTENCE',
      instructionType: explicitCheck.instructionType,
      cleanContent: explicitCheck.cleanContent,
      reason: `User explicitly initiated persistence via "${explicitCheck.instructionType}" instruction.`,
    };
  }

  // Case 3: Ordinary Conversational Response without explicit instruction
  // (e.g. "It went well", "We had a lovely time", "Mum loved her new slacks and she wants to look at cardigans next week")
  // Invariant: "Ezzy may initiate a conversation; the user initiates persistence.
  // An anticipatory prompt and ordinary response must not automatically create permanent memory."
  return {
    shouldPersist: false,
    classification: 'CONVERSATIONAL',
    reason:
      'Ordinary conversational response to anticipatory prompt does not automatically create permanent memory. Only explicit Save/capture/reminder instructions enter persistence.',
  };
}

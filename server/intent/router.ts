import { GoogleGenAI } from '@google/genai';
import { intentClassificationSchema } from '../ai/schemas';

export interface IntentRoutingResult {
  intent_class:
    | 'IMMEDIATE_CONTACT_ACTION'
    | 'CONTACT_INFORMATION_QUERY'
    | 'FUTURE_CONTACT_INTENTION'
    | 'CONTACT_FACT'
    | 'GENERAL_THOUGHT';
  action_type: 'call' | 'sms' | 'none';
  target_person: string | null;
  target_role: string | null;
  prefilled_message: string | null;
  has_temporal_anchor: boolean;
  temporal_expression: string | null;
  raw_input: string;
}

// Deterministic temporal pattern to ensure no future/scheduled timing leaks into IMMEDIATE_CONTACT_ACTION
const FUTURE_TEMPORAL_PATTERN = /\b(?:tomorrow(?:\s+(?:morning|afternoon|evening|night))?|tonight|yesterday|this\s+(?:morning|afternoon|evening|night|weekend|week)|next\s+(?:week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|saturday|sunday|monday|tuesday|wednesday|thursday|friday|january|february|march|april|may|june|july|august|september|october|november|december|at\s+\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?|\d{1,2}(?::\d{2})?\s*(?:am|pm)|in\s+\d+\s*(?:mins?|minutes?|hours?|days?|weeks?)|after\s+(?:my\s+)?[a-z]+|when\s+[a-z]+|later(?:\s+on)?)\b/i;

// Explicit reminder framing pattern
const EXPLICIT_REMINDER_PATTERN = /\b(?:remind\s+me\s+to|don['’]t\s+let\s+me\s+forget\s+to|set\s+a\s+reminder|give\s+me\s+a\s+reminder|make\s+a\s+reminder)\b/i;

// Contact info query pattern
const CONTACT_QUERY_PATTERN = /\b(?:what['’]?s|what\s+is|do\s+i\s+have|can\s+you\s+(?:give|tell)\s+me)\s+(?:the\s+|my\s+)?[a-z0-9\s'’-]+(?:phone(?:\s*number)?|mobile|number|cell|email|contact(?:\s*info)?)\b/i;

// Contact fact/relationship pattern (e.g. "Fred is my electrician", "Barb's mobile is 0412...")
const CONTACT_FACT_PATTERN = /\b(?:is\s+my\s+|is\s+the\s+|'s\s+(?:mobile|phone|number|cell|email)\s+is)\b/i;

export async function routeUserIntent(
  rawInput: string,
  ai: GoogleGenAI
): Promise<IntentRoutingResult> {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) {
    return {
      intent_class: 'GENERAL_THOUGHT',
      action_type: 'none',
      target_person: null,
      target_role: null,
      prefilled_message: null,
      has_temporal_anchor: false,
      temporal_expression: null,
      raw_input: trimmed,
    };
  }

  // Pre-check deterministic indicators
  const hasDeterministicTemporal = FUTURE_TEMPORAL_PATTERN.test(trimmed);
  const isExplicitReminder = EXPLICIT_REMINDER_PATTERN.test(trimmed);
  const isContactQuery = CONTACT_QUERY_PATTERN.test(trimmed);

  try {
    const prompt = `Analyze the user's input and classify its semantic intent class:

1. IMMEDIATE_CONTACT_ACTION:
   The user is giving an imperative command to initiate communication RIGHT NOW with a person or role.
   Examples:
   - "Ring Fred."
   - "Call Fred."
   - "Text Fred."
   - "Text Fred I'm running late"
   - "Message Fred."
   - "Phone Mum."
   - "Give Fred a ring."
   - "Can you call Fred?"
   - "Phone the electrician."
   - "Send Fred a text."
   CRITICAL: There must be NO future temporal qualifier (no "tomorrow", "at 4pm", "tonight", "after my meeting", etc.).

2. CONTACT_INFORMATION_QUERY:
   The user is asking a question to find or retrieve phone number, email, or contact details.
   Examples:
   - "What's Fred's phone number?"
   - "What's Mum's mobile?"
   - "Do I have Kevin's number?"

3. FUTURE_CONTACT_INTENTION:
   The user intends to contact someone in the FUTURE, or is asking for a reminder to contact someone.
   Examples:
   - "Remind me to ring Fred tomorrow."
   - "I need to phone Mum tonight."
   - "Text Kevin after my appointment."
   - "Ring Fred at 4pm."
   - "Don't let me forget to phone Mum after lunch."
   - "I should call Fred tomorrow."

4. CONTACT_FACT:
   The user is providing knowledge about a person's role, relationship, or contact details.
   Examples:
   - "Fred is my electrician."
   - "Fred is my electrician, 0412 345 678."
   - "Barb's mobile is 0411 222 333."

5. GENERAL_THOUGHT:
   Any other thought, note, task, shopping list, observation, memory, or reflection.
   Examples:
   - "Buy 9V batteries for smoke alarm."
   - "Dentist appointment went well."

User Input: "${trimmed}"`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: prompt,
      config: {
        systemInstruction:
          'You are Ezzymigo\'s Action and Intent Router. Accurately classify communication commands, queries, future reminders, facts, and general thoughts. Output strictly valid JSON matching the schema.',
        responseMimeType: 'application/json',
        responseSchema: intentClassificationSchema,
        temperature: 0.1,
      },
    });

    if (response.text) {
      const parsed = JSON.parse(response.text);
      let intentClass = parsed.intent_class;
      let actionType = parsed.action_type || 'none';
      let targetPerson = parsed.target_person || null;
      let targetRole = parsed.target_role || null;
      let prefilledMessage = parsed.prefilled_message || null;
      let hasTemporal = Boolean(parsed.has_temporal_anchor) || hasDeterministicTemporal;
      let temporalExpr = parsed.temporal_expression || null;

      // Deterministic Safeguard 1: Temporal expressions forbid IMMEDIATE_CONTACT_ACTION
      if (hasTemporal && intentClass === 'IMMEDIATE_CONTACT_ACTION') {
        intentClass = 'FUTURE_CONTACT_INTENTION';
      }

      // Deterministic Safeguard 2: Explicit reminder phrasing is always FUTURE_CONTACT_INTENTION
      if (isExplicitReminder) {
        intentClass = 'FUTURE_CONTACT_INTENTION';
      }

      // Deterministic Safeguard 3: Contact queries
      if (isContactQuery && intentClass !== 'CONTACT_INFORMATION_QUERY') {
        intentClass = 'CONTACT_INFORMATION_QUERY';
      }

      // Deterministic Safeguard 4: Pre-fill message extraction for SMS
      if (actionType === 'sms' && !prefilledMessage) {
        // e.g. "Text Fred I'm running late" -> text = "I'm running late"
        const smsMatch = trimmed.match(/^(?:text|message|send\s+(?:a\s+)?(?:text|message)\s+to)\s+([a-z0-9\s'’-]+?)\s+(?:saying\s+|that\s+)?([a-z0-9\s'’.,!?-]+)$/i);
        if (smsMatch && smsMatch[2] && !/^(?:tomorrow|at\s+\d|tonight|later)/i.test(smsMatch[2])) {
          prefilledMessage = smsMatch[2].trim();
        }
      }

      return {
        intent_class: intentClass,
        action_type: actionType,
        target_person: targetPerson,
        target_role: targetRole,
        prefilled_message: prefilledMessage,
        has_temporal_anchor: hasTemporal,
        temporal_expression: temporalExpr,
        raw_input: trimmed,
      };
    }
  } catch (err: any) {
    console.error('[IntentRouter] Error in semantic classification:', err?.message || err);
  }

  // Deterministic Fallback if model fails
  if (isExplicitReminder || hasDeterministicTemporal) {
    return {
      intent_class: 'FUTURE_CONTACT_INTENTION',
      action_type: 'none',
      target_person: null,
      target_role: null,
      prefilled_message: null,
      has_temporal_anchor: true,
      temporal_expression: null,
      raw_input: trimmed,
    };
  }

  if (isContactQuery) {
    return {
      intent_class: 'CONTACT_INFORMATION_QUERY',
      action_type: 'none',
      target_person: null,
      target_role: null,
      prefilled_message: null,
      has_temporal_anchor: false,
      temporal_expression: null,
      raw_input: trimmed,
    };
  }

  if (CONTACT_FACT_PATTERN.test(trimmed)) {
    return {
      intent_class: 'CONTACT_FACT',
      action_type: 'none',
      target_person: null,
      target_role: null,
      prefilled_message: null,
      has_temporal_anchor: false,
      temporal_expression: null,
      raw_input: trimmed,
    };
  }

  // Fallback imperative check: "Ring Fred", "Call Fred", "Text Fred"
  const immediateMatch = trimmed.match(/^(?:(?:can\s+you\s+)?(?:call|ring|phone|text|message)|give\s+([a-z0-9\s'’-]+)\s+a\s+(?:ring|call)|send\s+([a-z0-9\s'’-]+)\s+a\s+(?:text|message))\b/i);
  if (immediateMatch) {
    const isCall = /\b(?:call|ring|phone)\b/i.test(trimmed);
    const isSms = /\b(?:text|message)\b/i.test(trimmed);
    return {
      intent_class: 'IMMEDIATE_CONTACT_ACTION',
      action_type: isCall ? 'call' : (isSms ? 'sms' : 'none'),
      target_person: null,
      target_role: null,
      prefilled_message: null,
      has_temporal_anchor: false,
      temporal_expression: null,
      raw_input: trimmed,
    };
  }

  return {
    intent_class: 'GENERAL_THOUGHT',
    action_type: 'none',
    target_person: null,
    target_role: null,
    prefilled_message: null,
    has_temporal_anchor: false,
    temporal_expression: null,
    raw_input: trimmed,
  };
}

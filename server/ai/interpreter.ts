import { GoogleGenAI } from '@google/genai';
import { memoriesResponseSchema } from './schemas';
import { splitCaptureIntoUnits } from './splitter';
import { getYMDInTz, parseTimeStringToHM, parseReminderTriggerTime } from '../utils/time';
import { detectClockTimeAmbiguity } from '../utils/timeAmbiguity';

// Extracts structured item entries from collection text if needed
export function extractItemsFromText(content: string, originalText: string): string[] {
  const text = (originalText || content || '').trim();
  if (!text) return [];

  // Check if text is a collection / recipe / list
  if (text.includes(':')) {
    const afterColon = text.slice(text.indexOf(':') + 1).trim();
    if (afterColon.includes('\n')) {
      const parts = afterColon.split('\n').map(s => s.replace(/^[-•*–—\d.)\s]+/, '').trim()).filter(Boolean);
      if (parts.length > 1) return parts;
    }
    if (/\b(?:the filling|filling):/i.test(afterColon) || afterColon.includes('.')) {
      const parts = afterColon.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map(p => p.replace(/^[-•*–—\s]+/, '').trim()).filter(Boolean);
      if (parts.length > 1) return parts;
    }
    if (afterColon.includes(',') || afterColon.includes(' and ')) {
      const parts = afterColon.split(/,\s*|\s+and\s+/i).map(p => p.replace(/^[-•*–—\s]+|[.,!?;]+$/g, '').trim()).filter(Boolean);
      if (parts.length > 1) return parts;
    }
  }

  return [];
}

/**
 * Defensive guard to discard unwanted product-search and shopping actions.
 * Ezzymigo is a personal memory/intention assistant, not a shopping or product-search service.
 */
export function isProductOrShoppingSuggestedAction(action: { label?: string; query?: string; type?: string } | null | undefined): boolean {
  if (!action || typeof action !== 'object') return false;
  const label = (action.label || '').trim().toLowerCase();

  // Explicit product / shopping / retailer search labels
  if (/\b(?:product|shopping|retailer|price lookup|find price|where to buy|buy online|store price)\b/i.test(label)) {
    return true;
  }
  if (/^find (?:this |the |a )?product\b/i.test(label)) {
    return true;
  }
  if (/^(?:buy|purchase|shop for|find price of|find deal on)\b/i.test(label)) {
    return true;
  }
  return false;
}

// Fallback heuristic extraction if Gemini is unreachable or key is missing
export function fallbackInterpretation(text: string, now: Date = new Date()) {
  const words = text.split(/\s+/).filter(Boolean);
  const triggerTime = parseReminderTriggerTime(text, '', now);
  const isTemporal = !!triggerTime;
  const isActionable = /^(?:i\s+need\s+to|need\s+to|i\s+have\s+to|have\s+to|i\s+must|must|i\s+should|should|got\s+to|remember\s+to|don't\s+forget\s+to|todo|book|ring|call|phone|buy|get|pick\s+up|order|pay|email|send|write|make|schedule|arrange|fix|repair|wash|check|ask|tell|remind|take|put|clean|vacuum)\b/i.test(text.trim());
  const isNotSure = /^(this|that|it)('s| is| was)?\s+(just\s+)?(going nowhere|so reckless|pointless|too much|so crazy)/i.test(text.trim()) || /^(what even was that|i don't know what to do about it)/i.test(text.trim());
  const kind = isNotSure ? 'not_sure' : (isTemporal || isActionable) ? 'reminder' : 'fact';
  const intent = isNotSure ? 'not_sure' : /buy|purchase|get/i.test(text) ? 'purchase' : /ring|call|phone|email|contact/i.test(text) ? 'contact' : /book|schedule|appointment/i.test(text) ? 'appointment' : isActionable ? 'task' : isTemporal ? 'reminder' : 'fact';
  const items = extractItemsFromText(text, text);

  let fallbackAction: any = null;
  if (/book/i.test(text)) {
    fallbackAction = { type: 'web_search', label: 'Find this book', query: text };
  } else if (/movie|film|show|watch/i.test(text)) {
    fallbackAction = { type: 'web_search', label: 'Find where to watch', query: text };
  } else if (/restaurant|cafe|bar|dining/i.test(text)) {
    fallbackAction = { type: 'web_search', label: 'Find this restaurant', query: text };
  }

  // Fallback relationship detection (e.g. "Barb is my wife", "Steve is my plumber", "Steve isn't my plumber anymore")
  const relationships: Array<{ person: string; role: string; is_active: boolean }> = [];
  const relNegMatch = text.match(/\b([A-Z][a-zA-Z]+)\s+(?:isn't|is\s+not|is\s+no\s+longer)\s+(?:my|our)\s+([a-zA-Z\s]+?)(?:\s+anymore|[.,]|$)/i);
  if (relNegMatch) {
    relationships.push({
      person: relNegMatch[1].trim(),
      role: relNegMatch[2].trim(),
      is_active: false,
    });
  } else {
    const relPosMatch = text.match(/\b([A-Z][a-zA-Z]+)\s+is\s+(?:my|our)\s+([a-zA-Z\s]+?)(?:[.,]|$)/i);
    if (relPosMatch) {
      relationships.push({
        person: relPosMatch[1].trim(),
        role: relPosMatch[2].trim(),
        is_active: true,
      });
    }
  }

  return {
    content: text.length > 120 ? text.slice(0, 117) + '...' : text,
    kind,
    intent,
    status: 'active',
    people: relationships.map(r => r.person),
    places: [],
    topics: words.slice(0, 3).map(w => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()).filter(Boolean),
    contexts: ['general', 'reference'],
    retrieval_cues: words.slice(0, 5),
    items,
    relationships,
    prerequisite: null,
    original_time_expression: triggerTime ? text : null,
    resolved_datetime: triggerTime,
    event_time_expression: null,
    event_datetime: null,
    reminder_time_expression: triggerTime ? text : null,
    reminder_datetime: triggerTime,
    resurfacing: {
      mode: triggerTime ? 'date_based' : 'contextual',
      timing: triggerTime ? text : 'Contextual / On retrieval',
    },
    suggested_action: fallbackAction,
  };
}

// Interprets a single split memory unit using the production classification and extraction pipeline
export async function interpretSingleMemoryUnit(
  unitText: string,
  fullOriginalText: string,
  localContext: { localDateTimeStr: string; timeZone: string; language: string; region: string; offsetStr: string; utcIso: string; referenceDate: Date },
  ai: GoogleGenAI | null,
  subject?: string | null
): Promise<any> {
  let structuredData: any = null;

  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: `Reference Context for Date/Time & I18n Normalisation:
- User Local Date & Time: ${localContext.localDateTimeStr}
- User TimeZone: ${localContext.timeZone}
- User Language (BCP-47): ${localContext.language}
- User Operating Country/Region: ${localContext.region}
- User Local ISO Offset: ${localContext.offsetStr}
- Current UTC Reference: ${localContext.utcIso}${subject && subject.trim() ? `\n- Active Shared Subject / Topic Context: "${subject.trim()}"` : ''}

Analyze and interpret this memory unit:
"${unitText}"`,
        config: {
          systemInstruction: `You are Ezzymigo, an intention memory and retrieval classification engine.
Your purpose: Classify each newly captured intention according to the circumstances in which the user is most likely to want it surfaced again, not merely literal wording.

1. TOTAL INFORMATION & FACT PRESERVATION (MANDATORY):
- "content" MUST be a cleaned, normalized, and faithful representation of the complete memory unit. Correct spelling, grammar, punctuation, and transcription errors, but NEVER silently drop or omit any secondary clauses, facts, persons, places, commitments, third-party decisions, quantities, or dates.
  * Example: "I bort 6 lenghts of timber from bunings for the pergoal and steve sed hell bring the rest wensday" -> content: "Bought 6 lengths of timber from Bunnings for the pergola, and Steve said he'll bring the rest on Wednesday"
- Entity & Temporal Extraction: Extract ALL mentioned people into "people", places into "places", and explicit dates/times into "original_time_expression" and "event_time_expression".

2. LANGUAGE & LOCALE SENSITIVITY:
- User Configuration: Language: ${localContext.language}, Operating Region: ${localContext.region}, Timezone: ${localContext.timeZone}.
- Preserve the user's original language for "content", "retrieval_cues", "contexts", "topics", "people", and "places". Do NOT translate captured memories into English.
- Numeric Dates: Interpret strictly by region and locale conventions (e.g. 3/9/2026 is 3 September 2026 in DMY regions [AU, GB, NZ, EU], and March 9, 2026 in US [en-US]).

3. ACTIVE SHARED SUBJECT / LIST CONTEXT:
- When an Active Shared Subject / Topic Context is provided (e.g. "Mum's Sold Items", "10 Melville Place"):
  * Interpret items within that domain (e.g. under "Mum's Sold Items", "Ruler $20" is an inventory/pricing note with kind: "fact", intent: "note", NOT a shopping reminder).
  * Maintain the user's exact captured wording in "content" and "originalText"—do NOT prepend the subject into the text.

4. CANONICAL CLASSIFICATION (kind & intent):
- Actionable User Intentions (kind: "reminder"):
  * If the thought represents something the USER intends or needs to do, buy, contact, arrange, or complete, classify as "reminder" (intent: "task", "purchase", "contact", "appointment", "follow-up").
  * Timing is Orthogonal: Actionable intentions are ALWAYS kind: "reminder" whether timed ("Buy milk tomorrow at 9am" -> date_based) or untimed ("Buy milk", "Book dentist" -> contextual, all date/time fields null).
- Information, Notes & Third-Party Statements (kind: "fact"):
  * Knowledge, observations, relationships/roles, preferences, reference facts, or completed events -> kind: "fact" (intent: "fact" or "note").
  * Third-Party Commitments: If a future event is committed or stated by a third party (e.g. "Mum needs new shoes and Barb said she'll take her shopping Friday"), set kind: "fact", intent: "fact" or "note", populate "original_time_expression" and "event_time_expression" with the date/time, set "resurfacing.mode" to "date_based", but keep "reminder_time_expression" and "reminder_datetime" null.
- Uncertain State (kind: "not_sure", intent: "not_sure"):
  * Reserved strictly for captures lacking an identifiable referent or coherent meaning (e.g. "This is going nowhere", "What even was that"). Understandable statements ("My foot hurts", "I like cheese") are "fact". Set resurfacing.mode: "none", timing: "Uncertain".

5. TEMPORAL RESOLUTION & AMBIGUITY RULES:
- Explicit Temporal Isolation: "original_time_expression" MUST ONLY contain explicit temporal wording from THIS specific unit. If no temporal wording was supplied, all date/time fields MUST be null.
- Permanent Absolute Anchoring: Resolve relative expressions ("tomorrow", "next Tuesday", "in September") once at capture into permanent absolute ISO-8601 timestamps using Reference Context (${localContext.localDateTimeStr}, ${localContext.timeZone}, ${localContext.offsetStr}). Never create floating recurrences unless explicitly stated ("every Monday").
- Standard Period Hours: Month-only / Morning = 09:00:00, Afternoon = 14:00:00 (or 16:00 if late), Evening = 18:00:00, Night = 21:00:00.
- Unambiguous Dayparts & 24h: 24h notation ("16:00", "16h") and dayparts in any language ("4 in the afternoon", "4 de l'après-midi", "4 de la tarde", "nachmittags", "8 tonight") uniquely identify time of day and MUST resolve directly without clarification.
- Bare Clock Ambiguity: Bare 1-12 clock times without AM/PM, 24h notation, or daypart qualifiers ("at 4", "4 o'clock", "tomorrow at 7") are AMBIGUOUS. Set resolved_datetime and reminder_datetime to null.

6. CONTEXTS & RETRIEVAL CUES (MANDATORY):
- "contexts": 1 to 5 relevant life domains or circumstances (e.g. ["home maintenance", "shopping", "family"]). Never return an empty array [].
- "retrieval_cues": 3 to 8 search queries, alternate keywords, or retrieval questions in the memory's language. Never return an empty array [].

7. RELATIONSHIPS / ROLES:
- When the user mentions a relationship or role (e.g. "Barb is my wife", "Steve is no longer my plumber"), extract into "relationships": { person, role, is_active: true/false }. Otherwise return [].

8. STRUCTURED ITEMS / COLLECTIONS:
- When the memory is a list, recipe, or multi-item collection under a shared purpose, extract discrete items into "items" array and concise summary into "content". Otherwise return [].

9. PREREQUISITES & DEPENDENT ACTIONS:
- If an action has a blocker/prerequisite (e.g. "Paint the fence after Steve repairs the gate on Monday"), extract prerequisite: { condition, status: "pending", expected_time_expression, expected_datetime }. Prerequisite time belongs to prerequisite; top-level time belongs only to the user's main action.

10. CONTEXTUAL SUGGESTED ACTIONS (EXTERNAL SEARCH LOOKUP ONLY):
- Generate "suggested_action" ONLY for external lookup entities: Books ("Find this book"), Movies/Shows ("Find where to watch"), Restaurants ("Find this restaurant"), Events ("Find tickets"), Places ("Look this up"), Services ("Find options").
- STRICT PRODUCT & SHOPPING EXCLUSION: NEVER generate a suggested search action for consumer products, shopping, tools, or merchandise (e.g. "Makita drill", "groceries", "lawn mower").

11. STRICT STRUCTURED OUTPUT: Produce strictly valid structured JSON matching the schema.`,
          responseMimeType: 'application/json',
          responseSchema: memoriesResponseSchema,
        },
      });

      if (response.text) {
        structuredData = JSON.parse(response.text);
      }
    } catch (err: any) {
      console.error('Error generating structured memory with Gemini:', err?.message || err);
    }
  }

  let item: any;
  if (Array.isArray(structuredData)) {
    item = structuredData[0];
  } else if (structuredData && Array.isArray(structuredData.memories) && structuredData.memories.length > 0) {
    item = structuredData.memories[0];
  } else if (structuredData && typeof structuredData === 'object' && structuredData.content) {
    item = structuredData;
  } else {
    item = fallbackInterpretation(unitText, localContext.referenceDate);
  }

  // Validate that original_time_expression only captures explicit user temporal wording in this specific unit
  let cleanOriginalTime = typeof item.original_time_expression === 'string' && item.original_time_expression.trim()
    ? item.original_time_expression.trim()
    : null;

  if (cleanOriginalTime) {
    const isExplicitInText = unitText.toLowerCase().includes(cleanOriginalTime.toLowerCase()) ||
      (typeof item.content === 'string' && item.content.toLowerCase().includes(cleanOriginalTime.toLowerCase())) ||
      (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(cleanOriginalTime) &&
       /\b(mon|tue|tues|wed|wensday|wens|thu|thur|thurs|fri|sat|sun)\b/i.test(unitText));
    const isSituationalClause = /^(when|if|whenever|in case)\s+/i.test(cleanOriginalTime) &&
      !/\b(\d+|today|tomorrow|yesterday|morning|afternoon|evening|night|am|pm|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|minute|hour|sec|o'clock|breakfast|lunch|dinner|tea|supper|work|school|bed|nap|eating|food)\b/i.test(cleanOriginalTime);
    if (!isExplicitInText || isSituationalClause) {
      cleanOriginalTime = null;
    }
  }

  let resolvedDatetime: string | null = cleanOriginalTime ? (item.resolved_datetime || null) : null;
  let reminderDatetime: string | null = cleanOriginalTime ? (item.reminder_datetime || null) : null;
  let eventDatetime: string | null = cleanOriginalTime ? (item.event_datetime || null) : null;

  // Check for clock time ambiguity across languages (e.g. "at 4", "4 o'clock", "Monday at 7", "tomorrow at 4", "à 4h", "um 7")
  const clockAmbiguity = detectClockTimeAmbiguity(
    unitText,
    cleanOriginalTime || item.resurfacing?.timing,
    localContext.referenceDate,
    localContext.timeZone,
    localContext.offsetStr,
    localContext.language
  );

  if (clockAmbiguity.isAmbiguous) {
    // Ambiguity Rule: Bare clock times requiring exact notifications MUST NOT silently guess AM or PM.
    resolvedDatetime = null;
    reminderDatetime = null;
    eventDatetime = null;
    item.temporal_ambiguity = clockAmbiguity;
    if (!cleanOriginalTime) {
      cleanOriginalTime = clockAmbiguity.timeExpr || null;
    }
    if (!item.kind || item.kind === 'fact' || item.kind === 'thought') {
      item.kind = 'reminder';
    }
  } else if (clockAmbiguity.dayPart) {
    // Explicit daypart qualifier (e.g. "4 in the afternoon", "7 in the morning", "8 tonight") or explicit time
    const hourMatch = unitText.match(/\b(\d{1,2})(?::(\d{2}))?\b/);
    if (hourMatch) {
      const rawH = parseInt(hourMatch[1], 10);
      const rawM = hourMatch[2] ? parseInt(hourMatch[2], 10) : 0;
      if (rawH >= 1 && rawH <= 12) {
        let finalH = rawH;
        if (clockAmbiguity.dayPart === 'pm' && finalH < 12) {
          finalH += 12;
        } else if (clockAmbiguity.dayPart === 'am' && finalH === 12) {
          finalH = 0;
        }
        let targetYmd = getYMDInTz(localContext.referenceDate, localContext.timeZone);
        if (unitText.toLowerCase().includes('tomorrow')) {
          const tom = new Date(localContext.referenceDate.getTime() + 24 * 60 * 60 * 1000);
          targetYmd = getYMDInTz(tom, localContext.timeZone);
        }
        const iso = `${targetYmd}T${String(finalH).padStart(2, '0')}:${String(rawM).padStart(2, '0')}:00${localContext.offsetStr}`;
        if (!isNaN(new Date(iso).getTime())) {
          if (!resolvedDatetime) resolvedDatetime = iso;
          if (!reminderDatetime) reminderDatetime = iso;
          if (!cleanOriginalTime) cleanOriginalTime = hourMatch[0];
          if (!item.kind || item.kind === 'fact' || item.kind === 'thought') {
            item.kind = 'reminder';
          }
        }
      }
    }
  }

  // Deterministic fallback for standalone clock times in unit text (e.g. "at 5:51am", "ring Peter at 5:51am", "at 3pm", "16:00")
  if (!clockAmbiguity.isAmbiguous && (!cleanOriginalTime || !reminderDatetime)) {
    const clockMatch = unitText.match(/(?:at\s+|@\s*)?(\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b)/i) ||
                       (typeof item.resurfacing?.timing === 'string' ? item.resurfacing.timing.match(/(\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:[01]?\d|2[0-3]):[0-5]\d\b)/i) : null);
    if (clockMatch) {
      const explicitTimeExpr = clockMatch[1].trim();
      const parsedHM = parseTimeStringToHM(explicitTimeExpr);
      if (parsedHM) {
        let targetYmd = getYMDInTz(localContext.referenceDate, localContext.timeZone);
        if (unitText.toLowerCase().includes('tomorrow')) {
          const tom = new Date(localContext.referenceDate.getTime() + 24 * 60 * 60 * 1000);
          targetYmd = getYMDInTz(tom, localContext.timeZone);
        }
        const iso = `${targetYmd}T${String(parsedHM.hour).padStart(2, '0')}:${String(parsedHM.minute).padStart(2, '0')}:00${localContext.offsetStr}`;
        if (!isNaN(new Date(iso).getTime())) {
          cleanOriginalTime = explicitTimeExpr;
          if (!resolvedDatetime) resolvedDatetime = iso;
          if (!reminderDatetime) reminderDatetime = iso;
          if (!item.kind || item.kind === 'fact' || item.kind === 'thought') {
            item.kind = 'reminder';
          }
        }
      }
    }
  }

  // Deterministic fallback for relative duration offsets (e.g. "in 10 minutes", "in 2 hours")
  if (!clockAmbiguity.isAmbiguous && (!cleanOriginalTime || !reminderDatetime)) {
    const triggerIso = parseReminderTriggerTime(unitText, item.resurfacing?.timing || '', localContext.referenceDate);
    if (triggerIso) {
      if (!resolvedDatetime) resolvedDatetime = triggerIso;
      if (!reminderDatetime) reminderDatetime = triggerIso;
      if (!cleanOriginalTime) {
        const relMatch = unitText.match(/\bin\s+\d+\s*(?:minutes?|mins?|min|m|hours?|hrs?|hr|h|seconds?|secs?|s|days?|d)\b/i);
        cleanOriginalTime = relMatch ? relMatch[0].trim() : (item.resurfacing?.timing || 'in 10 minutes');
      }
      if (!item.kind || item.kind === 'fact' || item.kind === 'thought') {
        item.kind = 'reminder';
      }
    }
  }

  // Ensure contexts is never empty
  let contexts = Array.isArray(item.contexts) ? item.contexts.filter((c: any) => typeof c === 'string' && c.trim()) : [];
  if (contexts.length === 0) {
    const fallbackContexts = ['reference', 'general'];
    if (item.intent && typeof item.intent === 'string') fallbackContexts.unshift(item.intent);
    contexts = Array.from(new Set(fallbackContexts));
  }

  // Ensure retrieval_cues is never empty
  let retrievalCues = Array.isArray(item.retrieval_cues) ? item.retrieval_cues.filter((c: any) => typeof c === 'string' && c.trim()) : [];
  if (retrievalCues.length === 0) {
    const words = unitText.split(/\s+/).map((w: string) => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()).filter((w: string) => w.length > 2);
    retrievalCues = Array.from(new Set([item.content || unitText, ...(Array.isArray(item.topics) ? item.topics : []), ...words])).slice(0, 6);
  }

  let itemRelationships = Array.isArray(item.relationships)
    ? item.relationships.filter((r: any) => r && typeof r.person === 'string' && typeof r.role === 'string' && r.person.trim() && r.role.trim())
    : [];

  if (itemRelationships.length === 0) {
    const relNegMatch = unitText.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:isn't|is\s+not|is\s+no\s+longer)\s+(?:my|our|the)\s+([a-zA-Z\s]+?)(?:\s+anymore|[.,]|$)/i);
    if (relNegMatch) {
      itemRelationships.push({
        person: relNegMatch[1].trim(),
        role: relNegMatch[2].trim(),
        is_active: false,
      });
    } else {
      const relPosMatch = unitText.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+is\s+(?:my|our|the)\s+([a-zA-Z\s]+?)(?:[.,]|$)/i);
      if (relPosMatch) {
        itemRelationships.push({
          person: relPosMatch[1].trim(),
          role: relPosMatch[2].trim(),
          is_active: true,
        });
      }
    }
  }

  let peopleList = Array.isArray(item.people) ? [...item.people] : [];
  for (const rel of itemRelationships) {
    if (rel.person && !peopleList.some((p: string) => p.toLowerCase() === rel.person.toLowerCase())) {
      peopleList.push(rel.person);
    }
  }

  let itemsList: string[] = [];
  if (Array.isArray(item.items) && item.items.length > 0) {
    itemsList = item.items.filter((i: any) => typeof i === 'string' && i.trim()).map((i: string) => i.trim());
  } else {
    itemsList = extractItemsFromText(item.content || unitText, fullOriginalText);
  }

  let canonicalKind = item.kind ? String(item.kind).trim().toLowerCase() : 'fact';
  if (canonicalKind === 'task') {
    canonicalKind = 'reminder';
  } else if (canonicalKind !== 'reminder' && canonicalKind !== 'fact' && canonicalKind !== 'not_sure') {
    canonicalKind = (resolvedDatetime || item.intent === 'task' || item.intent === 'purchase' || item.intent === 'contact') ? 'reminder' : 'fact';
  }

  const canonicalIntent = item.intent || (canonicalKind === 'reminder' ? 'task' : canonicalKind === 'not_sure' ? 'not_sure' : 'remember');

  let prerequisiteObj = (item.prerequisite && typeof item.prerequisite === 'object' && item.prerequisite.condition)
    ? {
        condition: String(item.prerequisite.condition).trim(),
        status: item.prerequisite.status || 'pending',
        expected_time_expression: item.prerequisite.expected_time_expression || null,
        expected_datetime: item.prerequisite.expected_datetime || null,
      }
    : null;

  if (!prerequisiteObj) {
    const untilMatch = unitText.match(/\buntil\s+([A-Z][a-zA-Z0-9\s]+?)(?:\s+on\s+([a-zA-Z]+))?[.!]?$/i);
    if (untilMatch) {
      prerequisiteObj = {
        condition: untilMatch[1].trim(),
        status: 'pending',
        expected_time_expression: untilMatch[2] ? untilMatch[2].trim() : null,
        expected_datetime: null,
      };
    }
  }

  return {
    content: item.content || unitText,
    kind: canonicalKind,
    intent: canonicalIntent,
    status: item.status || 'active',
    people: peopleList,
    places: Array.isArray(item.places) ? item.places : [],
    topics: Array.isArray(item.topics) ? item.topics : [],
    contexts,
    retrieval_cues: retrievalCues,
    items: itemsList,
    relationships: itemRelationships,
    prerequisite: prerequisiteObj,
    original_time_expression: cleanOriginalTime,
    resolved_datetime: resolvedDatetime,
    event_time_expression: cleanOriginalTime ? (item.event_time_expression || null) : null,
    event_datetime: eventDatetime,
    reminder_time_expression: cleanOriginalTime ? (item.reminder_time_expression || null) : null,
    reminder_datetime: reminderDatetime,
    resurfacing: {
      mode: item.resurfacing?.mode || (resolvedDatetime ? 'date_based' : 'contextual'),
      timing: item.resurfacing?.timing || cleanOriginalTime || 'Contextual / On retrieval',
    },
    temporal_ambiguity: item.temporal_ambiguity || null,
    suggested_action: (item.suggested_action && typeof item.suggested_action === 'object' && item.suggested_action.label && item.suggested_action.query && !isProductOrShoppingSuggestedAction(item.suggested_action))
      ? {
          type: item.suggested_action.type || 'web_search',
          label: item.suggested_action.label,
          query: item.suggested_action.query,
        }
      : null,
  };
}

/**
 * Shared capture interpretation pipeline:
 * Executes STAGE 1 (Dedicated Splitter) and STAGE 2 (Independent Unit Interpretation)
 * using the production Gemini pipeline, returning structured memory objects without database writes.
 */
export async function processThoughtCapturePipeline(
  trimmedText: string,
  localContext: any,
  ai: any,
  linkedEventId?: string | null,
  subject?: string | null
): Promise<{ splitUnits: string[]; memories: any[] }> {
  // STAGE 1: Dedicated Splitter Stage
  // Divides the original capture into the smallest meaningful independent memory units
  const splitUnits = await splitCaptureIntoUnits(trimmedText, ai, localContext);

  // STAGE 2: Independent Interpretation Pipeline
  // Each resulting unit passes independently through the existing interpretation pipeline
  const now = new Date().toISOString();

  const interpretationPromises = splitUnits.map((unitText) =>
    interpretSingleMemoryUnit(unitText, unitText, localContext, ai, subject)
  );

  const interpretations = await Promise.all(interpretationPromises);

  // Assemble memory items, preserving discrete unit originalText
  const memories = interpretations.map((interpretation, index) => {
    const unitText = splitUnits[index] || trimmedText;
    if (subject && typeof subject === 'string' && subject.trim()) {
      const cleanSubject = subject.trim();
      interpretation.subject = cleanSubject;
      if (!Array.isArray(interpretation.retrieval_cues)) {
        interpretation.retrieval_cues = [];
      }
      if (!interpretation.retrieval_cues.includes(cleanSubject)) {
        interpretation.retrieval_cues.push(cleanSubject);
      }
    }
    if (linkedEventId) {
      interpretation.linked_event_id = String(linkedEventId);
      if (!Array.isArray(interpretation.contexts)) {
        interpretation.contexts = [];
      }
      if (!interpretation.contexts.includes('appointment')) {
        interpretation.contexts.push('appointment');
      }
    }
    return {
      id: `mem_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 9)}`,
      originalText: unitText, // Unit-specific original text matching user's wording for this unit
      createdAt: now,
      isDone: false,
      interpretation,
    };
  });

  return { splitUnits, memories };
}

import { GoogleGenAI } from '@google/genai';
import { splitterResponseSchema } from './schemas';

// Checks if a unit is a dependent clause that merely modifies an intention by providing reminder/timing/metadata without an independent action or object.
export function isDependentReminderClause(unitText: string): boolean {
  const trimmed = unitText.trim().replace(/^[,.;\-–—\s]+|[,.;\-–—\s]+$/g, '');
  const lower = trimmed.toLowerCase();
  if (!lower) return true;

  // Standalone pure temporal expressions pattern:
  // e.g. "at 10:30am", "at 9am", "10:30am", "at 7", "at 1pm", "Saturday morning", "tomorrow morning", "in September", "a week beforehand", "tonight", "tomorrow", "for 5pm", "on Saturday", "in 10 minutes"
  const temporalOnlyPattern = /^(?:at|on|in|for|by|around|about|before|after|a|an)?\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|tomorrow(?:\s+morning|\s+afternoon|\s+evening|\s+night)?|today(?:\s+morning|\s+afternoon|\s+evening|\s+night)?|tonight|yesterday|this\s+(?:morning|afternoon|evening|night|weekend|week|month)|next\s+(?:week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|saturday(?:\s+morning|\s+afternoon|\s+evening|\s+night)?|sunday(?:\s+morning|\s+afternoon|\s+evening|\s+night)?|monday(?:\s+morning|\s+afternoon|\s+evening|\s+night)?|tuesday(?:\s+morning|\s+afternoon|\s+evening|\s+night)?|wednesday(?:\s+morning|\s+afternoon|\s+evening|\s+night)?|thursday(?:\s+morning|\s+afternoon|\s+evening|\s+night)?|friday(?:\s+morning|\s+afternoon|\s+evening|\s+night)?|january|february|march|april|may|june|july|august|september|october|november|december|week\s+beforehand|day\s+beforehand|days?\s+beforehand|weeks?\s+beforehand|\d+\s*(?:mins?|minutes?|hours?|days?|weeks?|months?)(?:\s+(?:beforehand|earlier|before|later|time))?)[.,!?;:]*$/i;

  if (temporalOnlyPattern.test(lower)) {
    return true;
  }

  // Pattern: "Remind me at 10:30am", "Give me a reminder at 7", "Oh, remind me Saturday morning", "Remind me in 10 minutes", "Set a reminder for tomorrow", "Remind me a week beforehand"
  // Contrast with: "Remind me to ring Peter at 10:30am", "Remind me to buy milk", "Remind Peter to call" which have an independent action/object following "to" or a person.
  const reminderPrefixRegex = /^(?:oh,?\s+|and\s+|also\s+)?(?:remind\s+me|give\s+me\s+a\s+reminder|send\s+me\s+a\s+reminder|set\s+a\s+reminder|make\s+a\s+reminder|reminder)\b/i;
  if (reminderPrefixRegex.test(lower)) {
    const afterReminder = lower.replace(reminderPrefixRegex, '').trim();

    // If afterReminder starts with "to [action]" e.g. "to ring Peter", "to buy flowers", "to pay the bill", it is INDEPENDENT
    if (/^to\s+[a-z]+/i.test(afterReminder)) {
      return false;
    }

    // If what follows consists solely of temporal / reminder timing / prepositions / punctuation
    if (temporalOnlyPattern.test(afterReminder) || afterReminder.length === 0) {
      return true;
    }

    // Fallback check: If afterReminder doesn't contain a verb/action (e.g. just time words)
    const containsActionVerb = /\b(pick up|call|ring|phone|buy|get|pay|clean|send|email|meet|visit|check|take|put|ask|tell|write|bring|drive|order|book|fix|repair|return)\b/i.test(afterReminder);
    if (!containsActionVerb) {
      return true;
    }
  }

  return false;
}

// Absorbs dependent reminder/temporal clauses into the previous independent intention unit
export function applyDependentClauseRule(units: string[]): string[] {
  if (units.length <= 1) return units;

  const mergedUnits: string[] = [];

  for (let i = 0; i < units.length; i++) {
    const currentUnit = units[i].trim();
    if (isDependentReminderClause(currentUnit) && mergedUnits.length > 0) {
      // Merge into the previous intention unit
      const prev = mergedUnits[mergedUnits.length - 1];
      const punctuation = /[.!?]$/.test(prev) ? ' ' : '. ';
      mergedUnits[mergedUnits.length - 1] = `${prev}${punctuation}${currentUnit}`;
      console.log(`[Dependent Clause Rule] Absorbed dependent clause "${currentUnit}" into previous intention: "${mergedUnits[mergedUnits.length - 1]}"`);
    } else {
      mergedUnits.push(currentUnit);
    }
  }

  return mergedUnits;
}

// Checks if a unit is a list/collection continuation of a previous collection header/item
export function isCollectionContinuation(unitText: string, prevUnit: string): boolean {
  const trimmed = unitText.trim();
  const lower = trimmed.toLowerCase();
  const prevLower = prevUnit.toLowerCase();

  // If previous unit sets up a list, recipe, shopping collection, or ends with a colon
  const isPrevCollectionHeader = /^(these are the |here are the |things to |items to |list of |ingredients |recipe |pack for |take to |bring to |get the following|shopping list|groceries|supplies for|buy from \w+:|for the \w+:|the filling:)/i.test(prevLower) ||
    /:\s*$/i.test(prevUnit.trim()) ||
    /\b(ingredients|recipe|shopping list|pack for|things to take|things to bring|items for)\b/i.test(prevLower);

  // If current unit is a continuation clause (e.g. "The filling: ...", "Breast meat...", "Mature cheddar...", "cardigan, paperwork and slippers", "potting mix, 3 terracotta pots...")
  const isListItemPattern = /^[-•*–—\d.)\s]*(?:the filling:|filling:|pastry|mushrooms|breast meat|chicken|cheddar|mature cheddar|cheese|cardigan|paperwork|slippers|passport|charger|medication|sunglasses|potting mix|milk|bread|eggs|butter|\d+\s*(?:g|oz|kg|ml|roll|rolls|bunch|bunches|tins?|cans?|packs?|bottles?|loaves|litres?|grams?|cups?|tbsp|tsp)\b)/i.test(lower);

  // Verbs that signal an entirely separate new user job/intention
  const containsIndependentJobVerb = /\b(ring|call|phone|email|book|schedule|meet|visit|pay bill|clean the|fix the|repair|drive to)\b/i.test(lower);

  if (isPrevCollectionHeader && (!containsIndependentJobVerb || isListItemPattern)) {
    return true;
  }

  return false;
}

// Merges split list/ingredient/collection fragments into one parent memory unit
export function applyCollectionListRule(units: string[]): string[] {
  if (units.length <= 1) return units;
  const mergedUnits: string[] = [];

  for (let i = 0; i < units.length; i++) {
    const currentUnit = units[i].trim();
    if (mergedUnits.length > 0 && isCollectionContinuation(currentUnit, mergedUnits[mergedUnits.length - 1])) {
      const prev = mergedUnits[mergedUnits.length - 1];
      const punctuation = /[:]$/.test(prev) ? ' ' : /[.!?]$/.test(prev) ? ' ' : '. ';
      mergedUnits[mergedUnits.length - 1] = `${prev}${punctuation}${currentUnit}`;
      console.log(`[Collection List Rule] Merged list item "${currentUnit}" into collection intention: "${mergedUnits[mergedUnits.length - 1]}"`);
    } else {
      mergedUnits.push(currentUnit);
    }
  }

  return mergedUnits;
}

// Phase B: Conservative deterministic fast-path classifier for V1
export function isEligibleForSplitterFastPath(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();

  // 1. Length bounds: 8 to 220 characters
  if (trimmed.length < 8 || trimmed.length > 220) return false;

  // 2. Standard Latin / ASCII characters only in V1 (foreign scripts & non-ASCII fall back to Gemini)
  if (!/^[\x20-\x7E’'“”"–—]+$/.test(trimmed)) return false;

  // 3. No newlines
  if (/[\r\n]/.test(trimmed)) return false;

  // 4. No semicolons
  if (trimmed.includes(';')) return false;

  // 5. No colons, except standard time formats like 2:30pm or 10:30
  const withoutTimes = trimmed.replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm))?\b/gi, '');
  if (withoutTimes.includes(':')) return false;

  // 6. No list or bullet markers
  if (/^[-*•]\s+/m.test(trimmed) || /\s+[-*•]\s+/.test(trimmed) || /\b\d+[.)]\s+/.test(trimmed)) return false;

  // 7. At most 1 comma
  const commaCount = (trimmed.match(/,/g) || []).length;
  if (commaCount > 1) return false;

  // 8. Single sentence: no interior sentence terminators
  const strippedEndPunct = trimmed.replace(/[.!?]+$/, '').trim();
  if (/[.!?](?:\s+\S|[A-Z])/.test(strippedEndPunct)) return false;

  // 9. No additive or chaining transition words
  if (/\b(also|additionally|plus|as well as|oh and|on top of that|by the way|meanwhile|separately|then|because)\b/i.test(trimmed)) {
    return false;
  }

  // 10. Conservative Conjunction Gate: no 'and', 'but', or non-English coordinating conjunctions
  // Exception: clean 'between X and Y' range
  if (/\b(and|but|et|mais|y|pero|und|aber)\b/i.test(trimmed)) {
    const isCleanBetweenAnd = /^\s*between\s+\S+\s+and\s+\S+(?:\s+.*)?$/i.test(trimmed);
    const andMatches = trimmed.match(/\band\b/gi) || [];
    if (!isCleanBetweenAnd || andMatches.length > 1) {
      return false;
    }
  }

  // 11. Punctuation-free voice stream guard: if zero punctuation, limit to <= 12 words
  const hasPunctuation = /[.,!?;:'"’“”\-–—]/.test(trimmed);
  if (!hasPunctuation) {
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length > 12) return false;
  }

  return true;
}

// Dedicated Splitter: Divides raw user capture into distinct independent intentions and coherent context units
export async function splitCaptureIntoUnits(
  text: string,
  ai: GoogleGenAI | null,
  localContext?: { localDateTimeStr: string; timeZone: string; language: string; region: string }
): Promise<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Phase B: Conservative deterministic fast path
  if (isEligibleForSplitterFastPath(trimmed)) {
    console.log(`[Splitter Fast Path] Bypassed Gemini Splitter (0ms) for coherent single memory: "${trimmed}"`);
    return [trimmed];
  }

  if (!ai) {
    return [trimmed];
  }

  console.log(`[Gemini Splitter] Calling Gemini Splitter for multi-intention/complex capture: "${trimmed}"`);

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: `User capture:
"${trimmed}"`,
      config: {
        systemInstruction: `You are the Dedicated Memory Capture Splitter for Ezzymigo.
Your ONLY responsibility is to divide a user's capture into distinct independent intentions and coherent context units (facts, intentions, tasks, appointments, reminders, purchases, ideas, or observations).

GOVERNING PRINCIPLES & RULES:

1. SINGLE INTENTION / COHERENT CONTEXT:
   If the capture describes a single intention, task, or coherent situation/event, return an array with just that 1 unit unchanged.

2. COHERENT CONTEXT & INCIDENT INTEGRITY RULE (CRITICAL):
   - Supporting clauses MUST remain together in ONE memory when they describe the same identifiable event, interaction, subject, or situation.
   - Do NOT split merely because there are multiple sentences, clauses, or facts if subsequent clauses provide:
     * consequences, outcomes, or results;
     * explanations or reasons;
     * qualifications or conditions;
     * status updates or current state;
     * pronoun/coreference continuations referring to the same subject (e.g. he, she, they, it);
     * actions/decisions being taken by involved parties as a direct consequence of that same incident.
   - Examples of Coherent Situations that MUST remain ONE memory:
     * "Mum had a fall last night at Amala. Not hurt, but they're doing a risk assessment." -> Return 1 unit: ["Mum had a fall last night at Amala. Not hurt, but they're doing a risk assessment."]
     * "Mum had a fall last night. She's okay but the home is doing a risk assessment." -> Return 1 unit: ["Mum had a fall last night. She's okay but the home is doing a risk assessment."]
     * "The plumber came today. He couldn't fix the tap because he needs a new cartridge. He's coming back Friday." -> Return 1 unit: ["The plumber came today. He couldn't fix the tap because he needs a new cartridge. He's coming back Friday."]
     * "I spoke to Peter. He wants his ladder back and said he'll collect it Saturday." -> Return 1 unit: ["I spoke to Peter. He wants his ladder back and said he'll collect it Saturday."]
     * "The car is making a strange rattling noise when I accelerate. Booked it in for service next Tuesday." -> Return 1 unit

3. GENUINE INDEPENDENT INTENTIONS (MUST SPLIT):
   - When a capture contains multiple distinct, unrelated intentions, jobs, or distinct thoughts that do NOT describe the same coherent incident/action, divide them into discrete standalone units.
   - Pronoun continuity alone (e.g. 'he', 'she', 'they', 'him') must NOT mechanically force merging when a clause introduces an independent new job or timed reminder:
     * "I spoke to Peter. He wants his ladder back. Remind me to ring him tomorrow." -> Return 2 units: ["I spoke to Peter. He wants his ladder back.", "Remind me to ring him tomorrow."]
     * "Mum had a fall last night but she's okay. Ring Peter tomorrow at 10am." -> Return 2 units: ["Mum had a fall last night but she's okay.", "Ring Peter tomorrow at 10am."]
     * "Mum had a fall last night. She's okay. Buy milk tomorrow." -> Return 2 units: ["Mum had a fall last night. She's okay.", "Buy milk tomorrow."]
     * "The plumber couldn't fix the tap. Buy milk tomorrow. Barb's Pilates is cancelled Friday." -> Return 3 units: ["The plumber couldn't fix the tap.", "Buy milk tomorrow.", "Barb's Pilates is cancelled Friday."]
     * "Get milk tomorrow, ring Peter at 3pm, and book the dentist." -> Return 3 units: ["Get milk tomorrow", "ring Peter at 3pm", "book the dentist."]

4. DEPENDENT CLAUSE & PREREQUISITE RULE (CRITICAL):
   - Do NOT split off a clause that merely modifies an intention by providing reminder timing, date/time, deadline, recurrence, priority, or resurfacing instruction.
   - DEPENDENT INTENTIONS & PREREQUISITES (DO NOT SPLIT):
     When an intention is dependent upon an external condition, prerequisite, or blocker (e.g. "I need to paint the back fence, but I can't do it until Steve repairs the broken gate on Monday", "Call Peter when the quote arrives", "When the parts arrive Friday, ring the mechanic", "After Steve repairs the gate, paint the fence on Tuesday", "Ring the mechanic Friday after the parts arrive"), keep the entire dependent intention together in 1 unit.
   - Examples:
     * "I need to pick-up my Presolol script this morning. Remind me at 10:30am" -> Return 1 unit: ["I need to pick-up my Presolol script this morning. Remind me at 10:30am"]
     * "Ring Peter tomorrow. Remind me at 9am." -> Return 1 unit: ["Ring Peter tomorrow. Remind me at 9am."]
     * "Put the bins out tonight. Give me a reminder at 7." -> Return 1 unit: ["Put the bins out tonight. Give me a reminder at 7."]
     * "Put the bins out today. Remind me at 3:30pm." -> Return 1 unit: ["Put the bins out today. Remind me at 3:30pm."]
     * "Buy flowers for Barb. Oh, remind me Saturday morning." -> Return 1 unit: ["Buy flowers for Barb. Oh, remind me Saturday morning."]
     * "Clean the coffee machine tomorrow. Remind me at 1pm." -> Return 1 unit: ["Clean the coffee machine tomorrow. Remind me at 1pm."]
     * "I need to paint the back fence, but I can't do it until Steve repairs the broken gate on Monday." -> Return 1 unit: ["I need to paint the back fence, but I can't do it until Steve repairs the broken gate on Monday."]
   - BUT IF A CLAUSE CONTAINS AN INDEPENDENT ACTION/OBJECT, KEEP IT AS A SEPARATE UNIT:
     * "Buy flowers for Barb. Also remind me to ring Peter Saturday." -> Return 2 units: ["Buy flowers for Barb.", "Also remind me to ring Peter Saturday."]
     * "Get milk tomorrow and ring Peter at 3pm." -> Return 2 units: ["Get milk tomorrow", "ring Peter at 3pm."]
     * "Remind me to ring Peter at 10:30am" -> Return 1 unit: ["Remind me to ring Peter at 10:30am"]

5. COLLECTION / LIST RULE (CRITICAL):
   - When multiple items belong to one clearly shared purpose, activity, event, recipe, or collection, preserve them as ONE memory, not one memory per item.
   - Determine splitting based on independent actionability, NOT on punctuation, commas, hyphens, colons, bullets, numbers, or line breaks.
   - Examples of Single Intentions containing collections/lists (DO NOT SPLIT):
     * "These are the ingredients I need for a pie recipe, I need to get tomorrow: Pastry - 1 roll of ready made shortcrust pastry - 400g (14.1 oz). The filling: Mushrooms - diced. Breast meat from a small roast chicken 200g (7 oz). Mature cheddar - grated." -> Return 1 unit
     * "Things to take to Mum tomorrow: cardigan, paperwork and slippers." -> Return 1 unit
     * "Ask the doctor about my prescription, blood test and sore knee." -> Return 1 unit
     * "Pack for the trip: passport, charger, medication and sunglasses." -> Return 1 unit
     * "I need milk, bread, eggs and butter from Woolies today." -> Return 1 unit
     * "Items for the garden: potting mix, 3 terracotta pots, tomato seedlings, and fertiliser." -> Return 1 unit

6. PRESERVE ORIGINAL LANGUAGE & WORDS: The user may speak or type in any language. Preserve the user's original words, terminology, phrasing, and language verbatim in each unit. Do NOT translate, Anglicise, or modify the units.
7. Output strictly valid JSON matching the schema with the "units" array.`,
        responseMimeType: 'application/json',
        responseSchema: splitterResponseSchema,
        temperature: 0.1,
      },
    });

    if (response.text) {
      const parsed = JSON.parse(response.text);
      if (Array.isArray(parsed?.units) && parsed.units.length > 0) {
        const cleanedUnits = parsed.units
          .map((u: any) => (typeof u === 'string' ? u.trim() : ''))
          .filter((u: string) => u.length > 0);
        if (cleanedUnits.length > 0) {
          // Apply deterministic Dependent Clause Rule safety layer on the splitter output
          const withDependentClauses = applyDependentClauseRule(cleanedUnits);
          // Apply deterministic Collection/List Rule safety layer on the splitter output
          return applyCollectionListRule(withDependentClauses);
        }
      }
    }
  } catch (err: any) {
    console.error('Error during memory capture splitting stage:', err?.message || err);
  }

  return [trimmed];
}

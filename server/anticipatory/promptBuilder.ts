/**
 * Global Anticipatory Prompt Construction Engine
 *
 * Implements the single global prompt-construction path for PRE and POST anticipatory triggers.
 *
 * Strict Architectural Rules:
 * 1. Identify the event / person / topic.
 * 2. Retrieve ONLY strongly relevant existing memories/reminders linked to that event/person/topic.
 * 3. If useful context exists, mention the single most relevant item briefly.
 * 4. End by asking whether the user wants to add/store anything or create a reminder.
 * 5. Exactly one prompt. Never start an open-ended conversation or ask a sequence of questions.
 * 6. If no useful known context exists, use a simple event-specific prompt rather than inventing context.
 * 7. Reusable for routine visits, appointments, birthdays, and completed phone calls.
 */

export interface AnticipatoryPromptOptions {
  stage: 'PRE' | 'POST';
  title: string;
  eventType?: 'routine' | 'appointment' | 'birthday' | 'call' | 'meeting' | 'generic';
  person?: string;
  temporalDesc?: string; // e.g. "tomorrow", "today", "at 10:30am"
  memories?: any[];
  activeRelationships?: Array<{ person: string; role: string; normalized_role: string }>;
  eventId?: string;
}

export interface AnticipatoryPromptResult {
  prompt: string;
  isAnticipatory: boolean;
  cleanTitle: string;
  person?: string;
  eventType: string;
  contextUsed?: string | null;
  stage: 'PRE' | 'POST';
}

/**
 * 1. Identify event details: title, person, eventType
 */
export function identifyEventDetails(
  title: string,
  providedPerson?: string,
  providedType?: string,
  activeRelationships: Array<{ person: string; role: string; normalized_role: string }> = []
): { cleanTitle: string; person: string; eventType: 'routine' | 'appointment' | 'birthday' | 'call' | 'meeting' | 'generic' } {
  const cleanTitle = (title || '').trim()
    .replace(/\s*(?:—|-|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?\s*$/i, '')
    .trim();

  let person = providedPerson ? providedPerson.trim() : '';
  let eventType: 'routine' | 'appointment' | 'birthday' | 'call' | 'meeting' | 'generic' = providedType as any || 'generic';

  // Check Birthday
  if (/birthday/i.test(cleanTitle) || providedType === 'birthday') {
    eventType = 'birthday';
    if (!person) {
      const bdayMatch = cleanTitle.match(/^([A-Za-z0-9'-]+)(?:['’]s)?\s+birthday/i) ||
                        cleanTitle.match(/birthday\s*(?:-|—|:)?\s*([A-Za-z0-9'-]+)/i);
      if (bdayMatch) {
        person = bdayMatch[1].replace(/['’]s$/i, '').trim();
      }
    }
  }

  // Check Call
  else if (/^(?:phone\s+call|call)\b/i.test(cleanTitle) || providedType === 'call') {
    eventType = 'call';
    if (!person) {
      const callMatch = cleanTitle.match(/^(?:phone\s+call|call)\s+(?:with\s+|to\s+)?([A-Za-z0-9'-]+)/i);
      if (callMatch) {
        person = callMatch[1].trim();
      }
    }
  }

  // Check Visit / Routine with person
  else if (/^(?:visit|visiting|see|seeing)\b/i.test(cleanTitle) || providedType === 'routine') {
    eventType = 'routine';
    if (!person) {
      const visitMatch = cleanTitle.match(/^(?:visit|visiting|see|seeing)\s+(?:with\s+)?([A-Za-z0-9'-]+)/i);
      if (visitMatch) {
        person = visitMatch[1].trim();
      }
    }
  }

  // Check Medical / Doctor / Dentist
  else if (
    /^(?:dr\.?|doctor)\b/i.test(cleanTitle) ||
    /^(?:dentist|physio|physiotherapist|gp|specialist|therapist|optometrist|podiatrist)\b/i.test(cleanTitle) ||
    /\b(?:doctor|dentist|physio|appointment)\b/i.test(cleanTitle) ||
    providedType === 'appointment'
  ) {
    eventType = 'appointment';
    if (!person) {
      const drMatch = cleanTitle.match(/(?:with\s+)?(?:dr\.?|doctor)\s+([A-Za-z0-9'-]+)/i);
      if (drMatch) {
        const candidateName = drMatch[1].trim();
        if (!/^(?:appointment|appt|visit|consultation|checkup|check-up|check|session)\b/i.test(candidateName)) {
          person = `Dr ${candidateName}`;
        }
      } else {
        const withMatch = cleanTitle.match(/\b(?:with|see|seeing)\s+([A-Za-z0-9'-]+)/i);
        if (withMatch) {
          const candidateName = withMatch[1].trim();
          if (!/^(?:the|my|a|an)\b/i.test(candidateName)) {
            person = candidateName;
          }
        }
      }
    }
  }

  // Check Meeting / Social
  else if (/^(?:meeting|sync|catch\s*up|catchup|discussion|lunch|dinner|coffee|breakfast|drinks)\b/i.test(cleanTitle) || providedType === 'meeting') {
    eventType = 'meeting';
    if (!person) {
      const meetMatch = cleanTitle.match(/^(?:meeting|sync|catch\s*up|catchup|discussion|lunch|dinner|coffee|breakfast|drinks)\s+(?:with\s+)?([A-Za-z0-9'-]+)/i);
      if (meetMatch) {
        person = meetMatch[1].trim();
      }
    }
  }

  // Check Father's Day / Mother's Day
  if (/father'?s\s+day/i.test(cleanTitle)) {
    if (!person) person = 'Dad';
  } else if (/mother'?s\s+day/i.test(cleanTitle) || /mothering\s+sunday/i.test(cleanTitle)) {
    if (!person) person = 'Mum';
  }

  // If still no person, check active relationships against cleanTitle
  if (!person) {
    for (const rel of activeRelationships) {
      if (rel.person && new RegExp(`\\b${rel.person}\\b`, 'i').test(cleanTitle)) {
        person = rel.person;
        break;
      }
    }
  }

  return { cleanTitle, person, eventType };
}

/**
 * 2. Retrieve only STRONGLY relevant existing memories/reminders.
 *
 * Strict boundary:
 * - Excludes phone numbers, email, physical addresses
 * - Excludes relationship declarations ("Barb is my wife")
 * - Excludes passive biographical facts ("Mum was born in 1948", "Mum likes red roses")
 * - Excludes completed/done tasks
 * - Requires explicit link OR actionable agenda/discussion intent tied to the person/event
 */
/**
 * Identifies memories created as outcomes/responses to completed reflections or past events.
 * Such memories must NEVER be recycled back into anticipatory preparation for the same or subsequent prompts.
 */
export function isReflectionOutcomeMemory(m: any): boolean {
  if (!m) return false;
  if (m.interpretation?.is_reflection_response || m.is_reflection_response) return true;
  if (m.interpretation?.origin === 'reflection_outcome' || m.interpretation?.origin === 'reflection_response') return true;
  if (m.interpretation?.provenance === 'reflection_response' || m.provenance === 'reflection_response') return true;

  const rawContent = (m.interpretation?.content || m.originalText || '').trim();
  const lowerContent = rawContent.toLowerCase();

  // Declarative past-tense completion/reporting markers (e.g. "I spoke with...", "Doug sent me...", "Went well")
  if (/^(?:i\s+)?(?:spoke|talked|chatted|saw|visited|caught\s+up|went|had|received|got|sent|told|attended)\b/i.test(lowerContent)) {
    return true;
  }

  // Kind is fact or note with past-tense narrative and no future/preparation action verb
  const kind = (m.interpretation?.kind || '').toLowerCase();
  const intent = (m.interpretation?.intent || '').toLowerCase();
  if (['fact', 'note'].includes(kind) || ['fact', 'note'].includes(intent)) {
    if (/\b(?:spoke|talked|visited|sent|received|attended|went|was|were)\b/i.test(lowerContent) &&
        !/\b(?:ask|bring|take|check|renew|discuss|prepare|organise|organize|remind)\b/i.test(lowerContent)) {
      return true;
    }
  }

  return false;
}

export function isStronglyRelevantMemory(
  m: any,
  eventDetails: { cleanTitle: string; person: string; eventType: string },
  eventId?: string
): boolean {
  if (!m) return false;
  if (m.isDone || m.interpretation?.status === 'completed' || m.interpretation?.status === 'dismissed') {
    return false;
  }

  // Defect 2: Memories created as outcomes/responses to a completed reflection
  // must NOT subsequently qualify as preparation context merely because they share linked_event_id.
  if (isReflectionOutcomeMemory(m)) {
    return false;
  }

  // 1. Direct explicit link to event ID (only for genuine preparation memories)
  if (eventId && m.interpretation?.linked_event_id && String(m.interpretation.linked_event_id) === String(eventId)) {
    return true;
  }

  const kind = (m.interpretation?.kind || '').toLowerCase();
  // Exclude static entity relationships, profile details, or general preferences
  if (['relationship', 'profile', 'preference'].includes(kind)) {
    return false;
  }

  const rawContent = (m.interpretation?.content || m.originalText || '').trim();
  const lowerContent = rawContent.toLowerCase();

  // Conservative safety checks:
  // Exclude static contact info (phone numbers, addresses)
  if (/\b(?:phone\s*number|mobile|telephone|\+?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}|email|address|lives\s+at)\b/i.test(lowerContent)) {
    return false;
  }

  // Exclude relationship statements ("X is my doctor", "X is my mother")
  if (/\bis\s+my\s+(?:mum|mother|dad|father|wife|husband|brother|sister|son|daughter|friend|doctor|gp|dentist|physio)\b/i.test(lowerContent)) {
    return false;
  }

  // Exclude passive personal preferences / traits unless accompanied by an action
  if (/\b(?:loves?|likes?|favourite|favorite|born\s+in|years\s+old|age\s+is|allergic\s+to)\b/i.test(lowerContent) &&
      !/\b(?:ask|check|buy|get|bring|discuss|mention)\b/i.test(lowerContent)) {
    return false;
  }

  // Exclude passive facts about expiration/dates without an action verb (e.g. "All my current scripts expire on 18/08/2027")
  if (kind === 'fact' && /\b(?:expires?|expired|expiration)\b/i.test(lowerContent) &&
      !/\b(?:ask|discuss|mention|renew|check|remind)\b/i.test(lowerContent)) {
    return false;
  }

  // Must have an actual action verb (bare nouns like "scripts", "blood test", "scan" are NOT action verbs):
  const hasActionVerb = /\b(?:ask|discuss|mention|check|bring|take|give|tell|show|pick\s*up|buy|get|send|call|order|book|renew|remind|organise|organize|raise|query|follow\s*up)\b/i.test(lowerContent);
  if (!hasActionVerb) {
    return false;
  }

  const person = eventDetails.person ? eventDetails.person.toLowerCase() : '';
  const title = eventDetails.cleanTitle.toLowerCase();
  const people = (m.interpretation?.people || []).map((p: string) => p.toLowerCase());
  const topics = (m.interpretation?.topics || []).map((t: string) => t.toLowerCase());
  const contexts = (m.interpretation?.contexts || []).map((c: string) => c.toLowerCase());

  // Linkage to Person:
  if (person) {
    if (people.includes(person) || lowerContent.includes(person)) {
      return true;
    }
    // Handle pronoun references for routine contacts (e.g. "Mum" -> "her", "she")
    if ((person === 'mum' || person === 'mother') && /\b(?:her|mum|mother)\b/i.test(lowerContent)) {
      return true;
    }
    if ((person === 'dad' || person === 'father') && /\b(?:him|dad|father)\b/i.test(lowerContent)) {
      return true;
    }
  }

  // Linkage to Medical Appointment (Locked Relevance Rule):
  // Topic/entity similarity alone is NEVER sufficient to qualify a memory as anticipatory preparation.
  // A preparation memory qualifies when:
  // A. It contains explicit intent binding it to the appointment/event (e.g. "ask Dr Marning about...", "discuss this at my next appointment", "renew this when I see the doctor")
  // OR
  // B. It is temporally near enough to the event AND semantically/actionably relevant (actionable task without distant future expiry).
  if (eventDetails.eventType === 'appointment' || /doctor|dentist|physio|gp/i.test(title)) {
    // Condition A: Explicit intent binding
    const hasExplicitAppointmentBinding =
      /\b(?:at\s+(?:my\s+|the\s+)?(?:next\s+)?appointment|to\s+(?:my\s+|the\s+)?appointment|for\s+(?:my\s+|the\s+)?appointment|when\s+i\s+see\s+(?:the\s+)?(?:doctor|dr|gp|dentist|physio)|with\s+(?:the\s+)?(?:doctor|dr|gp)|from\s+(?:the\s+)?(?:doctor|dr|gp))\b/i.test(lowerContent) ||
      Boolean(person && (people.includes(person) || lowerContent.includes(person)));

    const isMedicalTopicOrContext =
      /\b(?:scripts?|prescription|refill|blood\s*test|referral|scan|x-ray|medication|symptoms?|results?)\b/i.test(lowerContent) ||
      contexts.some(c => c.includes('medical') || c.includes('appointment') || c.includes('doctor')) ||
      topics.some(t => ['health', 'medical', 'prescriptions', 'blood test'].includes(t));

    if (hasExplicitAppointmentBinding && isMedicalTopicOrContext) {
      return true;
    }

    // Condition B: Actionable task/reminder without distant future expiry
    const resolvedIso = m.interpretation?.resolved_datetime || m.interpretation?.reminder_datetime || m.interpretation?.event_datetime;
    const hasFarFutureDate = (resolvedIso && resolvedIso.slice(0, 4) > '2026') ||
                             /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.](?:202[7-9]|20[3-9]\d)\b/.test(lowerContent);

    if (!hasFarFutureDate && isMedicalTopicOrContext && (kind === 'reminder' || kind === 'task')) {
      if (/\b(?:ask|discuss|mention|renew|bring|take)\s+(?:about\s+)?(?:my\s+|the\s+)?(?:scripts?|prescription|blood\s*test|referral|scan|medication)/i.test(lowerContent)) {
        return true;
      }
    }

    // When relevance is uncertain, OMIT supplemental context
    return false;
  }

  // Linkage to Event Title:
  if (title && (lowerContent.includes(title) || topics.some(t => title.includes(t)))) {
    return true;
  }

  return false;
}

/**
 * 3. Format the context item into a brief natural sentence.
 * Examples:
 * - "Check her new slacks" -> "You were going to check her new slacks."
 * - "Ask about scripts" -> PRE: "You wanted to ask about your scripts." / POST: "You were going to ask about your scripts."
 */
export function formatContextSentence(rawItem: string, stage: 'PRE' | 'POST'): string {
  let text = rawItem.trim()
    .replace(/^remember\s+(?:to\s+)?/i, '')
    .replace(/^don't\s+forget\s+(?:to\s+)?/i, '')
    .replace(/^need\s+to\s+/i, '')
    .replace(/^to\s+/i, '')
    .trim();

  // Strip trailing punctuation
  text = text.replace(/[.!?]+$/, '').trim();

  // Invariant: Do not mechanically prepend modal language to declarative/past facts
  const lower = text.toLowerCase();
  const isPastTense = /^(?:i\s+)?(?:spoke|talked|chatted|saw|visited|caught\s+up|went|had|received|got|sent|told|attended|met|bought|called|checked)\b/i.test(lower);
  if (isPastTense) {
    return ''; // Cannot safely support modal rewriting; omit rather than distorting tense
  }

  // If text starts with "ask ...", "ask about ...", "ask [person] about ..."
  if (/^ask\b/i.test(text)) {
    let subject = text
      .replace(/^ask\s+(?:(?:dr\.?|doctor)\s+[A-Za-z0-9'-]+|[A-Za-z0-9'-]+)\s+about\s+/i, '')
      .replace(/^ask\s+(?:about\s+)?/i, '')
      .trim();
    // Normalize "my" -> "your"
    subject = subject.replace(/\bmy\b/gi, 'your');
    const firstWord = subject.split(/\s+/)[0].toLowerCase();
    if (!/^(?:your|the|a|an|her|his|their|our|renewing|getting|checking|booking|buying)\b/i.test(firstWord)) {
      subject = `your ${subject}`;
    }
    if (stage === 'PRE') {
      return `You wanted to ask about ${subject}.`;
    } else {
      return `You were going to ask about ${subject}.`;
    }
  }

  // Normalize "my" to "your"
  let normalized = text.replace(/\bmy\b/gi, 'your');

  // If starts with "check ..."
  if (/^check\b/i.test(normalized)) {
    const prefix = stage === 'PRE' ? 'You wanted to' : 'You were going to';
    return `${prefix} ${normalized.charAt(0).toLowerCase() + normalized.slice(1)}.`;
  }

  // If starts with common action verbs
  if (/^(?:bring|take|give|show|pick\s*up|discuss|mention|renew|order|buy|call|book|organise|organize)\b/i.test(normalized)) {
    const prefix = stage === 'PRE' ? 'You wanted to' : 'You were going to';
    return `${prefix} ${normalized.charAt(0).toLowerCase() + normalized.slice(1)}.`;
  }

  // If already starts with "you were going to" or "you wanted to"
  if (/^you\s+(?:were\s+going\s+to|wanted\s+to)\b/i.test(normalized)) {
    return normalized.endsWith('.') ? normalized : `${normalized}.`;
  }

  // Where source semantics cannot safely support modal rewriting, omit rather than distorting
  return '';
}

/**
 * 4. Build the single global anticipatory prompt.
 */
export function buildAnticipatoryPrompt(options: AnticipatoryPromptOptions): AnticipatoryPromptResult {
  const { stage, title, temporalDesc, memories = [], activeRelationships = [], eventId } = options;
  const eventDetails = identifyEventDetails(title, options.person, options.eventType, activeRelationships);
  const { cleanTitle, person, eventType } = eventDetails;

  // Retrieve strongly relevant context memories
  const relevantMemories = memories.filter(m => isStronglyRelevantMemory(m, eventDetails, eventId));

  // Pick at most ONE strongly relevant item
  let contextSentence: string | null = null;
  if (relevantMemories.length > 0) {
    // Prefer explicit linked memory, otherwise first relevant
    const bestMemory = relevantMemories.find(m => eventId && m.interpretation?.linked_event_id === eventId) || relevantMemories[0];
    const rawAction = bestMemory.interpretation?.content || bestMemory.originalText || '';
    if (rawAction) {
      contextSentence = formatContextSentence(rawAction, stage);
    }
  }

  let prompt = '';

  // -------------------------------------------------------------
  // POST-EVENT ANTICIPATION
  // -------------------------------------------------------------
  if (stage === 'POST') {
    let leadSentence = '';
    let closingQuestion = 'Anything you want me to remember or remind you about?';

    if (eventType === 'routine' || (/^(?:visit|visiting|see|seeing)\b/i.test(cleanTitle) && person)) {
      leadSentence = person ? `How did your visit with ${person} go?` : `How did your ${cleanTitle} go?`;
      closingQuestion = 'Anything you want me to remember or remind you about?';
    } else if (eventType === 'call') {
      leadSentence = person ? `How did your call with ${person} go?` : 'How did the call go?';
      closingQuestion = 'Anything from the call you want me to remember or remind you about?';
    } else if (eventType === 'appointment') {
      if (/dentist/i.test(cleanTitle)) {
        leadSentence = 'How did the dentist appointment go?';
      } else if (person) {
        leadSentence = `How did your appointment with ${person} go?`;
      } else {
        leadSentence = 'How did the doctor appointment go?';
      }
      closingQuestion = 'Anything from the visit you want me to remember or remind you about?';
    } else if (eventType === 'meeting') {
      if (/dinner/i.test(cleanTitle)) {
        leadSentence = person ? `How did dinner with ${person} go?` : 'How did dinner go?';
      } else if (/lunch/i.test(cleanTitle)) {
        leadSentence = person ? `How did lunch with ${person} go?` : 'How did lunch go?';
      } else {
        leadSentence = person ? `How did your meeting with ${person} go?` : `How did your ${cleanTitle} go?`;
      }
      closingQuestion = 'Anything you want me to remember or remind you about?';
    } else {
      // Generic post event
      leadSentence = `How did ${cleanTitle} go?`;
      closingQuestion = 'Anything you want me to remember or remind you about?';
    }

    if (contextSentence) {
      prompt = `${leadSentence} ${contextSentence} ${closingQuestion}`;
    } else {
      prompt = `${leadSentence} ${closingQuestion}`;
    }
  }

  // -------------------------------------------------------------
  // PRE-EVENT ANTICIPATION
  // -------------------------------------------------------------
  else {
    const timePhrase = temporalDesc ? temporalDesc.trim() : 'today';

    if (eventType === 'birthday') {
      // Birthday PRE prompt:
      // "Tegan’s birthday is tomorrow. Anything you need to organise or be reminded about?"
      const name = person || cleanTitle.replace(/\s*birthday\s*/i, '').trim();
      const leadSentence = `${name}’s birthday is ${timePhrase}.`;
      prompt = `${leadSentence} Anything you need to organise or be reminded about?`;
    } else if (eventType === 'appointment') {
      let leadSentence = '';
      if (person) {
        leadSentence = `Your appointment with ${person} is ${timePhrase}.`;
      } else {
        let appointmentName = 'doctor appointment';
        if (/dentist/i.test(cleanTitle)) {
          appointmentName = 'dentist appointment';
        } else if (/physio/i.test(cleanTitle)) {
          appointmentName = 'physio appointment';
        }
        leadSentence = `Your ${appointmentName} is ${timePhrase}.`;
      }

      if (contextSentence) {
        prompt = `${leadSentence} ${contextSentence} Anything else you want to remember for the appointment?`;
      } else {
        prompt = `${leadSentence} Anything you want to remember for the appointment?`;
      }
    } else if (eventType === 'routine' && person) {
      const leadSentence = `Your visit with ${person} is ${timePhrase}.`;
      if (contextSentence) {
        prompt = `${leadSentence} ${contextSentence} Anything else you want to remember for the visit?`;
      } else {
        prompt = `${leadSentence} Anything you want to remember for the visit?`;
      }
    } else if (eventType === 'call' && person) {
      const leadSentence = `Your call with ${person} is ${timePhrase}.`;
      if (contextSentence) {
        prompt = `${leadSentence} ${contextSentence} Anything else you want to remember for the call?`;
      } else {
        prompt = `${leadSentence} Anything you want to remember for the call?`;
      }
    } else {
      // Generic PRE
      const leadSentence = `${cleanTitle} is ${timePhrase}.`;
      if (contextSentence) {
        prompt = `${leadSentence} ${contextSentence} Anything else you want to remember?`;
      } else {
        prompt = `${leadSentence} — Anything you want to remember?`;
      }
    }
  }

  return {
    prompt,
    isAnticipatory: true,
    cleanTitle,
    person: person || undefined,
    eventType,
    contextUsed: contextSentence,
    stage,
  };
}

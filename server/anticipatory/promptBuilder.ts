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
      const drMatch = cleanTitle.match(/^(?:dr\.?|doctor)\s+([A-Za-z0-9'-]+)/i);
      if (drMatch) {
        const candidateName = drMatch[1].trim();
        if (!/^(?:appointment|appt|visit|consultation|checkup|check-up|check|session)\b/i.test(candidateName)) {
          person = `Dr ${candidateName}`;
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
export function isStronglyRelevantMemory(
  m: any,
  eventDetails: { cleanTitle: string; person: string; eventType: string },
  eventId?: string
): boolean {
  if (!m) return false;
  if (m.isDone || m.interpretation?.status === 'completed' || m.interpretation?.status === 'dismissed') {
    return false;
  }

  // 1. Direct explicit link to event ID
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

  // Must have action, preparation, or discussion intent:
  const hasActionVerb = /\b(?:ask|discuss|mention|check|bring|take|give|tell|show|pick\s*up|renew|scripts?|prescription|blood\s*test|referral|scan|x-ray|symptoms?|results?|follow\s*up|remind|organise|organize)\b/i.test(lowerContent);
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

  // Linkage to Medical Appointment:
  if (eventDetails.eventType === 'appointment' || /doctor|dentist|physio|gp/i.test(title)) {
    const isMedicalTopic = /\b(?:scripts?|prescription|refill|blood\s*test|referral|scan|x-ray|medication|symptoms?|results?)\b/i.test(lowerContent);
    const isMedicalContext = contexts.some(c => c.includes('medical') || c.includes('appointment') || c.includes('doctor')) ||
                             topics.some(t => ['health', 'medical', 'prescriptions', 'blood test'].includes(t));
    if (isMedicalTopic || isMedicalContext) {
      return true;
    }
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

  // If text starts with "ask ...", "ask about ..."
  if (/^ask\b/i.test(text)) {
    let subject = text.replace(/^ask\s+(?:about\s+)?/i, '').trim();
    // Normalize "my scripts" or "scripts" -> "your scripts"
    subject = subject.replace(/\bmy\b/gi, 'your');
    if (!/\b(?:your|the|a|an|her|his|their|our)\b/i.test(subject)) {
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
    return `You were going to ${normalized.charAt(0).toLowerCase() + normalized.slice(1)}.`;
  }

  // If starts with common action verbs
  if (/^(?:bring|take|give|show|pick\s*up|discuss|mention|renew)\b/i.test(normalized)) {
    return `You were going to ${normalized.charAt(0).toLowerCase() + normalized.slice(1)}.`;
  }

  // If already starts with "you were going to" or "you wanted to"
  if (/^you\s+(?:were\s+going\s+to|wanted\s+to)\b/i.test(normalized)) {
    return normalized.endsWith('.') ? normalized : `${normalized}.`;
  }

  return `You were going to ${normalized.charAt(0).toLowerCase() + normalized.slice(1)}.`;
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
      } else if (person && person.startsWith('Dr ')) {
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
      let appointmentName = 'doctor appointment';
      if (/dentist/i.test(cleanTitle)) {
        appointmentName = 'dentist appointment';
      } else if (/physio/i.test(cleanTitle)) {
        appointmentName = 'physio appointment';
      }

      const leadSentence = `Your ${appointmentName} is ${timePhrase}.`;
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

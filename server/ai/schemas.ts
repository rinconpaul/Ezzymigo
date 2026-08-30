import { Type } from '@google/genai';

// Memory interpretation schema: JSON object containing a memories array
export const splitterResponseSchema = {
  type: Type.OBJECT,
  properties: {
    units: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'The smallest meaningful independent memory units extracted from the user capture.',
    },
  },
  required: ['units'],
};

export const memoryItemSchema = {
  type: Type.OBJECT,
  properties: {
    content: {
      type: Type.STRING,
      description: 'Cleaned and normalised representation of the full meaningful memory unit. Obvious spelling, grammar, punctuation, and transcription errors may be corrected, but NEVER drop, summarise away, or omit any meaningful clauses, facts, persons, places, commitments, third-party statements, decisions, quantities, or dates/times present in the captured unit.',
    },
    kind: {
      type: Type.STRING,
      description: 'Canonical classification category: "reminder" if the thought represents something the user intends or needs to do, arrange, buy, contact, follow up, attend, complete, or otherwise act upon (whether timed, dated, recurring, or completely untimed); "fact" if it is information to remember (knowledge, observations, relationships, preferences, states, reference information, or completed/past events); "not_sure" if basic meaning or actionable intent cannot be confidently understood (e.g. "This is going nowhere", "It’s just so reckless"). DO NOT use the presence or absence of a date/time to distinguish reminder from fact.',
    },
    intent: {
      type: Type.STRING,
      description: 'What specific type of action or information this represents (e.g., "task", "purchase", "contact", "appointment", "follow-up", "research", "decision", "idea", "fact", "knowledge", "note", "not_sure").',
    },
    status: {
      type: Type.STRING,
      description: 'Initial status of the intention, usually "active" unless already completed.',
    },
    people: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Names of people mentioned or involved in the thought.',
    },
    places: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Locations, venues, or places mentioned in the thought.',
    },
    topics: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Relevant subject tags or topics associated with the thought.',
    },
    contexts: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'MANDATORY NON-EMPTY ARRAY: Useful circumstances, environments, domains, or situations in which this information might be wanted or relevant again (e.g., ["home maintenance", "safety", "reference", "household"]). MUST NEVER BE EMPTY.',
    },
    retrieval_cues: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'MANDATORY NON-EMPTY ARRAY: Semantic concepts, search queries, related keywords, and likely future natural-language retrieval phrases or questions the user might ask when retrieving this information (e.g. ["where are the 9V batteries", "smoke alarm batteries", "smoke detector maintenance"]). MUST NEVER BE EMPTY.',
    },
    original_time_expression: {
      type: Type.STRING,
      nullable: true,
      description: 'Literal clock time, calendar date, or relative duration expression explicitly supplied by the user (e.g. "tomorrow morning", "in 10 minutes", "Saturday 9am"). MUST BE NULL if no temporal expression was in the user text. Inferred contextual phrases (e.g. "when smoke alarms need maintenance") are NOT time expressions and MUST NEVER be put here.',
    },
    resolved_datetime: {
      type: Type.STRING,
      nullable: true,
      description: 'Absolute ISO-8601 date-time string computed at capture time from relative time expressions using current local date/time reference. MUST BE NULL if no temporal expression was supplied by the user.',
    },
    event_time_expression: {
      type: Type.STRING,
      nullable: true,
      description: 'When the underlying event/task occurs if distinct from the reminder time (e.g. "Tuesday at 2pm"), or null if no event time was mentioned by the user.',
    },
    event_datetime: {
      type: Type.STRING,
      nullable: true,
      description: 'Absolute ISO-8601 date-time of the event if specified by the user, or null if not mentioned.',
    },
    reminder_time_expression: {
      type: Type.STRING,
      nullable: true,
      description: 'When the user wants to be reminded if distinct from the event (e.g. "Monday evening"), or null if no reminder time was mentioned by the user.',
    },
    reminder_datetime: {
      type: Type.STRING,
      nullable: true,
      description: 'Absolute ISO-8601 date-time of the reminder if specified by the user, or null if not mentioned.',
    },
    resurfacing: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          description: 'Trigger mode: "date_based" if temporal expression is present; "contextual", "location_based", or "none" if a fact/memory without a temporal expression.',
        },
        timing: {
          type: Type.STRING,
          description: 'Human-readable timing expression if temporal (e.g., "Saturday morning"), or "Contextual / On retrieval" or "Unscheduled" if non-temporal.',
        },
      },
      required: ['mode', 'timing'],
    },
    suggested_action: {
      type: Type.OBJECT,
      nullable: true,
      description: 'Optional suggested external search action when the memory refers to an externally searchable entity (e.g. book, restaurant, movie/show, concert/event ticket, place, public service). NEVER generate for products, shopping, consumer goods, possessions, or sold items. MUST BE NULL for ordinary personal memories, reminders, facts, and appointments.',
      properties: {
        type: { type: Type.STRING, description: 'Must be "web_search"' },
        label: { type: Type.STRING, description: 'Concise user-facing action label, e.g. "Find this book", "Find this restaurant", "Find where to watch", "Find tickets", "Look this up", "Find options"' },
        query: { type: Type.STRING, description: 'Concise search query derived from the memory content for Google search' },
      },
      required: ['type', 'label', 'query'],
    },
    relationships: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          person: { type: Type.STRING, description: 'Name of the person (e.g. "Barb", "Steve", "Naveena", "Peter")' },
          role: { type: Type.STRING, description: 'Role or relationship with the user (e.g. "wife", "plumber", "doctor", "dentist", "electrician", "husband", "partner", "spouse", "physio", "lawyer", "mechanic", "boss")' },
          is_active: { type: Type.BOOLEAN, description: 'true if establishing/confirming the relationship (e.g. "Barb is my wife", "Steve is my plumber", "Naveena is my doctor"); false if stating the relationship ended or is no longer current (e.g. "Steve isn\'t my plumber anymore")' },
        },
        required: ['person', 'role', 'is_active'],
      },
      description: 'Optional lightweight relationship or role assertions between the user and people mentioned in natural language.',
    },
    prerequisite: {
      type: Type.OBJECT,
      nullable: true,
      description: 'Optional structured dependency, blocker, or external condition that must occur before the user\'s intention/action can be performed. MUST BE NULL if there is no prerequisite/blocker/dependency.',
      properties: {
        condition: {
          type: Type.STRING,
          description: 'The prerequisite event, condition, or external dependency that must be completed first (e.g. "Steve repairs the broken gate", "The quote arrives", "The parts arrive", "After the meeting")',
        },
        status: {
          type: Type.STRING,
          description: 'Current status of the prerequisite, defaulting to "pending" unless already confirmed resolved.',
        },
        expected_time_expression: {
          type: Type.STRING,
          nullable: true,
          description: 'Explicit timing expression associated with the PREREQUISITE (e.g. "Monday", "Friday", "at 2pm"), or null if no timing is stated for the prerequisite. NOTE: This is the prerequisite\'s timing, NOT the user\'s action timing.',
        },
        expected_datetime: {
          type: Type.STRING,
          nullable: true,
          description: 'Absolute ISO-8601 timestamp resolved for the prerequisite\'s expected time, or null if no timing was stated for the prerequisite.',
        },
      },
      required: ['condition', 'status'],
    },
    items: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Optional array of structured item strings if the memory represents a collection, list, recipe ingredients, shopping list, packing list, or multi-item group under a single intention.',
    },
  },
  required: ['content', 'kind', 'intent', 'status', 'people', 'places', 'topics', 'contexts', 'retrieval_cues', 'resurfacing'],
};

export const memoriesResponseSchema = {
  type: Type.OBJECT,
  properties: {
    memories: {
      type: Type.ARRAY,
      items: memoryItemSchema,
      description: 'Array of structured memory objects, one for each distinct intention in the user input.',
    },
  },
  required: ['memories'],
};

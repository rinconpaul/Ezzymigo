export type AcknowledgementLevel = 0 | 1 | 2 | 3;

export interface AcknowledgementResult {
  ack_level: AcknowledgementLevel;
  ack_evidence: string[];
  ack_label: string;
  ack_detail?: string;
}

export interface MemoryProcessingEvidence {
  memoryId?: string;
  stored: boolean;

  // Level 3 evidence: Concrete future actions actually created
  isReminderScheduled?: boolean;
  scheduledRemindAt?: string | null; // ISO string of scheduled reminder, must be > now
  isLinkedToUpcomingEvent?: boolean; // Linked to an event starting >= now
  upcomingEventTitle?: string | null;
  deviceActionCreated?: boolean;

  // Level 2 evidence: Proof of connection to pre-existing knowledge
  linkedEntityIds?: string[]; // IDs from memory_entities links created
  wasExistingEntityUsed?: boolean; // Canonical existing entity resolved and used
  usedEntityNames?: string[];
  wasExistingRelationshipUsed?: boolean; // Pre-existing relationship materially used (e.g. plumber -> Rob)
  usedRelationshipDescription?: string | null;
  matchedExistingSubjectCluster?: string | null; // Matched pre-existing Same Subject cluster with prior memories
  contributedCalendarEvent?: {
    id: string;
    title?: string;
    isUpcoming: boolean;
  } | null;

  // Level 1 evidence: Deterministically extracted structure
  resolvedDatetime?: string | null;
  hasTemporalMeaning?: boolean;
  recognisedPeopleMentions?: string[]; // people[] text mentions (does NOT count as canonical entity link)
  recognisedRelationships?: Array<{ person: string; role: string }>;
  extractedItems?: string[]; // list items
  hasPrerequisite?: boolean;
  hasSuggestedAction?: boolean;
  structuredIntent?: string | null; // purchase, chore, appointment, contact

  // Ambiguity constraints (e.g. bare "at 4" awaiting AM/PM clarification)
  isAmbiguousClockTime?: boolean;
}

/**
 * Deterministic calculation of acknowledgement level and truthful label.
 *
 * RULES:
 * - The LLM must NEVER select or increase ack_level.
 * - Word count, complexity, emotional language, and enthusiasm NEVER affect ack_level.
 * - ack_level is derived strictly and deterministically from verified processing evidence.
 * - Language is restrained, truthful, and describes ONLY substantiated evidence.
 */
export function evaluateMemoryAcknowledgement(evidence: MemoryProcessingEvidence): AcknowledgementResult {
  const ack_evidence: string[] = [];
  const nowMs = Date.now();

  // Ambiguity guard: If clock time is ambiguous, reminder was NOT scheduled
  const isAmbiguous = Boolean(evidence.isAmbiguousClockTime);

  // -------------------------------------------------------------------------
  // LEVEL 3 — ACTED FOR THE FUTURE
  // Requires proof that processing produced a concrete future benefit:
  // - future reminder actually scheduled (row in scheduled_reminders with remindAt > now);
  // - memory actually linked to an upcoming event for resurfacing/follow-up;
  // - another deterministic future action was actually created (e.g. deviceAction).
  //
  // MERELY CONTAINING A FUTURE DATE OR HAVING ANTICIPATORY_MODE DOES NOT QUALIFY!
  // -------------------------------------------------------------------------
  let hasLevel3 = false;
  let level3Label = '';

  if (!isAmbiguous && evidence.isReminderScheduled && evidence.scheduledRemindAt) {
    const remindTimeMs = Date.parse(evidence.scheduledRemindAt);
    if (!isNaN(remindTimeMs) && remindTimeMs > nowMs) {
      hasLevel3 = true;
      ack_evidence.push(`scheduled_future_reminder:${evidence.scheduledRemindAt}`);
      level3Label = 'Reminder scheduled';
    }
  }

  if (evidence.isLinkedToUpcomingEvent) {
    hasLevel3 = true;
    const evtName = evidence.upcomingEventTitle || 'upcoming_event';
    ack_evidence.push(`linked_to_upcoming_event:${evtName}`);
    if (!level3Label) {
      level3Label = `Linked to upcoming ${evtName}`;
    }
  }

  if (evidence.deviceActionCreated) {
    hasLevel3 = true;
    ack_evidence.push('device_action_created');
    if (!level3Label) {
      level3Label = 'Action ready';
    }
  }

  // -------------------------------------------------------------------------
  // LEVEL 2 — CONNECTED
  // Requires proof that the new information was actually connected to existing
  // Ezzy knowledge, such as:
  // - canonical existing entity resolved/used and/or memory_entities link created;
  // - existing relationship materially used;
  // - existing Same Subject cluster matched;
  // - existing calendar/memory context materially contributed.
  // -------------------------------------------------------------------------
  let hasLevel2 = false;
  let level2Label = '';

  const validLinkedEntityIds = (evidence.linkedEntityIds || []).filter(Boolean);
  if (validLinkedEntityIds.length > 0 || evidence.wasExistingEntityUsed) {
    hasLevel2 = true;
    for (const entId of validLinkedEntityIds) {
      ack_evidence.push(`canonical_entity_linked:${entId}`);
    }
    if (evidence.wasExistingEntityUsed && validLinkedEntityIds.length === 0) {
      ack_evidence.push('existing_entity_used');
    }
    const entName = evidence.usedEntityNames?.[0];
    level2Label = entName ? `Connected to ${entName}` : 'Connected to known entity';
  }

  if (evidence.wasExistingRelationshipUsed) {
    hasLevel2 = true;
    const relDesc = evidence.usedRelationshipDescription || 'existing_relationship';
    ack_evidence.push(`existing_relationship_used:${relDesc}`);
    if (!level2Label) {
      level2Label = `Connected via ${relDesc}`;
    }
  }

  if (evidence.matchedExistingSubjectCluster) {
    hasLevel2 = true;
    ack_evidence.push(`matched_existing_subject_cluster:${evidence.matchedExistingSubjectCluster}`);
    if (!level2Label) {
      level2Label = `Added to ${evidence.matchedExistingSubjectCluster}`;
    }
  }

  if (evidence.contributedCalendarEvent) {
    hasLevel2 = true;
    const calDesc = evidence.contributedCalendarEvent.title || evidence.contributedCalendarEvent.id;
    ack_evidence.push(`calendar_context_contributed:${calDesc}`);
    if (!level2Label) {
      level2Label = `Linked to ${calDesc}`;
    }
  }

  // -------------------------------------------------------------------------
  // LEVEL 1 — UNDERSTOOD
  // Deterministically extracted useful structure such as:
  // - resolved temporal meaning;
  // - recognised person mention (a people[] string alone does NOT count as canonical entity resolution);
  // - list/dependency/action structure.
  // -------------------------------------------------------------------------
  let hasLevel1 = false;
  let level1Label = '';

  if (evidence.hasTemporalMeaning || evidence.resolvedDatetime) {
    hasLevel1 = true;
    ack_evidence.push(`resolved_temporal_meaning:${evidence.resolvedDatetime || 'date_detected'}`);
    level1Label = 'Saved with date';
  }

  const people = (evidence.recognisedPeopleMentions || []).filter(Boolean);
  if (people.length > 0) {
    hasLevel1 = true;
    ack_evidence.push(`recognised_person_mention:${people.join(',')}`);
    if (!level1Label) {
      level1Label = `Saved mention of ${people[0]}`;
    }
  }

  const rels = (evidence.recognisedRelationships || []).filter(Boolean);
  if (rels.length > 0 && !evidence.wasExistingRelationshipUsed) {
    hasLevel1 = true;
    ack_evidence.push(`extracted_relationship:${rels.map(r => `${r.person}->${r.role}`).join(',')}`);
    if (!level1Label) {
      level1Label = `Learned ${rels[0].person} is ${rels[0].role}`;
    }
  }

  const items = (evidence.extractedItems || []).filter(Boolean);
  if (items.length > 0) {
    hasLevel1 = true;
    ack_evidence.push(`extracted_list_items:${items.length}`);
    if (!level1Label) {
      level1Label = `Saved ${items.length} ${items.length === 1 ? 'item' : 'items'}`;
    }
  }

  if (evidence.hasPrerequisite) {
    hasLevel1 = true;
    ack_evidence.push('extracted_prerequisite_condition');
    if (!level1Label) {
      level1Label = 'Saved with condition';
    }
  }

  if (evidence.hasSuggestedAction) {
    hasLevel1 = true;
    ack_evidence.push('extracted_suggested_action');
    if (!level1Label) {
      level1Label = 'Understood & saved';
    }
  }

  if (evidence.structuredIntent && ['purchase', 'chore', 'appointment', 'contact'].includes(evidence.structuredIntent)) {
    hasLevel1 = true;
    ack_evidence.push(`structured_intent:${evidence.structuredIntent}`);
    if (!level1Label) {
      level1Label = 'Understood & saved';
    }
  }

  // -------------------------------------------------------------------------
  // FINAL LEVEL ASSIGNMENT (Highest Substantiated Level Wins)
  // -------------------------------------------------------------------------
  if (hasLevel3) {
    return {
      ack_level: 3,
      ack_evidence,
      ack_label: level3Label || 'Reminder scheduled',
    };
  }

  if (hasLevel2) {
    return {
      ack_level: 2,
      ack_evidence,
      ack_label: level2Label || 'Connected & saved',
    };
  }

  if (hasLevel1) {
    return {
      ack_level: 1,
      ack_evidence,
      ack_label: level1Label || 'Understood & saved',
    };
  }

  // LEVEL 0 — STORED
  // Successful storage only. Minimal Saved acknowledgement.
  return {
    ack_level: 0,
    ack_evidence: ['stored_only'],
    ack_label: 'Saved',
  };
}

/**
 * Aggregates acknowledgement results from multiple memories saved in a single capture.
 */
export function compositeAcknowledgement(results: AcknowledgementResult[]): AcknowledgementResult {
  if (!results || results.length === 0) {
    return {
      ack_level: 0,
      ack_evidence: ['stored_only'],
      ack_label: 'Saved',
    };
  }

  let maxLevel: AcknowledgementLevel = 0;
  const allEvidence: string[] = [];
  let bestResult = results[0];

  for (const res of results) {
    for (const ev of res.ack_evidence) {
      if (!allEvidence.includes(ev)) {
        allEvidence.push(ev);
      }
    }
    if (res.ack_level > maxLevel) {
      maxLevel = res.ack_level;
      bestResult = res;
    }
  }

  if (results.length > 1) {
    allEvidence.push(`saved_multiple_memories:${results.length}`);
  }

  return {
    ack_level: maxLevel,
    ack_evidence: allEvidence,
    ack_label: bestResult.ack_label,
    ack_detail: results.length > 1 ? `Saved ${results.length} memories` : bestResult.ack_detail,
  };
}

export const evaluateAcknowledgement = evaluateMemoryAcknowledgement;


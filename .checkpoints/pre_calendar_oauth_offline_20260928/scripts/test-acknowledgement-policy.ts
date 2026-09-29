import {
  evaluateMemoryAcknowledgement,
  compositeAcknowledgement,
  MemoryProcessingEvidence,
} from '../server/ai/acknowledgementPolicy.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

async function runAcknowledgementPolicyTests() {
  console.log('================================================================');
  console.log('  DETERMINISTIC ACKNOWLEDGEMENT-STRENGTH POLICY TEST SUITE');
  console.log('================================================================\n');

  // -------------------------------------------------------------------
  // TEST 1: Acceptance Rule 1: "Sharpen the knives." -> Level 0
  // Successful storage only. Minimal "Saved" acknowledgement.
  // -------------------------------------------------------------------
  console.log('Test 1: "Sharpen the knives." -> Level 0 (Stored only)');
  const knivesEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false,
    scheduledRemindAt: null,
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: [],
    wasExistingEntityUsed: false,
    recognisedPeopleMentions: [],
    extractedItems: [],
    hasTemporalMeaning: false,
  };
  const knivesResult = evaluateMemoryAcknowledgement(knivesEvidence);
  assert(knivesResult.ack_level === 0, 'ack_level must be 0 for simple unlinked storage');
  assert(knivesResult.ack_label === 'Saved', 'ack_label must be minimal "Saved"');
  assert(knivesResult.ack_evidence.includes('stored_only'), 'ack_evidence must declare stored_only');

  // -------------------------------------------------------------------
  // TEST 2: Acceptance Rule 2: "Doug likes bananas." -> Level 1 maximum
  // Doug merely extracted in people[] string, but NOT matched to canonical entity.
  // Proof that a people[] string alone does NOT count as canonical entity resolution.
  // -------------------------------------------------------------------
  console.log('\nTest 2: "Doug likes bananas." -> Level 1 maximum (text mention only)');
  const dougUnlinkedEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false,
    scheduledRemindAt: null,
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: [], // Not linked to canonical user entity!
    wasExistingEntityUsed: false,
    recognisedPeopleMentions: ['Doug'], // Extracted string only
    extractedItems: [],
    hasTemporalMeaning: false,
  };
  const dougUnlinkedResult = evaluateMemoryAcknowledgement(dougUnlinkedEvidence);
  assert(dougUnlinkedResult.ack_level === 1, 'ack_level must be 1 (Understood), NEVER 2 without canonical link');
  assert(dougUnlinkedResult.ack_label.includes('Doug'), `ack_label truth: ${dougUnlinkedResult.ack_label}`);
  assert(
    dougUnlinkedResult.ack_evidence.includes('recognised_person_mention:Doug'),
    'ack_evidence must specify recognised_person_mention:Doug'
  );
  assert(
    !dougUnlinkedResult.ack_evidence.some(e => e.startsWith('canonical_entity_linked')),
    'Must NOT contain canonical_entity_linked'
  );

  // -------------------------------------------------------------------
  // TEST 3: Acceptance Rule 3: Post-call "He's in Sydney this weekend"
  // resolved and structurally linked to existing Doug -> Level 2
  // Proof of connection to existing Ezzy knowledge.
  // -------------------------------------------------------------------
  console.log('\nTest 3: Post-call "He\'s in Sydney this weekend" resolved to existing Doug -> Level 2');
  const sydneyConnectedEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false, // Not a scheduled reminder
    scheduledRemindAt: null,
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: ['ent_person_doug_123'], // Canonical link created in memory_entities
    wasExistingEntityUsed: true,
    usedEntityNames: ['Doug'],
    hasTemporalMeaning: true,
    resolvedDatetime: '2026-09-06T00:00:00Z',
  };
  const sydneyResult = evaluateMemoryAcknowledgement(sydneyConnectedEvidence);
  assert(sydneyResult.ack_level === 2, 'ack_level must be 2 (Connected to existing entity)');
  assert(sydneyResult.ack_label === 'Connected to Doug', `ack_label must be "Connected to Doug" (got: ${sydneyResult.ack_label})`);
  assert(
    sydneyResult.ack_evidence.includes('canonical_entity_linked:ent_person_doug_123'),
    'ack_evidence must include canonical_entity_linked:ent_person_doug_123'
  );

  // -------------------------------------------------------------------
  // TEST 4: Acceptance Rule 4: "Remind me Monday to ask Doug how Sydney went"
  // with reminder successfully scheduled -> Level 3
  // Proof that processing produced a concrete future benefit.
  // -------------------------------------------------------------------
  console.log('\nTest 4: "Remind me Monday to ask Doug how Sydney went" -> Level 3 (Action created)');
  const mondayFutureDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const scheduledReminderEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: true,
    scheduledRemindAt: mondayFutureDate, // Successfully inserted into scheduled_reminders
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: ['ent_person_doug_123'],
    wasExistingEntityUsed: true,
    usedEntityNames: ['Doug'],
    hasTemporalMeaning: true,
    resolvedDatetime: mondayFutureDate,
  };
  const scheduledResult = evaluateMemoryAcknowledgement(scheduledReminderEvidence);
  assert(scheduledResult.ack_level === 3, 'ack_level must be 3 (Acted for future)');
  assert(scheduledResult.ack_label === 'Reminder scheduled', `ack_label must be "Reminder scheduled" (got: ${scheduledResult.ack_label})`);
  assert(
    scheduledResult.ack_evidence.some(e => e.startsWith('scheduled_future_reminder:')),
    'ack_evidence must include scheduled_future_reminder'
  );

  // -------------------------------------------------------------------
  // TEST 5: Acceptance Rule 5: Ambiguous "Call Steve at 4" before AM/PM clarification
  // NEVER Level 3!
  // -------------------------------------------------------------------
  console.log('\nTest 5: Ambiguous "Call Steve at 4" awaiting AM/PM -> NEVER Level 3');
  const ambiguousSteveEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false, // Reminder was postponed by scheduler!
    scheduledRemindAt: null,
    isAmbiguousClockTime: true, // Temporal ambiguity awaiting clarification
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: ['ent_person_steve_456'], // Steve is known
    wasExistingEntityUsed: true,
    usedEntityNames: ['Steve'],
    hasTemporalMeaning: true,
  };
  const ambiguousSteveResult = evaluateMemoryAcknowledgement(ambiguousSteveEvidence);
  assert(ambiguousSteveResult.ack_level !== 3, 'Ambiguous "Call Steve at 4" must NEVER be Level 3');
  assert(ambiguousSteveResult.ack_level === 2, 'With known Steve, it resolves to Level 2 (Connected)');
  assert(ambiguousSteveResult.ack_label === 'Connected to Steve', `ack_label is ${ambiguousSteveResult.ack_label}`);

  // Test 5b: Ambiguous time with an unknown person mention -> Level 1 (Understood mention only)
  const ambiguousUnknownEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false,
    scheduledRemindAt: null,
    isAmbiguousClockTime: true,
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: [],
    wasExistingEntityUsed: false,
    recognisedPeopleMentions: ['Steve'],
    hasTemporalMeaning: true,
  };
  const ambiguousUnknownResult = evaluateMemoryAcknowledgement(ambiguousUnknownEvidence);
  assert(ambiguousUnknownResult.ack_level === 1, 'Ambiguous time with unlinked person must be Level 1');

  // -------------------------------------------------------------------
  // TEST 6: Acceptance Rule 6: Word count and emotional wording must NOT elevate level
  // -------------------------------------------------------------------
  console.log('\nTest 6: Long/emotional input vs. short input');
  const longEmotionalTrivialEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false,
    scheduledRemindAt: null,
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: [],
    wasExistingEntityUsed: false,
    // Emulate raw text: "Oh my god I am completely overwhelmed and stressed about everything please keep this safe"
    recognisedPeopleMentions: [],
    extractedItems: [],
    hasTemporalMeaning: false,
  };
  const emotionalResult = evaluateMemoryAcknowledgement(longEmotionalTrivialEvidence);
  assert(
    emotionalResult.ack_level === 0,
    'Long emotional input with no extracted structure MUST remain Level 0'
  );
  assert(
    emotionalResult.ack_label === 'Saved',
    'Long emotional input must receive minimal "Saved" label'
  );

  // Short 4-word input with future action:
  const shortActionEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: true,
    scheduledRemindAt: mondayFutureDate,
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: [],
    hasTemporalMeaning: true,
  };
  const shortActionResult = evaluateMemoryAcknowledgement(shortActionEvidence);
  assert(
    shortActionResult.ack_level === 3,
    'Short input with actual future action is Level 3 (content length does not penalize)'
  );

  // -------------------------------------------------------------------
  // TEST 7: List items extracted without entities or dates -> Level 1
  // -------------------------------------------------------------------
  console.log('\nTest 7: Extracted list items -> Level 1');
  const listItemsEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false,
    scheduledRemindAt: null,
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: [],
    extractedItems: ['milk', 'bread', 'eggs'],
  };
  const listResult = evaluateMemoryAcknowledgement(listItemsEvidence);
  assert(listResult.ack_level === 1, 'Extracted items must produce Level 1');
  assert(listResult.ack_label === 'Saved 3 items', `ack_label must state "Saved 3 items" (got: ${listResult.ack_label})`);
  assert(listResult.ack_evidence.includes('extracted_list_items:3'), 'ack_evidence must include extracted_list_items:3');

  // -------------------------------------------------------------------
  // TEST 8: Prerequisite condition extracted -> Level 1
  // -------------------------------------------------------------------
  console.log('\nTest 8: Prerequisite condition extracted -> Level 1');
  const prereqEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false,
    scheduledRemindAt: null,
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: [],
    hasPrerequisite: true,
  };
  const prereqResult = evaluateMemoryAcknowledgement(prereqEvidence);
  assert(prereqResult.ack_level === 1, 'Prerequisite condition must produce Level 1');
  assert(prereqResult.ack_label === 'Saved with condition', `ack_label is ${prereqResult.ack_label}`);
  assert(prereqResult.ack_evidence.includes('extracted_prerequisite_condition'), 'ack_evidence must include extracted_prerequisite_condition');

  // -------------------------------------------------------------------
  // TEST 9: Matched existing Same Subject cluster -> Level 2
  // -------------------------------------------------------------------
  console.log('\nTest 9: Matched existing Same Subject cluster -> Level 2');
  const subjectEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false,
    scheduledRemindAt: null,
    isLinkedToUpcomingEvent: false,
    linkedEntityIds: [],
    matchedExistingSubjectCluster: 'Camping Trip',
  };
  const subjectResult = evaluateMemoryAcknowledgement(subjectEvidence);
  assert(subjectResult.ack_level === 2, 'Matched existing subject cluster must produce Level 2');
  assert(subjectResult.ack_label === 'Added to Camping Trip', `ack_label must state "Added to Camping Trip" (got: ${subjectResult.ack_label})`);
  assert(subjectResult.ack_evidence.includes('matched_existing_subject_cluster:Camping Trip'), 'ack_evidence must include subject cluster');

  // -------------------------------------------------------------------
  // TEST 10: Linked to an upcoming calendar event -> Level 3
  // -------------------------------------------------------------------
  console.log('\nTest 10: Linked to upcoming calendar event -> Level 3');
  const upcomingCalEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false,
    isLinkedToUpcomingEvent: true,
    upcomingEventTitle: 'Dentist Appointment',
    contributedCalendarEvent: {
      id: 'evt_dentist_789',
      title: 'Dentist Appointment',
      isUpcoming: true,
    },
  };
  const upcomingCalResult = evaluateMemoryAcknowledgement(upcomingCalEvidence);
  assert(upcomingCalResult.ack_level === 3, 'Linked to upcoming event must produce Level 3');
  assert(upcomingCalResult.ack_label === 'Linked to upcoming Dentist Appointment', `ack_label is ${upcomingCalResult.ack_label}`);

  // -------------------------------------------------------------------
  // TEST 11: Linked to a past calendar event / reflection context -> Level 2
  // -------------------------------------------------------------------
  console.log('\nTest 11: Linked to past calendar event / reflection context -> Level 2');
  const pastCalEvidence: MemoryProcessingEvidence = {
    stored: true,
    isReminderScheduled: false,
    isLinkedToUpcomingEvent: false, // Past event!
    contributedCalendarEvent: {
      id: 'evt_doctor_past',
      title: 'Doctor Follow-up',
      isUpcoming: false,
    },
  };
  const pastCalResult = evaluateMemoryAcknowledgement(pastCalEvidence);
  assert(pastCalResult.ack_level === 2, 'Linked to past event context must produce Level 2 (Connected)');
  assert(pastCalResult.ack_label === 'Linked to Doctor Follow-up', `ack_label is ${pastCalResult.ack_label}`);

  // -------------------------------------------------------------------
  // TEST 12: Composite acknowledgement from multiple memories
  // -------------------------------------------------------------------
  console.log('\nTest 12: Composite acknowledgement from batch save');
  const composite = compositeAcknowledgement([knivesResult, dougUnlinkedResult, scheduledResult]);
  assert(composite.ack_level === 3, 'Composite ack_level must be max level among items (3)');
  assert(composite.ack_evidence.includes('saved_multiple_memories:3'), 'Composite must note multiple memories');
  assert(composite.ack_detail === 'Saved 3 memories', `Composite detail: ${composite.ack_detail}`);

  // -------------------------------------------------------------------
  // TEST 13: Determinism Proof - Zero LLM text variation sensitivity
  // -------------------------------------------------------------------
  console.log('\nTest 13: Determinism Proof - Identical evidence produces identical level');
  for (let i = 0; i < 10; i++) {
    const res = evaluateMemoryAcknowledgement(knivesEvidence);
    if (res.ack_level !== 0 || res.ack_label !== 'Saved') {
      assert(false, `Run ${i} produced inconsistent output`);
    }
  }
  assert(true, '10 successive evaluations of identical evidence produced 100% identical level & label');

  console.log('\n================================================================');
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAcknowledgementPolicyTests().catch(err => {
  console.error('Fatal error running acknowledgement policy tests:', err);
  process.exit(1);
});

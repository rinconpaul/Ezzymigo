/**
 * Targeted Regression Tests for Today / Anticipatory Intelligence Surgical Repair
 *
 * Verifies:
 * 1. Stop Completed Occasion Reflections Resurfacing (Occasion reflection satisfaction)
 * 2. Do Not Feed Reflection Answers Back Into Prompts (Reflection outcome exclusion)
 * 3. Fix Appointment Context Relevance (Locked Relevance Rule: scripts expiry vs actionable intent)
 * 4. Preserve Named Person in Calendar Appointments (Dr Marning vs generic doctor)
 * 5. Remove Duplicated Time in Today Text (cleanActionText / composition time deduplication)
 */

import {
  evaluateTodayRelevanceCandidates,
  hasCompletedReflectionForEvent,
  cleanActionText,
} from '../server/today/relevance';
import { formatLocalTimeContext } from '../server/utils/time';
import {
  buildAnticipatoryPrompt,
  isReflectionOutcomeMemory,
  isStronglyRelevantMemory,
  formatContextSentence,
} from '../server/anticipatory/promptBuilder';
import { OccasionOccurrence } from '../src/types';

let failures = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${msg}`);
    failures++;
  } else {
    console.log(`✅ PASS: ${msg}`);
  }
}

console.log('\n--- 1. STOP COMPLETED OCCASION REFLECTIONS RESURFACING ---');
{
  const occasionOccurrence: OccasionOccurrence = {
    occurrenceId: 'occ_fathers_day_2026:2026-09-06',
    occasionId: 'occ_fathers_day_2026',
    title: "Father's Day",
    isMultiDay: false,
    startDate: '2026-09-06',
    endDate: '2026-09-06',
    anticipatoryMode: 'PRE_AND_POST',
  };

  const localContextMonday = formatLocalTimeContext(
    '2026-09-07T08:00:00+10:00',
    'Australia/Sydney'
  );

  // Scenario A: Without completed reflection memory, reflection surfaces on Monday
  const candidatesWithoutResponse = evaluateTodayRelevanceCandidates(
    [],
    [],
    [],
    localContextMonday,
    [],
    [occasionOccurrence]
  );
  const postReflectionFoundA = candidatesWithoutResponse.some(
    (c) => c.source_type === 'occasion' && c.anticipatory_stage === 'reflect'
  );
  assert(postReflectionFoundA, 'Occasion reflection surfaces 1 day post-event when unanswered');

  // Scenario B: With completed reflection memory answered on Sunday or Monday
  const answeredMemory = {
    id: 'mem_fathers_day_response',
    originalText: 'I spoke with Roland; he is moving down to Century Point in two weeks.',
    createdAt: '2026-09-06T18:30:00+10:00',
    interpretation: {
      content: 'I spoke with Roland; he is moving down to Century Point in two weeks.',
      kind: 'note',
      linked_event_id: 'occ_fathers_day_2026:2026-09-06',
      is_reflection_response: true,
      origin: 'reflection_outcome',
    },
  };

  const hasCompleted = hasCompletedReflectionForEvent(
    {
      id: occasionOccurrence.occasionId,
      occurrenceId: occasionOccurrence.occurrenceId,
      title: occasionOccurrence.title,
      start_datetime: '2026-09-06T00:00:00',
    },
    [answeredMemory],
    [],
    [],
    'Australia/Sydney',
    '2026-09-06'
  );
  assert(hasCompleted, 'hasCompletedReflectionForEvent detects explicit linked reflection outcome');

  const candidatesWithResponse = evaluateTodayRelevanceCandidates(
    [answeredMemory],
    [],
    [],
    localContextMonday,
    [],
    [occasionOccurrence]
  );
  const postReflectionFoundB = candidatesWithResponse.some(
    (c) => c.source_type === 'occasion' && c.anticipatory_stage === 'reflect'
  );
  assert(!postReflectionFoundB, 'Answered occasion reflection does NOT resurface on Monday');
}

console.log('\n--- 2. DO NOT FEED REFLECTION ANSWERS BACK INTO PROMPTS ---');
{
  const answeredMemory = {
    id: 'mem_fathers_day_response',
    originalText: 'I spoke with Roland; he is moving down to Century Point in two weeks.',
    createdAt: '2026-09-06T18:30:00+10:00',
    interpretation: {
      content: 'I spoke with Roland; he is moving down to Century Point in two weeks.',
      kind: 'note',
      linked_event_id: 'occ_fathers_day_2026:2026-09-06',
      is_reflection_response: true,
      origin: 'reflection_outcome',
    },
  };

  assert(isReflectionOutcomeMemory(answeredMemory), 'isReflectionOutcomeMemory recognizes reflection outcome memory');

  const isRelevantForPrep = isStronglyRelevantMemory(
    answeredMemory,
    { cleanTitle: "Father's Day", person: 'Dad', eventType: 'generic' },
    'occ_fathers_day_2026:2026-09-06'
  );
  assert(!isRelevantForPrep, 'Reflection outcome memory is excluded from preparation retrieval');

  const formattedSentence = formatContextSentence(answeredMemory.originalText, 'POST');
  assert(formattedSentence === '', 'Declarative past-tense statement is never rewritten with "You were going to spoke..."');
}

console.log('\n--- 3. FIX APPOINTMENT CONTEXT RELEVANCE (LOCKED RELEVANCE RULE) ---');
{
  const distantPassiveFactMemory = {
    id: 'mem_scripts_expiry',
    originalText: 'All my current scripts expire on 18/08/2027.',
    interpretation: {
      content: 'All my current scripts expire on 18/08/2027.',
      kind: 'fact',
      topics: ['health', 'prescriptions'],
      contexts: ['medical'],
    },
  };

  const actionableIntentMemory = {
    id: 'mem_ask_scripts',
    originalText: 'Ask Dr Marning about renewing my scripts at my next appointment',
    interpretation: {
      content: 'Ask Dr Marning about renewing my scripts at my next appointment',
      kind: 'task',
      people: ['Dr Marning'],
      topics: ['prescriptions'],
      contexts: ['appointment', 'medical'],
    },
  };

  const eventDetails = {
    cleanTitle: 'Dr Marning',
    person: 'Dr Marning',
    eventType: 'appointment' as const,
  };

  const isDistantFactRelevant = isStronglyRelevantMemory(distantPassiveFactMemory, eventDetails);
  assert(!isDistantFactRelevant, 'Locked Relevance Rule: Passive scripts expiry fact (2027) is NOT relevant context');

  const isActionableIntentRelevant = isStronglyRelevantMemory(actionableIntentMemory, eventDetails);
  assert(isActionableIntentRelevant, 'Locked Relevance Rule: Explicit "Ask Dr Marning" intent IS relevant context');

  // Verify prompt generation with only the distant fact -> Context is omitted safely!
  const promptWithOnlyDistantFact = buildAnticipatoryPrompt({
    stage: 'PRE',
    title: 'Dr Marning',
    temporalDesc: 'today',
    memories: [distantPassiveFactMemory],
  });
  assert(
    promptWithOnlyDistantFact.prompt === 'Your appointment with Dr Marning is today. Anything you want to remember for the appointment?',
    'Prompt safely omits irrelevant context when only distant fact exists'
  );

  // Verify prompt generation with actionable intent -> Correctly integrates intent!
  const promptWithActionableIntent = buildAnticipatoryPrompt({
    stage: 'PRE',
    title: 'Dr Marning',
    temporalDesc: 'today',
    memories: [actionableIntentMemory],
  });
  assert(
    promptWithActionableIntent.prompt.includes('You wanted to ask about renewing your scripts'),
    `Prompt integrates actionable intent cleanly: "${promptWithActionableIntent.prompt}"`
  );
}

console.log('\n--- 4. PRESERVE NAMED PERSON IN CALENDAR APPOINTMENTS ---');
{
  // PRE appointment with named doctor
  const preNamedDoctorPrompt = buildAnticipatoryPrompt({
    stage: 'PRE',
    title: 'Dr Marning',
    temporalDesc: 'today',
  });
  assert(
    preNamedDoctorPrompt.prompt.startsWith('Your appointment with Dr Marning is today.'),
    `Named doctor appointment preserves "Dr Marning": ${preNamedDoctorPrompt.prompt}`
  );

  // POST appointment with named doctor
  const postNamedDoctorPrompt = buildAnticipatoryPrompt({
    stage: 'POST',
    title: 'Dr Marning',
  });
  assert(
    postNamedDoctorPrompt.prompt.startsWith('How did your appointment with Dr Marning go?'),
    `Named doctor post-appointment preserves "Dr Marning": ${postNamedDoctorPrompt.prompt}`
  );

  // Generic appointment without named person
  const genericAppointmentPrompt = buildAnticipatoryPrompt({
    stage: 'PRE',
    title: 'Doctor appointment',
    temporalDesc: 'today',
  });
  assert(
    genericAppointmentPrompt.prompt.startsWith('Your doctor appointment is today.'),
    `Generic doctor appointment stays generic: ${genericAppointmentPrompt.prompt}`
  );
}

console.log('\n--- 5. REMOVE DUPLICATED TIME IN TODAY TEXT ---');
{
  const embeddedTimeMemory = {
    id: 'mem_dentist_embedded_time',
    originalText: 'Mum has an appointment at 10:00 on Monday at the dentist.',
    interpretation: {
      content: 'Mum has an appointment at 10:00 on Monday at the dentist.',
      reminder_datetime: '2026-09-07T10:00:00+10:00',
      kind: 'reminder',
    },
  };

  const localContextBeforeTime = formatLocalTimeContext(
    '2026-09-07T08:30:00+10:00',
    'Australia/Sydney'
  );

  const candidates = evaluateTodayRelevanceCandidates(
    [embeddedTimeMemory],
    [],
    [],
    localContextBeforeTime,
    [],
    []
  );

  const reminderCandidate = candidates.find((c) => c.source_id === 'mem_dentist_embedded_time');
  assert(Boolean(reminderCandidate), 'Reminder candidate was produced for today');
  assert(
    reminderCandidate?.display_text === 'Mum has an appointment at 10:00 on Monday at the dentist',
    `No duplicated time in display_text: "${reminderCandidate?.display_text}"`
  );
  assert(
    !reminderCandidate?.display_text.endsWith('at 10:00am'),
    'Does not append redundant "at 10:00am" when time is already in the text'
  );

  // Positive control: Simple reminder without embedded time still gets useful time appended before reminder
  const simpleReminder = {
    id: 'mem_ring_bill',
    originalText: 'Ring Bill',
    interpretation: {
      content: 'Ring Bill',
      reminder_datetime: '2026-09-07T10:00:00+10:00',
      kind: 'reminder',
    },
  };

  const simpleCandidates = evaluateTodayRelevanceCandidates(
    [simpleReminder],
    [],
    [],
    localContextBeforeTime,
    [],
    []
  );

  const simpleCandidate = simpleCandidates.find((c) => c.source_id === 'mem_ring_bill');
  assert(
    simpleCandidate?.display_text === 'Ring Bill at 10:00am',
    `Simple reminder without time gets clean time appended: "${simpleCandidate?.display_text}"`
  );
}

console.log('\n----------------------------------------');
if (failures === 0) {
  console.log('🎉 ALL 5 TODAY SURGICAL REPAIR REGRESSION TESTS PASSED!');
  process.exit(0);
} else {
  console.error(`💥 ${failures} TEST(S) FAILED!`);
  process.exit(1);
}

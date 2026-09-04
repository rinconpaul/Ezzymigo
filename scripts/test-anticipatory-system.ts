import { classifyAnticipatoryMode, generateAnticipationOffer } from '../server/anticipatory/classifier';
import { evaluateTodayRelevance, hasCompletedReflectionForEvent } from '../server/today/relevance';
import { insertMemories, readMemories, readMemoryById, updateMemoryAnticipation } from '../server/db/memories';
import { executeBunnySql } from '../server/db/client';
import { CalendarEvent, MemoryItem } from '../src/types';

async function cleanupFixtures() {
  try {
    await executeBunnySql([
      { sql: `DELETE FROM memories WHERE id LIKE 'test_anticipatory_%';` },
      { sql: `DELETE FROM scheduled_reminders WHERE memoryId LIKE 'test_anticipatory_%';` }
    ]);
  } catch (err) {
    console.warn('Cleanup error (non-fatal):', err);
  }
}

async function runSuite() {
  console.log('================================================================================');
  console.log('       GLOBAL EZZYMIGO ANTICIPATORY SYSTEM — 10 REGRESSION TESTS               ');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✓ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ [FAIL] ${msg}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Undated task "Sharpen the knives" -> NONE
    // -------------------------------------------------------------------------
    console.log('[Test 1] Undated task: "Sharpen the knives" -> NONE');
    const t1Mode = classifyAnticipatoryMode({
      content: 'Sharpen the knives',
      originalText: 'Sharpen the knives',
      kind: 'reminder',
      intent: 'task',
      resurfacing: { mode: 'manual' }
    });
    assert(t1Mode === 'NONE', 'Sharpen the knives is classified as NONE');
    const t1Offer = generateAnticipationOffer({ id: '1', content: 'Sharpen the knives' }, t1Mode);
    assert(t1Offer === null, 'Sharpen the knives generates no anticipation offer');

    // -------------------------------------------------------------------------
    // TEST 2: Undated task "Trim the hedge" -> NONE
    // -------------------------------------------------------------------------
    console.log('\n[Test 2] Undated task: "Trim the hedge" -> NONE');
    const t2Mode = classifyAnticipatoryMode({
      content: 'Trim the hedge',
      originalText: 'Trim the hedge',
      kind: 'reminder',
      intent: 'task',
      resurfacing: { mode: 'manual' }
    });
    assert(t2Mode === 'NONE', 'Trim the hedge is classified as NONE');
    const t2Offer = generateAnticipationOffer({ id: '2', content: 'Trim the hedge' }, t2Mode);
    assert(t2Offer === null, 'Trim the hedge generates no anticipation offer');

    // -------------------------------------------------------------------------
    // TEST 3: Recurring routine "Visit Mum every Monday, Wednesday and Friday 9–11am" -> POST_ONLY
    // -------------------------------------------------------------------------
    console.log('\n[Test 3] Recurring routine: "Visit Mum every Monday, Wednesday and Friday 9–11am" -> POST_ONLY');
    const t3Mode = classifyAnticipatoryMode({
      content: 'Visit Mum every Monday, Wednesday and Friday 9–11am',
      originalText: 'Visit Mum every Monday, Wednesday and Friday 9–11am',
      kind: 'reminder',
      intent: 'task',
      resurfacing: { mode: 'recurring', timing: 'every Mon, Wed, Fri 9-11am' },
      people: ['Mum']
    });
    assert(t3Mode === 'POST_ONLY', 'Visit Mum recurring is classified as POST_ONLY');
    const t3Offer = generateAnticipationOffer({
      id: '3',
      content: 'Visit Mum every Monday, Wednesday and Friday 9–11am',
      people: ['Mum']
    }, t3Mode);
    assert(t3Offer !== null, 'Visit Mum generates anticipation offer');
    assert(t3Offer?.mode === 'POST_ONLY', 'Offer mode is POST_ONLY');
    assert(t3Offer?.question.includes('Mum'), 'Offer question asks about Mum');

    // -------------------------------------------------------------------------
    // TEST 4: One-off dated appointment: "Doctor appointment at 10:30am" -> PRE_AND_POST
    // -------------------------------------------------------------------------
    console.log('\n[Test 4] One-off appointment: "Doctor appointment at 10:30am" -> PRE_AND_POST');
    const t4Mode = classifyAnticipatoryMode({
      content: 'Doctor appointment at 10:30am',
      originalText: 'Doctor appointment at 10:30am',
      kind: 'reminder',
      intent: 'appointment',
      contexts: ['appointment'],
      resolved_datetime: '2026-09-07T10:30:00+10:00',
      resurfacing: { mode: 'scheduled', timing: '2026-09-07 10:30' }
    });
    assert(t4Mode === 'PRE_AND_POST', 'Doctor appointment is classified as PRE_AND_POST');
    const t4Offer = generateAnticipationOffer({
      id: '4',
      content: 'Doctor appointment at 10:30am'
    }, t4Mode);
    assert(t4Offer !== null, 'Doctor appointment generates anticipation offer');
    assert(t4Offer?.mode === 'PRE_AND_POST', 'Offer mode is PRE_AND_POST');
    assert(t4Offer?.question.includes('heads-up beforehand and check in afterward'), 'Offer asks for both heads-up and check-in');

    // -------------------------------------------------------------------------
    // TEST 5: One-off dated appointment: "Dentist checkup on Friday 2pm" -> PRE_AND_POST
    // -------------------------------------------------------------------------
    console.log('\n[Test 5] One-off appointment: "Dentist checkup on Friday 2pm" -> PRE_AND_POST');
    const t5Mode = classifyAnticipatoryMode({
      content: 'Dentist checkup on Friday 2pm',
      originalText: 'Dentist checkup on Friday 2pm',
      kind: 'reminder',
      intent: 'appointment',
      contexts: ['appointment'],
      resolved_datetime: '2026-09-11T14:00:00+10:00',
      resurfacing: { mode: 'scheduled' }
    });
    assert(t5Mode === 'PRE_AND_POST', 'Dentist checkup is classified as PRE_AND_POST');

    // -------------------------------------------------------------------------
    // TEST 6: Lifecycle Stage 1 (Upcoming):
    // POST_ONLY routine has NO preparation prompt; PRE_AND_POST appointment has preparation prompt
    // -------------------------------------------------------------------------
    console.log('\n[Test 6] Lifecycle Stage 1 (Upcoming): Routine has NO prep prompt, Appointment HAS prep prompt');
    const simulatedNow = new Date('2026-09-07T08:00:00+10:00'); // 8:00 AM before 9:00 AM event
    const routineEvent: CalendarEvent = {
      id: 'cal_visit_mum',
      source: 'google_calendar',
      source_event_id: 'ev_mum_001',
      title: 'Visit Mum',
      start_datetime: '2026-09-07T09:00:00+10:00',
      end_datetime: '2026-09-07T11:00:00+10:00',
      attendees: [],
      is_all_day: false,
      status: 'confirmed',
      updated_at: '2026-09-01T00:00:00Z',
      anticipatory_mode: 'POST_ONLY',
      anticipatory_opted_in: true,
    };
    const doctorEvent: CalendarEvent = {
      id: 'cal_doctor_appt',
      source: 'google_calendar',
      source_event_id: 'ev_dr_001',
      title: 'Dr Marning Consultation',
      start_datetime: '2026-09-07T14:00:00+10:00',
      end_datetime: '2026-09-07T14:45:00+10:00',
      attendees: [],
      is_all_day: false,
      status: 'confirmed',
      updated_at: '2026-09-01T00:00:00Z',
      anticipatory_mode: 'PRE_AND_POST',
      anticipatory_opted_in: true,
    };

    const upcomingRes = evaluateTodayRelevance(
      [],
      [routineEvent, doctorEvent],
      [],
      simulatedNow,
      'Australia/Sydney',
      '2026-09-07',
      []
    );

    const routineCandidate = upcomingRes.candidates.find(c => c.source_id === 'cal_visit_mum');
    const doctorCandidate = upcomingRes.candidates.find(c => c.source_id === 'cal_doctor_appt');

    assert(Boolean(routineCandidate), 'Routine event appears in upcoming candidates');
    assert(routineCandidate?.is_anticipatory === false, 'Routine event has is_anticipatory === false (NO preparation prompt)');
    assert(routineCandidate?.anticipatory_stage !== 'prepare', 'Routine event anticipatory_stage is NOT prepare');

    assert(Boolean(doctorCandidate), 'Doctor event appears in upcoming candidates');
    assert(doctorCandidate?.is_anticipatory === true, 'Doctor event has is_anticipatory === true');
    assert(doctorCandidate?.anticipatory_stage === 'prepare', 'Doctor event anticipatory_stage === prepare');

    // -------------------------------------------------------------------------
    // TEST 7: Lifecycle Stage 3 (Post-Event):
    // POST_ONLY routine surfaces post-event check-in prompt
    // -------------------------------------------------------------------------
    console.log('\n[Test 7] Lifecycle Stage 3 (Post-Event): POST_ONLY surfaces post-event check-in prompt');
    const simulatedPostEventNow = new Date('2026-09-07T12:00:00+10:00'); // 12:00 PM after 11:00 AM event
    const postRes = evaluateTodayRelevance(
      [],
      [routineEvent],
      [],
      simulatedPostEventNow,
      'Australia/Sydney',
      '2026-09-07',
      []
    );
    const postRoutineCandidate = postRes.candidates.find(c => c.source_id === 'cal_visit_mum');
    assert(Boolean(postRoutineCandidate), 'Routine event appears in post-event candidates');
    assert(postRoutineCandidate?.is_anticipatory === true, 'Routine event has is_anticipatory === true post-event');
    assert(postRoutineCandidate?.anticipatory_stage === 'reflect', 'Routine event has anticipatory_stage === reflect');

    // -------------------------------------------------------------------------
    // TEST 8: Explicit Opt-Out / Opt-In:
    // If anticipatory_opted_in === false, neither pre nor post prompts are generated
    // -------------------------------------------------------------------------
    console.log('\n[Test 8] Opt-Out: anticipatory_opted_in === false disables anticipatory prompts');
    const optedOutDoctor: CalendarEvent = {
      ...doctorEvent,
      id: 'cal_dr_opted_out',
      anticipatory_opted_in: false,
    };
    const optedOutUpcoming = evaluateTodayRelevance(
      [],
      [optedOutDoctor],
      [],
      simulatedNow,
      'Australia/Sydney',
      '2026-09-07',
      []
    );
    const optedOutCandidate = optedOutUpcoming.candidates.find(c => c.source_id === 'cal_dr_opted_out');
    assert(Boolean(optedOutCandidate), 'Opted out event still displays regular calendar notification');
    assert(optedOutCandidate?.is_anticipatory === false, 'Opted out event has is_anticipatory === false');
    assert(optedOutCandidate?.anticipatory_stage === undefined, 'Opted out event has no anticipatory_stage');

    // -------------------------------------------------------------------------
    // TEST 9: Occurrence Isolation:
    // Completion/dismissal of visit_mum:2026-09-07 does NOT suppress visit_mum:2026-09-09.
    // Unrelated contact/fact memories mentioning Mum do NOT count as completion.
    // -------------------------------------------------------------------------
    console.log('\n[Test 9] Occurrence Isolation & Completion Independence');
    const dismissedOccurrenceId = 'cal_visit_mum:2026-09-07';
    // Test that 2026-09-07 IS suppressed when dismissed
    const resDismissedDay = evaluateTodayRelevance(
      [],
      [routineEvent],
      [],
      simulatedPostEventNow,
      'Australia/Sydney',
      '2026-09-07',
      [dismissedOccurrenceId]
    );
    const dismissedCandidate = resDismissedDay.candidates.find(c => c.source_id === 'cal_visit_mum');
    assert(!dismissedCandidate, 'Occurrence 2026-09-07 is suppressed when dismissed');

    // Test that 2026-09-09 IS NOT suppressed by dismissed 2026-09-07
    const futureRoutineEvent: CalendarEvent = {
      ...routineEvent,
      start_datetime: '2026-09-09T09:00:00+10:00',
      end_datetime: '2026-09-09T11:00:00+10:00',
    };
    const futureSimulatedNow = new Date('2026-09-09T12:00:00+10:00');
    const resFutureDay = evaluateTodayRelevance(
      [],
      [futureRoutineEvent],
      [],
      futureSimulatedNow,
      'Australia/Sydney',
      '2026-09-09',
      [dismissedOccurrenceId] // Only 2026-09-07 is dismissed!
    );
    const futureCandidate = resFutureDay.candidates.find(c => c.source_id === 'cal_visit_mum');
    assert(Boolean(futureCandidate), 'Occurrence 2026-09-09 is NOT suppressed by 2026-09-07 dismissal');

    // Verify unrelated contact/fact memories mentioning Mum do not count as completion
    const unrelatedFactMemory: MemoryItem = {
      id: 'mem_mum_fact',
      originalText: "Mum's phone number is 0412 345 678 and she loves red roses",
      createdAt: '2026-09-07T11:30:00Z',
      isDone: false,
      interpretation: {
        kind: 'fact',
        intent: 'fact',
        content: "Mum's phone number is 0412 345 678 and she loves red roses",
        people: ['Mum'],
        places: [],
        topics: ['Mum', 'contact'],
        status: 'active',
        resurfacing: { mode: 'manual', timing: '' }
      }
    };
    const hasFalseCompletion = hasCompletedReflectionForEvent(
      routineEvent,
      [unrelatedFactMemory],
      [],
      [],
      'Australia/Sydney',
      '2026-09-07'
    );
    assert(hasFalseCompletion === false, 'Unrelated fact memory mentioning Mum does NOT count as completion');

    // -------------------------------------------------------------------------
    // TEST 10: SQLite Database Persistence
    // Memory items saved with anticipatory_mode and anticipatory_opted_in round-trip faithfully
    // -------------------------------------------------------------------------
    console.log('\n[Test 10] SQLite Database Persistence: anticipatory_mode & anticipatory_opted_in');
    await cleanupFixtures();

    const testMem: MemoryItem = {
      id: 'test_anticipatory_mem_1',
      originalText: 'Visit Mum every Monday, Wednesday and Friday 9–11am',
      createdAt: new Date().toISOString(),
      isDone: false,
      anticipatory_mode: 'POST_ONLY',
      anticipatory_opted_in: true,
      interpretation: {
        kind: 'reminder',
        intent: 'task',
        status: 'active',
        content: 'Visit Mum every Monday, Wednesday and Friday 9–11am',
        people: ['Mum'],
        places: [],
        topics: ['routine'],
        resurfacing: { mode: 'recurring', timing: 'every Mon, Wed, Fri 9-11am' },
        anticipatory_mode: 'POST_ONLY',
        anticipatory_opted_in: true
      }
    };

    await insertMemories([testMem]);

    const fetched = await readMemoryById('test_anticipatory_mem_1');
    assert(fetched !== null, 'Memory was successfully persisted to SQLite');
    assert(fetched?.anticipatory_mode === 'POST_ONLY', 'Fetched anticipatory_mode matches POST_ONLY');
    assert(fetched?.anticipatory_opted_in === true, 'Fetched anticipatory_opted_in matches true');

    // Update anticipatory preference
    await updateMemoryAnticipation('test_anticipatory_mem_1', 'POST_ONLY', false);
    const updated = await readMemoryById('test_anticipatory_mem_1');
    assert(updated?.anticipatory_opted_in === false, 'Updated anticipatory_opted_in is now false');

    await cleanupFixtures();

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------
    console.log('\n================================================================================');
    console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
    console.log('================================================================================');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Test execution exception:', err);
    await cleanupFixtures();
    process.exit(1);
  }
}

runSuite();

import { buildDynamicRetrievalContext, detectGenericScheduleIntent } from '../server/retrieval/dcr';
import { upsertCalendarEvents, readCalendarEvents } from '../server/calendar/store';
import { executeBunnySql } from '../server/db/client';

async function cleanupCalendarRegressionFixtures() {
  try {
    await executeBunnySql([
      { sql: `DELETE FROM calendar_events WHERE id IN ('cal_google_drmarning123', 'cal_google_dentist456');` }
    ]);
  } catch (err) {
    console.warn('[Calendar Regression] Error cleaning up test fixtures:', err);
  }
}

async function runTests() {
  console.log('================================================================================');
  console.log('  CLASS B — INTEGRATION PASS: LOCAL CALENDAR STORE & DCR RETRIEVAL (FIXTURES)  ');
  console.log('  Note: Proves backend SQLite store & query logic with synthetic fixture events.');
  console.log('  Does NOT prove live Google Calendar OAuth, API sync, or browser ingestion.');
  console.log('  Live external Google Calendar verification requires CLASS A live observation.');
  console.log('================================================================================\n');

  try {
    // Test 1: detectGenericScheduleIntent
    console.log('\n[Test 1] detectGenericScheduleIntent testing:');
    const genericQueries = [
      'What appointments have I got coming up?',
      "What's on my calendar?",
      'What do I have scheduled for next week?',
      'What meetings do I have?',
      'What am I doing today?',
      'What have I got coming up?'
    ];
    for (const q of genericQueries) {
      const isGeneric = detectGenericScheduleIntent(q.toLowerCase());
      console.log(`  Query: "${q}" -> isGeneric: ${isGeneric}`);
      if (!isGeneric) {
        throw new Error(`Expected query "${q}" to be detected as generic schedule intent`);
      }
    }

    // Test 2: Ensure Dr Marning (Sept 7, 2026) is stored in calendar_events
    console.log('\n[Test 2] Storing Dr Marning event in local calendar_events store:');
    const sampleDrMarningEvent = {
      id: 'cal_google_drmarning123',
      source: 'google_calendar',
      source_event_id: 'drmarning123',
      title: 'Dr Marning',
      description: 'Routine checkup and consultation',
      location: '6296 2266 Clinic',
      attendees: ['user@example.com', 'drmarning@clinic.com'],
      start_datetime: '2026-09-07T15:30:00+10:00',
      end_datetime: '2026-09-07T16:15:00+10:00',
      is_all_day: false,
      status: 'confirmed',
      updated_at: '2026-08-28T09:00:00Z'
    };

    const sampleDentistEvent = {
      id: 'cal_google_dentist456',
      source: 'google_calendar',
      source_event_id: 'dentist456',
      title: 'Dentist Checkup',
      description: 'Clean and scale',
      location: 'Dental Surgery',
      attendees: [],
      start_datetime: '2026-09-14T10:00:00+10:00',
      end_datetime: '2026-09-14T11:00:00+10:00',
      is_all_day: false,
      status: 'confirmed',
      updated_at: '2026-08-28T09:00:00Z'
    };

    await upsertCalendarEvents([sampleDrMarningEvent, sampleDentistEvent]);
    const storedEvents = await readCalendarEvents();
    console.log(`  Stored ${storedEvents.length} events in local calendar_events table.`);
    const foundMarning = storedEvents.find(e => e.title === 'Dr Marning');
    if (!foundMarning) {
      throw new Error('Dr Marning event was not found in calendar_events table');
    }
    console.log(`  Found: ${foundMarning.title} on ${foundMarning.start_datetime}`);

    // Test Memories
    const sampleMemories = [
      {
        id: 'mem_dr_phone',
        originalText: 'Dr Marning phone number is 6296 2266',
        createdAt: '2026-08-20T10:00:00Z',
        interpretation: {
          kind: 'fact',
          subject: 'Dr Marning',
          people: ['Dr Marning'],
          topics: ['medical', 'phone', 'contact'],
          retrieval_cues: ['doctor', 'phone', 'number', 'marning', '6296 2266'],
          content: 'Dr Marning phone number is 6296 2266'
        }
      },
      {
        id: 'mem_david_scientist',
        originalText: 'David is my scientist',
        createdAt: '2026-08-22T10:00:00Z',
        interpretation: {
          kind: 'fact',
          subject: 'David',
          people: ['David'],
          relationship_role: 'scientist',
          topics: ['roles', 'scientist'],
          retrieval_cues: ['david', 'scientist'],
          content: 'David is my scientist'
        }
      },
      {
        id: 'mem_car_key',
        originalText: 'Spare car key is in the kitchen drawer',
        createdAt: '2026-08-24T10:00:00Z',
        interpretation: {
          kind: 'fact',
          subject: 'Spare car key',
          people: [],
          topics: ['keys', 'kitchen', 'drawer'],
          retrieval_cues: ['spare', 'car key', 'kitchen drawer'],
          content: 'Spare car key is in the kitchen drawer'
        }
      }
    ];

    const localContext = {
      language: 'en-AU',
      region: 'AU',
      timeZone: 'Australia/Sydney',
      localDateTimeStr: 'Friday 28 August 2026, 1:20 pm',
      weekday: 'Friday',
      referenceDate: new Date('2026-08-28T13:20:00+10:00'),
      offsetStr: '+10:00',
      utcIso: '2026-08-28T03:20:00.000Z'
    };

    const activeRelationships: any[] = [];

    // Test 3: Generic schedule query "What appointments have I got coming up?"
    console.log('\n[Test 3] Testing generic schedule query: "What appointments have I got coming up?"');
    const dcrGeneric = buildDynamicRetrievalContext(
      'What appointments have I got coming up?',
      sampleMemories,
      storedEvents,
      activeRelationships,
      localContext
    );

    console.log(`  Candidate calendar events returned: ${dcrGeneric.candidateCalendarEvents.length}`);
    console.log(`  Candidate memory events returned: ${dcrGeneric.candidateMemories.length}`);
    const hasMarningInGeneric = dcrGeneric.candidateCalendarEvents.some(e => e.title === 'Dr Marning');
    if (!hasMarningInGeneric) {
      throw new Error('FAILED: Dr Marning event was NOT included in candidate calendar events for generic schedule query!');
    }
    console.log('  PASSED: Dr Marning event is included in generic query candidates.');

    // Test 4: Specific query "When am I seeing Dr Marning?"
    console.log('\n[Test 4] Testing specific query: "When am I seeing Dr Marning?"');
    const dcrSpecific = buildDynamicRetrievalContext(
      'When am I seeing Dr Marning?',
      sampleMemories,
      storedEvents,
      activeRelationships,
      localContext
    );

    console.log(`  Candidate calendar events returned: ${dcrSpecific.candidateCalendarEvents.length}`);
    const hasMarningInSpecific = dcrSpecific.candidateCalendarEvents.some(e => e.title === 'Dr Marning');
    if (!hasMarningInSpecific) {
      throw new Error('FAILED: Dr Marning event was NOT included in candidate calendar events for specific query!');
    }
    console.log('  PASSED: Dr Marning event is included in specific query candidates.');

    // Test 5: Chronological ordering on generic schedule query
    console.log('\n[Test 5] Checking chronological ordering of generic schedule query candidates:');
    const dcrOrder = buildDynamicRetrievalContext(
      "What's on my calendar?",
      sampleMemories,
      storedEvents,
      activeRelationships,
      localContext
    );
    console.log('  Ordered events:', dcrOrder.candidateCalendarEvents.map(e => `${e.title} (${e.start_datetime})`));
    if (dcrOrder.candidateCalendarEvents.length >= 2) {
      const t0 = new Date(dcrOrder.candidateCalendarEvents[0].start_datetime).getTime();
      const t1 = new Date(dcrOrder.candidateCalendarEvents[1].start_datetime).getTime();
      if (t0 > t1) {
        throw new Error('FAILED: Candidate calendar events are not in chronological order');
      }
    }
    console.log('  PASSED: Events are sorted chronologically.');

    // Test 6: Non-calendar query "Who is my scientist?"
    console.log('\n[Test 6] Testing non-calendar query: "Who is my scientist?"');
    const dcrScientist = buildDynamicRetrievalContext(
      'Who is my scientist?',
      sampleMemories,
      storedEvents,
      activeRelationships,
      localContext
    );
    console.log(`  Candidate calendar events: ${dcrScientist.candidateCalendarEvents.length}`);
    console.log(`  Candidate memories: ${dcrScientist.candidateMemories.map(m => m.originalText)}`);
    if (dcrScientist.candidateCalendarEvents.length !== 0) {
      throw new Error('FAILED: Non-calendar query should NOT return candidate calendar events');
    }
    if (!dcrScientist.candidateMemories.some(m => m.id === 'mem_david_scientist')) {
      throw new Error('FAILED: Scientist memory was not retrieved');
    }
    console.log('  PASSED: Non-calendar query returned David scientist memory and 0 calendar events.');

    // Test 7: Non-calendar query "Where is the spare car key?"
    console.log('\n[Test 7] Testing non-calendar query: "Where is the spare car key?"');
    const dcrKey = buildDynamicRetrievalContext(
      'Where is the spare car key?',
      sampleMemories,
      storedEvents,
      activeRelationships,
      localContext
    );
    console.log(`  Candidate calendar events: ${dcrKey.candidateCalendarEvents.length}`);
    console.log(`  Candidate memories: ${dcrKey.candidateMemories.map(m => m.originalText)}`);
    if (dcrKey.candidateCalendarEvents.length !== 0) {
      throw new Error('FAILED: Non-calendar query should NOT return candidate calendar events');
    }
    if (!dcrKey.candidateMemories.some(m => m.id === 'mem_car_key')) {
      throw new Error('FAILED: Car key memory was not retrieved');
    }
    console.log('  PASSED: Non-calendar query returned car key memory and 0 calendar events.');

    console.log('\n================================================================================');
    console.log('  CLASS B — INTEGRATION TESTS PASSED (100%) [Synthetic Local Store Fixtures]');
    console.log('  Live Google Calendar verification status: PENDING CLASS A USER OBSERVATION');
    console.log('================================================================================\n');
  } finally {
    console.log('--- Cleaning up calendar regression fixtures ---');
    await cleanupCalendarRegressionFixtures();
    console.log('✅ Calendar regression test fixtures cleaned up.');
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

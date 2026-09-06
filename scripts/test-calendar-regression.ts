import { buildDynamicRetrievalContext, detectGenericScheduleIntent, detectHistoricalCalendarIntent } from '../server/retrieval/dcr';
import { upsertCalendarEvents, readCalendarEvents, queryCalendarEvents } from '../server/calendar/store';
import { getCalendarAdapter, googleCalendarAdapter, appleCalendarAdapter } from '../server/calendar/adapter';
import { executeBunnySql } from '../server/db/client';

const TEST_EZZY_ID = 'test_ezzy_calendar_reg';
const OTHER_EZZY_ID = 'test_ezzy_calendar_other';

async function cleanupCalendarRegressionFixtures() {
  try {
    await executeBunnySql([
      {
        sql: `DELETE FROM calendar_events WHERE ezzy_id IN (?, ?) OR id LIKE 'cal_google_drmarning%' OR id LIKE 'cal_apple_%';`,
        args: [TEST_EZZY_ID, OTHER_EZZY_ID]
      }
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

    const sampleDrMarningAug5 = {
      id: 'cal_google_drmarning_aug5',
      source: 'google_calendar',
      source_event_id: 'drmarning_aug5',
      title: 'Dr Marning Checkup',
      description: 'Initial blood pressure check',
      location: '6296 2266 Clinic',
      attendees: ['user@example.com', 'drmarning@clinic.com'],
      start_datetime: '2026-08-05T10:00:00+10:00',
      end_datetime: '2026-08-05T10:45:00+10:00',
      is_all_day: false,
      status: 'confirmed',
      updated_at: '2026-08-05T11:00:00Z'
    };

    const sampleDrMarningAug19 = {
      id: 'cal_google_drmarning_aug19',
      source: 'google_calendar',
      source_event_id: 'drmarning_aug19',
      title: 'Dr Marning Follow-up',
      description: 'Review pathology results',
      location: '6296 2266 Clinic',
      attendees: ['user@example.com', 'drmarning@clinic.com'],
      start_datetime: '2026-08-19T14:00:00+10:00',
      end_datetime: '2026-08-19T14:30:00+10:00',
      is_all_day: false,
      status: 'confirmed',
      updated_at: '2026-08-19T15:00:00Z'
    };

    const sampleDrMarningJul10 = {
      id: 'cal_google_drmarning_jul10',
      source: 'google_calendar',
      source_event_id: 'drmarning_jul10',
      title: 'Dr Marning Consultation',
      description: 'Mid-year health plan',
      location: '6296 2266 Clinic',
      attendees: ['user@example.com', 'drmarning@clinic.com'],
      start_datetime: '2026-07-10T11:00:00+10:00',
      end_datetime: '2026-07-10T11:30:00+10:00',
      is_all_day: false,
      status: 'confirmed',
      updated_at: '2026-07-10T12:00:00Z'
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

    await upsertCalendarEvents([
      sampleDrMarningEvent,
      sampleDrMarningAug5,
      sampleDrMarningAug19,
      sampleDrMarningJul10,
      sampleDentistEvent
    ], TEST_EZZY_ID);
    const storedEvents = await readCalendarEvents({}, TEST_EZZY_ID);
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

    // Test 8: LAST occurrence returns the latest past matching event
    console.log('\n[Test 8] Testing LAST occurrence: "When was my last appointment with Dr Marning?"');
    const dcrLast = buildDynamicRetrievalContext(
      'When was my last appointment with Dr Marning?',
      sampleMemories,
      storedEvents,
      activeRelationships,
      localContext
    );
    console.log(`  Candidate calendar events: ${dcrLast.candidateCalendarEvents.length}`);
    console.log('  Candidate events:', dcrLast.candidateCalendarEvents.map(e => `${e.title} (${e.start_datetime})`));
    if (dcrLast.candidateCalendarEvents.length === 0) {
      throw new Error('FAILED: LAST occurrence query returned no events!');
    }
    const firstLastEvent = dcrLast.candidateCalendarEvents[0];
    if (!firstLastEvent.start_datetime.startsWith('2026-08-19')) {
      throw new Error(`FAILED: Expected latest past appointment (2026-08-19) to be first, got: ${firstLastEvent.start_datetime} (${firstLastEvent.title})`);
    }
    console.log('  PASSED: Latest past appointment (2026-08-19) is returned first.');

    // Test 9: LAST never returns a future matching event
    console.log('\n[Test 9] Verifying LAST query NEVER returns a future matching event:');
    const hasFutureInLast = dcrLast.candidateCalendarEvents.some(e => {
      const t = new Date(e.start_datetime).getTime();
      return t > localContext.referenceDate.getTime() || e.start_datetime.startsWith('2026-09');
    });
    if (hasFutureInLast) {
      throw new Error('FAILED: LAST occurrence query returned future event(s)!');
    }
    console.log('  PASSED: Future events (e.g. Sept 7 Dr Marning) are strictly excluded from LAST query candidates.');

    // Test 10: NEXT occurrence still works and returns earliest upcoming event
    console.log('\n[Test 10] Testing NEXT occurrence: "What is my next appointment with Dr Marning?"');
    const dcrNext = buildDynamicRetrievalContext(
      'What is my next appointment with Dr Marning?',
      sampleMemories,
      storedEvents,
      activeRelationships,
      localContext
    );
    console.log(`  Candidate calendar events: ${dcrNext.candidateCalendarEvents.length}`);
    console.log('  Candidate events:', dcrNext.candidateCalendarEvents.map(e => `${e.title} (${e.start_datetime})`));
    if (dcrNext.candidateCalendarEvents.length === 0) {
      throw new Error('FAILED: NEXT occurrence query returned no events!');
    }
    const firstNextEvent = dcrNext.candidateCalendarEvents[0];
    if (!firstNextEvent.start_datetime.startsWith('2026-09-07')) {
      throw new Error(`FAILED: Expected earliest upcoming appointment (2026-09-07) to be first, got: ${firstNextEvent.start_datetime} (${firstNextEvent.title})`);
    }
    console.log('  PASSED: Earliest upcoming appointment (2026-09-07) is returned first for NEXT query.');

    // Test 11: Bounded count query returns correct number and excludes events outside requested range
    console.log('\n[Test 11] Testing bounded count query: "How many times did I see Dr Marning in August?"');
    const dcrCount = buildDynamicRetrievalContext(
      'How many times did I see Dr Marning in August?',
      sampleMemories,
      storedEvents,
      activeRelationships,
      localContext
    );
    console.log(`  Candidate calendar events in August: ${dcrCount.candidateCalendarEvents.length}`);
    console.log('  Candidates:', dcrCount.candidateCalendarEvents.map(e => `${e.title} (${e.start_datetime})`));
    if (dcrCount.candidateCalendarEvents.length !== 2) {
      throw new Error(`FAILED: Expected exactly 2 Dr Marning events in August, got: ${dcrCount.candidateCalendarEvents.length}`);
    }
    const hasJul = dcrCount.candidateCalendarEvents.some(e => e.start_datetime.startsWith('2026-07'));
    const hasSep = dcrCount.candidateCalendarEvents.some(e => e.start_datetime.startsWith('2026-09'));
    if (hasJul || hasSep) {
      throw new Error('FAILED: Events outside requested August range were included!');
    }
    console.log('  PASSED: Bounded count query returns exactly 2 events; July and September events are excluded.');

    // Test 12: Calendar events remain separate from memories
    console.log('\n[Test 12] Verifying calendar events and memories remain strictly separate:');
    const allCalEventsHaveSource = dcrGeneric.candidateCalendarEvents.every(e => 'source' in e && 'start_datetime' in e);
    const noCalEventHasInterpretation = dcrGeneric.candidateCalendarEvents.every(e => !('interpretation' in e));
    const allMemoriesHaveOriginalText = dcrGeneric.candidateMemories.every(m => 'originalText' in m);
    const noMemoryHasStartDatetime = dcrGeneric.candidateMemories.every(m => !('start_datetime' in m));
    if (!allCalEventsHaveSource || !noCalEventHasInterpretation || !allMemoriesHaveOriginalText || !noMemoryHasStartDatetime) {
      throw new Error('FAILED: Memory and Calendar models are cross-contaminated!');
    }
    console.log('  PASSED: Calendar events and memories remain completely separate structures.');

    // Test 13: ezzy_id scoping remains intact
    console.log('\n[Test 13] Verifying ezzy_id scoping in calendar storage:');
    const otherEzzyEvent = {
      id: 'cal_google_other_event_999',
      source: 'google_calendar',
      source_event_id: 'other_event_999',
      title: 'Secret Meeting Other Ezzy',
      start_datetime: '2026-09-08T10:00:00+10:00',
      is_all_day: false,
      status: 'confirmed',
      updated_at: '2026-08-28T09:00:00Z'
    };
    await upsertCalendarEvents([otherEzzyEvent], OTHER_EZZY_ID);
    const testEzzyEvents = await readCalendarEvents({}, TEST_EZZY_ID);
    const otherEzzyEvents = await readCalendarEvents({}, OTHER_EZZY_ID);
    if (testEzzyEvents.some(e => e.title === 'Secret Meeting Other Ezzy')) {
      throw new Error('FAILED: Event belonging to OTHER_EZZY_ID leaked into TEST_EZZY_ID query!');
    }
    if (!otherEzzyEvents.some(e => e.title === 'Secret Meeting Other Ezzy')) {
      throw new Error('FAILED: OTHER_EZZY_ID query did not return its own event!');
    }
    console.log('  PASSED: ezzy_id scoping strictly isolates calendar events between distinct Ezzy IDs.');

    // Test 14: Minimal Calendar Adapter Contract (Flutter-ready)
    console.log('\n[Test 14] Testing Minimal Calendar Adapter Contract:');
    const googleAdapter = getCalendarAdapter('google_calendar');
    const appleAdapter = getCalendarAdapter('apple_calendar');
    const deviceAdapter = getCalendarAdapter('device_calendar');

    if (!googleAdapter || !appleAdapter || !deviceAdapter) {
      throw new Error('FAILED: Calendar adapters could not be instantiated');
    }

    const rawAppleEvent = {
      source: 'apple_calendar',
      sourceEventId: 'apple_ev_123',
      title: 'Apple Health Check',
      description: 'Annual health sync',
      location: 'Apple Clinic',
      attendees: ['apple_user@icloud.com'],
      start_datetime: '2026-08-15T09:00:00Z',
      end_datetime: '2026-08-15T09:30:00Z',
      is_all_day: false,
      status: 'confirmed'
    };
    const normalizedApple = appleAdapter.normalize(rawAppleEvent);
    if (normalizedApple.source !== 'apple_calendar' || !normalizedApple.id || normalizedApple.title !== 'Apple Health Check') {
      throw new Error('FAILED: Apple calendar event normalization failed');
    }

    // Sync via adapter
    const syncRes = await appleAdapter.syncEvents([normalizedApple], TEST_EZZY_ID);
    if (!syncRes.success || syncRes.count !== 1) {
      throw new Error('FAILED: Apple calendar adapter syncEvents failed');
    }

    const queriedApple = await appleAdapter.queryEvents({ textMatch: 'Apple Health Check' }, TEST_EZZY_ID);
    if (queriedApple.length === 0 || queriedApple[0].source !== 'apple_calendar') {
      throw new Error('FAILED: Apple calendar adapter queryEvents failed');
    }
    console.log('  PASSED: Provider-independent CalendarAdapter contract normalizes, syncs, queries, and maintains provider identity.');

    console.log('\n================================================================================');
    console.log('  PRE-FLUTTER GATE 3 — CALENDAR INTELLIGENCE CLOSURE VERIFIED (14/14 PASSED)');
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

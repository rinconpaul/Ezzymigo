import { initBunnyDb } from '../server/db/schema.js';
import { executeBunnySql } from '../server/db/client.js';
import { canonicalizeCalendarEvent, upsertCalendarEvents, readCalendarEvents } from '../server/calendar/store.js';

async function runCalendarIdempotencyTest() {
  console.log('================================================================================');
  console.log('  TEST: GOOGLE CALENDAR IDENTITY CANONICALIZATION & UPSERT IDEMPOTENCY        ');
  console.log('================================================================================\n');

  await initBunnyDb();

  // Test 1: Canonical rule computation unit tests
  console.log('1. Canonical identity derivation checks:');
  const ev1 = {
    source: 'google_calendar',
    source_event_id: 'peasther@optusnet.com.au#c4qjid3274pmab9k6himab9k6gp30bb26koj2b9g6cp3ap1lcgq38ob4cc_20260829T223000Z',
    title: "Tegan's Birthday",
  };
  const c1 = canonicalizeCalendarEvent(ev1);
  console.log(`   - Input: sourceEventId with email prefix`);
  console.log(`     Output ID: ${c1.id}`);
  console.log(`     Output sourceEventId: ${c1.sourceEventId}`);
  const test1Passed = c1.id.startsWith('cal_google_peasther_optusnet_com_au_c4qjid') && c1.sourceEventId === ev1.source_event_id;
  console.log(`     Test 1 ${test1Passed ? 'PASSED' : 'FAILED'}\n`);

  // Test 2: Primary calendar prefix
  const ev2 = {
    source: 'google_calendar',
    source_event_id: 'primary#event_xyz_123',
    title: 'Dentist',
  };
  const c2 = canonicalizeCalendarEvent(ev2);
  const test2Passed = c2.id === 'cal_google_primary_event_xyz_123' && c2.sourceEventId === 'primary#event_xyz_123';
  console.log(`2. Primary prefix test: ID=${c2.id} -> ${test2Passed ? 'PASSED' : 'FAILED'}\n`);

  // Test 3: Multiple calendars with same raw item ID do NOT collide
  const calA = {
    source: 'google_calendar',
    source_event_id: 'personal@gmail.com#event_shared_id',
    title: 'Personal Lunch',
  };
  const calB = {
    source: 'google_calendar',
    source_event_id: 'work@corp.com#event_shared_id',
    title: 'Work Lunch',
  };
  const cA = canonicalizeCalendarEvent(calA);
  const cB = canonicalizeCalendarEvent(calB);
  const test3Passed = cA.id !== cB.id && cA.id.includes('personal_gmail_com') && cB.id.includes('work_corp_com');
  console.log(`3. Multi-calendar isolation test:`);
  console.log(`   CalA ID: ${cA.id}`);
  console.log(`   CalB ID: ${cB.id}`);
  console.log(`   Isolation ${test3Passed ? 'PASSED' : 'FAILED'}\n`);

  // Test 4: Database repeated upsert idempotency
  console.log('4. Database repeated upsert idempotency test:');
  const testEventPayload = {
    source: 'google_calendar',
    source_event_id: 'test_calendar_sync@example.com#event_idempotent_test_999',
    title: 'Idempotency Test Event',
    description: 'Initial description',
    start_datetime: '2026-09-20T10:00:00+10:00',
    end_datetime: '2026-09-20T11:00:00+10:00',
    is_all_day: false,
    status: 'confirmed',
  };

  // Clean up any prior test row
  await executeBunnySql([{ sql: `DELETE FROM calendar_events WHERE sourceEventId LIKE '%event_idempotent_test_999';` }]);

  // Upsert 1st time
  await upsertCalendarEvents([testEventPayload]);
  const rows1 = await executeBunnySql([{ sql: `SELECT id, title, description FROM calendar_events WHERE sourceEventId = ?;`, args: [testEventPayload.source_event_id] }]);
  const count1 = rows1[0]?.rows?.length || 0;
  console.log(`   After 1st upsert: found ${count1} row(s). ID: ${rows1[0]?.rows?.[0]?.id}`);

  // Upsert 2nd time (with updated description)
  const updatedPayload = {
    ...testEventPayload,
    description: 'Updated description on repeated sync',
  };
  await upsertCalendarEvents([updatedPayload]);
  const rows2 = await executeBunnySql([{ sql: `SELECT id, title, description FROM calendar_events WHERE sourceEventId = ?;`, args: [testEventPayload.source_event_id] }]);
  const count2 = rows2[0]?.rows?.length || 0;
  const desc2 = rows2[0]?.rows?.[0]?.description;
  console.log(`   After 2nd upsert: found ${count2} row(s). Updated Description: "${desc2}"`);

  // Upsert 3rd time (without explicit id in object, relying on canonicalization)
  await upsertCalendarEvents([{
    source: 'google_calendar',
    source_event_id: testEventPayload.source_event_id,
    title: 'Idempotency Test Event (3rd pass)',
    start_datetime: '2026-09-20T10:00:00+10:00',
  }]);
  const rows3 = await executeBunnySql([{ sql: `SELECT id, title, description FROM calendar_events WHERE sourceEventId = ?;`, args: [testEventPayload.source_event_id] }]);
  const count3 = rows3[0]?.rows?.length || 0;
  console.log(`   After 3rd upsert: found ${count3} row(s). Title: "${rows3[0]?.rows?.[0]?.title}"`);

  const test4Passed = count1 === 1 && count2 === 1 && count3 === 1 && desc2 === 'Updated description on repeated sync';
  console.log(`   Idempotency ${test4Passed ? 'PASSED (Zero duplicate rows created)' : 'FAILED'}\n`);

  // Clean up test rows
  await executeBunnySql([{ sql: `DELETE FROM calendar_events WHERE sourceEventId LIKE '%event_idempotent_test_999';` }]);

  const allPassed = test1Passed && test2Passed && test3Passed && test4Passed;
  console.log('================================================================================');
  console.log(`  ALL CALENDAR IDEMPOTENCY TESTS: ${allPassed ? 'PASSED' : 'FAILED'}`);
  console.log('================================================================================');

  if (!allPassed) {
    process.exit(1);
  }
}

runCalendarIdempotencyTest().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

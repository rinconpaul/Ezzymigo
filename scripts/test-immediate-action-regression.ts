import { executeBunnySql } from '../server/db/client';
import { initBunnyDb } from '../server/db/schema';
import { saveUserEntity, saveRelationships } from '../server/relationships/index';
import { routeUserIntent } from '../server/intent/router';
import { resolveContactAction, resolveContactQuery } from '../server/contacts/resolver';
import { getGeminiClient } from '../server/config/gemini';

const BASE_URL = 'http://localhost:3000';

interface ScenarioResult {
  scenario: number;
  name: string;
  passed: boolean;
  details: string;
}

const results: ScenarioResult[] = [];

async function cleanupFixtures() {
  console.log('[Cleanup] Removing all test fixtures from database...');
  await initBunnyDb();
  await executeBunnySql([
    {
      sql: `DELETE FROM user_entities WHERE name LIKE 'Test_%';`,
      args: [],
    },
    {
      sql: `DELETE FROM user_relationships WHERE person LIKE 'Test_%';`,
      args: [],
    },
    {
      sql: `DELETE FROM memories WHERE content LIKE '%Test_%' OR originalText LIKE '%Test_%';`,
      args: [],
    },
    {
      sql: `DELETE FROM scheduled_reminders WHERE title LIKE '%Test_%' OR body LIKE '%Test_%';`,
      args: [],
    },
    {
      sql: `DELETE FROM calendar_events WHERE title LIKE '%Test_%';`,
      args: [],
    },
  ]);
  console.log('[Cleanup] Done.');
}


async function setupFixtures() {
  console.log('[Setup] Inserting isolated test fixtures...');
  await cleanupFixtures();

  // 1. Test_Fred (electrician with phone)
  await saveRelationships([{
    person: 'Test_Fred',
    role: 'electrician',
    is_active: true,
  }]);
  await saveUserEntity({
    name: 'Test_Fred',
    entity_type: 'person',
    role: 'electrician',
    normalized_role: 'electrician',
    metadata: { phone: '0412 345 678' },
  });

  // 2. Test_Sarah (sister without phone)
  await saveRelationships([{
    person: 'Test_Sarah',
    role: 'sister',
    is_active: true,
  }]);
  await saveUserEntity({
    name: 'Test_Sarah',
    entity_type: 'person',
    role: 'sister',
    normalized_role: 'sister',
    metadata: {},
  });

  // 3. Ambiguous Johns: Test_John Miller (plumber) and Test_John Davis (builder)
  await saveRelationships([
    {
      person: 'Test_John Miller',
      role: 'plumber',
      is_active: true,
    },
    {
      person: 'Test_John Davis',
      role: 'builder',
      is_active: true,
    },
  ]);
  await saveUserEntity({
    name: 'Test_John Miller',
    entity_type: 'person',
    role: 'plumber',
    normalized_role: 'plumber',
    metadata: { phone: '0411 111 111' },
  });
  await saveUserEntity({
    name: 'Test_John Davis',
    entity_type: 'person',
    role: 'builder',
    normalized_role: 'builder',
    metadata: { phone: '0422 222 222' },
  });

  // 4. Calendar event with attendee/title "Dinner with Test_CalendarGuest" (no relationship/phone)
  await executeBunnySql([{
    sql: `INSERT INTO calendar_events (id, source, sourceEventId, title, startDatetime, endDatetime, isAllDay, status, updatedAt)
          VALUES ('cal_test_guest', 'google_calendar', 'evt_test_guest', 'Dinner with Test_CalendarGuest', '2026-09-10 19:00:00', '2026-09-10 21:00:00', 0, 'confirmed', '2026-09-03T10:00:00.000Z');`,
    args: [],
  }]);


  console.log('[Setup] Test fixtures successfully provisioned.');
}

async function countMemoriesWithPattern(pattern: string): Promise<number> {
  const rows = await executeBunnySql([{
    sql: `SELECT COUNT(*) as cnt FROM memories WHERE originalText LIKE ? OR content LIKE ?;`,
    args: [`%${pattern}%`, `%${pattern}%`],
  }]);
  return Number(rows[0]?.rows?.[0]?.cnt || 0);
}


async function runRegressionMatrix() {
  console.log('================================================================================');
  console.log('       EZZYMIGO CONTACT INTENT & IMMEDIATE ACTION REGRESSION MATRIX             ');
  console.log('================================================================================\n');

  try {
    await setupFixtures();

    const ai = getGeminiClient();

    // -------------------------------------------------------------
    // Scenario 1: Immediate Call with known person & phone ("Ring Test_Fred")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 1: Immediate Call ("Ring Test_Fred") ---');
    const initialMemCount1 = await countMemoriesWithPattern('Test_Fred');
    const res1 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Ring Test_Fred',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data1 = await res1.json();
    const finalMemCount1 = await countMemoriesWithPattern('Test_Fred');
    const noMemoriesPersisted1 = initialMemCount1 === finalMemCount1;
    const isReadyCall1 =
      data1.deviceAction?.status === 'ready' &&
      data1.deviceAction?.action === 'call' &&
      data1.deviceAction?.recipientName === 'Test_Fred' &&
      data1.deviceAction?.sanitizedPhone === '0412345678';

    const pass1 = isReadyCall1 && noMemoriesPersisted1;
    results.push({
      scenario: 1,
      name: 'Immediate Call with known person & phone ("Ring Test_Fred")',
      passed: pass1,
      details: `Status: ${data1.deviceAction?.status}, Action: ${data1.deviceAction?.action}, Phone: ${data1.deviceAction?.phoneNumber}, Memories persisted: ${finalMemCount1 - initialMemCount1}`,
    });
    console.log(`Scenario 1: ${pass1 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 2: Immediate Call with known role & phone ("Ring my electrician")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 2: Immediate Call by role ("Ring my electrician") ---');
    const res2 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Ring my electrician',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data2 = await res2.json();
    const isReadyRoleCall2 =
      data2.deviceAction?.status === 'ready' &&
      data2.deviceAction?.action === 'call' &&
      data2.deviceAction?.recipientName === 'Test_Fred' &&
      data2.deviceAction?.phoneNumber === '0412 345 678';

    results.push({
      scenario: 2,
      name: 'Immediate Call by role ("Ring my electrician")',
      passed: Boolean(isReadyRoleCall2),
      details: `Status: ${data2.deviceAction?.status}, Recipient: ${data2.deviceAction?.recipientName}, Phone: ${data2.deviceAction?.phoneNumber}`,
    });
    console.log(`Scenario 2: ${isReadyRoleCall2 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 3: Immediate Text with known person ("Text Test_Fred")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 3: Immediate Text ("Text Test_Fred") ---');
    const res3 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Text Test_Fred',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data3 = await res3.json();
    const isReadySms3 =
      data3.deviceAction?.status === 'ready' &&
      data3.deviceAction?.action === 'sms' &&
      data3.deviceAction?.recipientName === 'Test_Fred';

    results.push({
      scenario: 3,
      name: 'Immediate Text with known person ("Text Test_Fred")',
      passed: Boolean(isReadySms3),
      details: `Status: ${data3.deviceAction?.status}, Action: ${data3.deviceAction?.action}, Recipient: ${data3.deviceAction?.recipientName}`,
    });
    console.log(`Scenario 3: ${isReadySms3 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 4: Immediate Text with prefilled message ("Text Test_Fred I'm running late")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 4: Immediate Text with message ("Text Test_Fred I\'m running late") ---');
    const res4 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: "Text Test_Fred I'm running late",
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data4 = await res4.json();
    const isPrefilledSms4 =
      data4.deviceAction?.status === 'ready' &&
      data4.deviceAction?.action === 'sms' &&
      data4.deviceAction?.recipientName === 'Test_Fred' &&
      data4.deviceAction?.prefilledMessage?.toLowerCase().includes('running late');

    results.push({
      scenario: 4,
      name: 'Immediate Text with prefilled message ("Text Test_Fred I\'m running late")',
      passed: Boolean(isPrefilledSms4),
      details: `Status: ${data4.deviceAction?.status}, Prefilled: "${data4.deviceAction?.prefilledMessage}"`,
    });
    console.log(`Scenario 4: ${isPrefilledSms4 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 5: Immediate Action with known person but missing phone ("Ring Test_Sarah")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 5: Missing Phone Number ("Ring Test_Sarah") ---');
    const res5 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Ring Test_Sarah',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data5 = await res5.json();
    const isMissingPhone5 =
      data5.deviceAction?.status === 'missing_number' &&
      data5.deviceAction?.recipientName === 'Test_Sarah';

    results.push({
      scenario: 5,
      name: 'Immediate Action with known person but missing phone ("Ring Test_Sarah")',
      passed: Boolean(isMissingPhone5),
      details: `Status: ${data5.deviceAction?.status}, Recipient: ${data5.deviceAction?.recipientName}, Feedback: ${data5.deviceAction?.feedbackMessage}`,
    });
    console.log(`Scenario 5: ${isMissingPhone5 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 6: Immediate Action with ambiguous person ("Call Test_John")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 6: Ambiguous Person ("Call Test_John") ---');
    const res6 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Call Test_John',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data6 = await res6.json();
    const isAmbiguous6 =
      data6.deviceAction?.status === 'ambiguous' &&
      Array.isArray(data6.deviceAction?.candidates) &&
      data6.deviceAction.candidates.length >= 2;

    results.push({
      scenario: 6,
      name: 'Immediate Action with ambiguous person ("Call Test_John")',
      passed: Boolean(isAmbiguous6),
      details: `Status: ${data6.deviceAction?.status}, Candidate count: ${data6.deviceAction?.candidates?.length}, Feedback: ${data6.deviceAction?.feedbackMessage}`,
    });
    console.log(`Scenario 6: ${isAmbiguous6 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 7: Immediate Action with unknown person ("Ring Test_UnknownPerson")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 7: Unknown Person ("Ring Test_UnknownPerson") ---');
    const res7 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Ring Test_UnknownPerson',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data7 = await res7.json();
    const isUnknown7 =
      data7.deviceAction?.status === 'unknown_person';

    results.push({
      scenario: 7,
      name: 'Immediate Action with unknown person ("Ring Test_UnknownPerson")',
      passed: Boolean(isUnknown7),
      details: `Status: ${data7.deviceAction?.status}, Feedback: ${data7.deviceAction?.feedbackMessage}`,
    });
    console.log(`Scenario 7: ${isUnknown7 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 8: Future Contact Intention ("Ring Test_Fred tomorrow at 10am")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 8: Future Contact Intention ("Ring Test_Fred tomorrow at 10am") ---');
    const initialMemCount8 = await countMemoriesWithPattern('Test_Fred');
    const res8 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Ring Test_Fred tomorrow at 10am',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data8 = await res8.json();
    const finalMemCount8 = await countMemoriesWithPattern('Test_Fred');
    const isFutureIntention8 =
      !data8.deviceAction &&
      (Array.isArray(data8.memories) ? data8.memories.length > 0 : Boolean(data8.memory)) &&
      finalMemCount8 > initialMemCount8;

    results.push({
      scenario: 8,
      name: 'Future Contact Intention ("Ring Test_Fred tomorrow at 10am")',
      passed: Boolean(isFutureIntention8),
      details: `deviceAction present: ${Boolean(data8.deviceAction)}, Memories created: ${finalMemCount8 - initialMemCount8}, Scheduled reminder present: ${Boolean(data8.memory?.scheduledReminder)}`,
    });
    console.log(`Scenario 8: ${isFutureIntention8 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 9: Contact Information Question via Ask ("What is Test_Fred's phone number?")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 9: Contact Info Query ("What is Test_Fred\'s phone number?") ---');
    const res9 = await fetch(`${BASE_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: "What is Test_Fred's phone number?",
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data9 = await res9.json();
    const containsPhone9 = data9.answer?.includes('0412 345 678') || data9.answer?.includes('0412345678');

    results.push({
      scenario: 9,
      name: 'Contact Information Question via Ask ("What is Test_Fred\'s phone number?")',
      passed: Boolean(containsPhone9),
      details: `Answer: "${data9.answer}"`,
    });
    console.log(`Scenario 9: ${containsPhone9 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 10: Contact Fact via Tell ("Test_Alice is my architect")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 10: Contact Fact ("Test_Alice is my architect") ---');
    const res10 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Test_Alice is my architect',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data10 = await res10.json();
    const memoryCreated10 = (Array.isArray(data10.memories) && data10.memories.length > 0) || Boolean(data10.memory);
    const noDeviceAction10 = !data10.deviceAction;

    results.push({
      scenario: 10,
      name: 'Contact Fact via Tell ("Test_Alice is my architect")',
      passed: Boolean(memoryCreated10 && noDeviceAction10),
      details: `Memory created: ${memoryCreated10}, deviceAction present: ${Boolean(data10.deviceAction)}`,
    });
    console.log(`Scenario 10: ${memoryCreated10 && noDeviceAction10 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 11: Contact Fact with Phone via Tell ("Test_Bob is my mechanic, his number is 0499 888 777")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 11: Contact Fact with Phone ("Test_Bob is my mechanic, his number is 0499 888 777") ---');
    const res11 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Test_Bob is my mechanic, his number is 0499 888 777',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data11 = await res11.json();
    const memoryCreated11 = (Array.isArray(data11.memories) && data11.memories.length > 0) || Boolean(data11.memory);
    const noDeviceAction11 = !data11.deviceAction;

    // Verify phone was stored in entity
    const bobQuery = await resolveContactQuery("What is Test_Bob's number?");
    const phoneSaved11 = bobQuery.found && bobQuery.phoneNumber?.includes('0499 888 777');

    results.push({
      scenario: 11,
      name: 'Contact Fact with Phone via Tell ("Test_Bob is my mechanic...")',
      passed: Boolean(memoryCreated11 && noDeviceAction11 && phoneSaved11),
      details: `Memory created: ${memoryCreated11}, Phone saved in entity: ${phoneSaved11}, Retrieved: "${bobQuery.phoneNumber}"`,
    });
    console.log(`Scenario 11: ${memoryCreated11 && noDeviceAction11 && phoneSaved11 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 12: General Thought ("Buy 9V batteries for smoke alarm")
    // -------------------------------------------------------------
    console.log('\n--- Scenario 12: General Thought ("Buy 9V batteries for smoke alarm") ---');
    const res12 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Buy 9V batteries for smoke alarm',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data12 = await res12.json();
    const memoryCreated12 = (Array.isArray(data12.memories) && data12.memories.length > 0) || Boolean(data12.memory);
    const noDeviceAction12 = !data12.deviceAction;

    results.push({
      scenario: 12,
      name: 'General Thought ("Buy 9V batteries for smoke alarm")',
      passed: Boolean(memoryCreated12 && noDeviceAction12),
      details: `Memory created: ${memoryCreated12}, deviceAction present: ${Boolean(data12.deviceAction)}`,
    });
    console.log(`Scenario 12: ${memoryCreated12 && noDeviceAction12 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // -------------------------------------------------------------
    // Scenario 13: Calendar Name Non-Establishment
    // ("Call Test_CalendarGuest" - in calendar event but NOT in contacts/entities)
    // -------------------------------------------------------------
    console.log('\n--- Scenario 13: Calendar Name Non-Establishment ("Call Test_CalendarGuest") ---');
    const res13 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Call Test_CalendarGuest',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data13 = await res13.json();
    // Must NOT silently establish identity as a phone contact or invent a number
    const isNonEstablished13 =
      data13.deviceAction?.status === 'unknown_person' &&
      !data13.deviceAction?.phoneNumber;

    results.push({
      scenario: 13,
      name: 'Calendar Name Non-Establishment ("Call Test_CalendarGuest")',
      passed: Boolean(isNonEstablished13),
      details: `Status: ${data13.deviceAction?.status}, Phone: ${data13.deviceAction?.phoneNumber || 'none'}, Feedback: ${data13.deviceAction?.feedbackMessage}`,
    });
    console.log(`Scenario 13: ${isNonEstablished13 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

  } finally {
    // Guaranteed cleanup of isolated test fixtures
    await cleanupFixtures();
  }

  console.log('\n================================================================================');
  console.log('                          REGRESSION MATRIX SUMMARY                             ');
  console.log('================================================================================\n');

  let passedCount = 0;
  for (const r of results) {
    if (r.passed) passedCount++;
    console.log(`[${r.passed ? 'PASS' : 'FAIL'}] Scenario ${r.scenario}: ${r.name}`);
    console.log(`       Details: ${r.details}`);
  }

  console.log(`\nTOTAL: ${passedCount}/${results.length} PASSED`);
  if (passedCount !== results.length) {
    process.exit(1);
  }
}

runRegressionMatrix().catch((err) => {
  console.error('Fatal regression suite error:', err);
  cleanupFixtures().finally(() => process.exit(1));
});

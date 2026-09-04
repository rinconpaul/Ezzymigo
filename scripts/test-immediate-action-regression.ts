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

  // 4. Test_Barb (friend with phone for multilingual tests)
  await saveRelationships([
    {
      person: 'Test_Barb',
      role: 'friend',
      is_active: true,
    },
  ]);
  await saveUserEntity({
    name: 'Test_Barb',
    entity_type: 'person',
    role: 'friend',
    normalized_role: 'friend',
    metadata: { phone: '0412 999 888' },
  });

  // 5. Calendar event with attendee/title "Dinner with Test_CalendarGuest" (no relationship/phone)
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

    // =============================================================
    // MULTILINGUAL INTEGRITY GATE: SPANISH
    // =============================================================

    // Scenario 14: Spanish Immediate Call ("Llama a Test_Barb")
    console.log('\n--- Scenario 14: Spanish Immediate Call ("Llama a Test_Barb") ---');
    const res14 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Llama a Test_Barb',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data14 = await res14.json();
    const countAfter14 = await countMemoriesWithPattern('Test_Barb');
    const isCallReady14 =
      data14.deviceAction?.action === 'call' &&
      data14.deviceAction?.status === 'ready' &&
      data14.deviceAction?.phoneNumber === '0412 999 888' &&
      data14.deviceAction?.sanitizedPhone === '0412999888' &&
      data14.deviceAction?.recipientName === 'Test_Barb' &&
      countAfter14 === 0;

    results.push({
      scenario: 14,
      name: 'Spanish Immediate Call ("Llama a Test_Barb")',
      passed: Boolean(isCallReady14),
      details: `Action: ${data14.deviceAction?.action}, Status: ${data14.deviceAction?.status}, Recipient: ${data14.deviceAction?.recipientName}, Phone: ${data14.deviceAction?.phoneNumber}, Zero-memories: ${countAfter14 === 0}`,
    });
    console.log(`Scenario 14: ${isCallReady14 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 15: Spanish Future Call ("Llama a Test_Barb mañana")
    console.log('\n--- Scenario 15: Spanish Future Call ("Llama a Test_Barb mañana") ---');
    const res15 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Llama a Test_Barb mañana',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data15 = await res15.json();
    const memoryCreated15 = (Array.isArray(data15.memories) && data15.memories.length > 0) || Boolean(data15.memory);
    const noImmediate15 = !data15.deviceAction;

    results.push({
      scenario: 15,
      name: 'Spanish Future Call ("Llama a Test_Barb mañana")',
      passed: Boolean(memoryCreated15 && noImmediate15),
      details: `Memory created: ${memoryCreated15}, deviceAction triggered: ${Boolean(data15.deviceAction)}`,
    });
    console.log(`Scenario 15: ${memoryCreated15 && noImmediate15 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 16: Spanish Immediate SMS with Message ("Envíale un mensaje a Test_Barb diciendo que llegaré tarde")
    console.log('\n--- Scenario 16: Spanish Immediate SMS ("Envíale un mensaje a Test_Barb diciendo que llegaré tarde") ---');
    const res16 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Envíale un mensaje a Test_Barb diciendo que llegaré tarde',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data16 = await res16.json();
    const isSmsReady16 =
      data16.deviceAction?.action === 'sms' &&
      data16.deviceAction?.status === 'ready' &&
      data16.deviceAction?.phoneNumber === '0412 999 888' &&
      data16.deviceAction?.recipientName === 'Test_Barb' &&
      Boolean(data16.deviceAction?.prefilledMessage?.toLowerCase().includes('tarde'));

    results.push({
      scenario: 16,
      name: 'Spanish Immediate SMS ("Envíale un mensaje a Test_Barb diciendo que llegaré tarde")',
      passed: Boolean(isSmsReady16),
      details: `Action: ${data16.deviceAction?.action}, Status: ${data16.deviceAction?.status}, Message: "${data16.deviceAction?.prefilledMessage}"`,
    });
    console.log(`Scenario 16: ${isSmsReady16 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 17: Spanish Explicit Reminder ("Recuérdame llamar a Test_Barb mañana")
    console.log('\n--- Scenario 17: Spanish Explicit Reminder ("Recuérdame llamar a Test_Barb mañana") ---');
    const res17 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Recuérdame llamar a Test_Barb mañana',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data17 = await res17.json();
    const memoryCreated17 = (Array.isArray(data17.memories) && data17.memories.length > 0) || Boolean(data17.memory);
    const noImmediate17 = !data17.deviceAction;

    results.push({
      scenario: 17,
      name: 'Spanish Explicit Reminder ("Recuérdame llamar a Test_Barb mañana")',
      passed: Boolean(memoryCreated17 && noImmediate17),
      details: `Memory created: ${memoryCreated17}, deviceAction triggered: ${Boolean(data17.deviceAction)}`,
    });
    console.log(`Scenario 17: ${memoryCreated17 && noImmediate17 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 18: Spanish Immediate Call by Role ("Llama a mi electricista")
    console.log('\n--- Scenario 18: Spanish Immediate Call by Role ("Llama a mi electricista") ---');
    const res18 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Llama a mi electricista',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data18 = await res18.json();
    const isRoleCallReady18 =
      data18.deviceAction?.action === 'call' &&
      data18.deviceAction?.status === 'ready' &&
      data18.deviceAction?.recipientName === 'Test_Fred' &&
      data18.deviceAction?.phoneNumber === '0412 345 678';

    results.push({
      scenario: 18,
      name: 'Spanish Immediate Call by Role ("Llama a mi electricista")',
      passed: Boolean(isRoleCallReady18),
      details: `Recipient: ${data18.deviceAction?.recipientName}, Role: ${data18.deviceAction?.role}, Phone: ${data18.deviceAction?.phoneNumber}`,
    });
    console.log(`Scenario 18: ${isRoleCallReady18 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // =============================================================
    // MULTILINGUAL INTEGRITY GATE: FRENCH
    // =============================================================

    // Scenario 19: French Immediate Call ("Appelle Test_Barb")
    console.log('\n--- Scenario 19: French Immediate Call ("Appelle Test_Barb") ---');
    const res19 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Appelle Test_Barb',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data19 = await res19.json();
    const isCallReady19 =
      data19.deviceAction?.action === 'call' &&
      data19.deviceAction?.status === 'ready' &&
      data19.deviceAction?.phoneNumber === '0412 999 888' &&
      data19.deviceAction?.recipientName === 'Test_Barb';

    results.push({
      scenario: 19,
      name: 'French Immediate Call ("Appelle Test_Barb")',
      passed: Boolean(isCallReady19),
      details: `Action: ${data19.deviceAction?.action}, Status: ${data19.deviceAction?.status}, Recipient: ${data19.deviceAction?.recipientName}, Phone: ${data19.deviceAction?.phoneNumber}`,
    });
    console.log(`Scenario 19: ${isCallReady19 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 20: French Future Call ("Appelle Test_Barb demain")
    console.log('\n--- Scenario 20: French Future Call ("Appelle Test_Barb demain") ---');
    const res20 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Appelle Test_Barb demain',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data20 = await res20.json();
    const memoryCreated20 = (Array.isArray(data20.memories) && data20.memories.length > 0) || Boolean(data20.memory);
    const noImmediate20 = !data20.deviceAction;

    results.push({
      scenario: 20,
      name: 'French Future Call ("Appelle Test_Barb demain")',
      passed: Boolean(memoryCreated20 && noImmediate20),
      details: `Memory created: ${memoryCreated20}, deviceAction triggered: ${Boolean(data20.deviceAction)}`,
    });
    console.log(`Scenario 20: ${memoryCreated20 && noImmediate20 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 21: French Immediate SMS with Message ("Envoie un SMS à Test_Barb en disant que j'aurai du retard")
    console.log('\n--- Scenario 21: French Immediate SMS ("Envoie un SMS à Test_Barb en disant que j\'aurai du retard") ---');
    const res21 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: "Envoie un SMS à Test_Barb en disant que j'aurai du retard",
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data21 = await res21.json();
    const isSmsReady21 =
      data21.deviceAction?.action === 'sms' &&
      data21.deviceAction?.status === 'ready' &&
      data21.deviceAction?.phoneNumber === '0412 999 888' &&
      data21.deviceAction?.recipientName === 'Test_Barb' &&
      Boolean(data21.deviceAction?.prefilledMessage?.toLowerCase().includes('retard'));

    results.push({
      scenario: 21,
      name: 'French Immediate SMS ("Envoie un SMS à Test_Barb en disant que j\'aurai du retard")',
      passed: Boolean(isSmsReady21),
      details: `Action: ${data21.deviceAction?.action}, Status: ${data21.deviceAction?.status}, Message: "${data21.deviceAction?.prefilledMessage}"`,
    });
    console.log(`Scenario 21: ${isSmsReady21 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 22: French Explicit Reminder ("Rappelle-moi d'appeler Test_Barb demain")
    console.log('\n--- Scenario 22: French Explicit Reminder ("Rappelle-moi d\'appeler Test_Barb demain") ---');
    const res22 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: "Rappelle-moi d'appeler Test_Barb demain",
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data22 = await res22.json();
    const memoryCreated22 = (Array.isArray(data22.memories) && data22.memories.length > 0) || Boolean(data22.memory);
    const noImmediate22 = !data22.deviceAction;

    results.push({
      scenario: 22,
      name: 'French Explicit Reminder ("Rappelle-moi d\'appeler Test_Barb demain")',
      passed: Boolean(memoryCreated22 && noImmediate22),
      details: `Memory created: ${memoryCreated22}, deviceAction triggered: ${Boolean(data22.deviceAction)}`,
    });
    console.log(`Scenario 22: ${memoryCreated22 && noImmediate22 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 23: French Immediate Call by Role ("Appelle mon électricien")
    console.log('\n--- Scenario 23: French Immediate Call by Role ("Appelle mon électricien") ---');
    const res23 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Appelle mon électricien',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data23 = await res23.json();
    const isRoleCallReady23 =
      data23.deviceAction?.action === 'call' &&
      data23.deviceAction?.status === 'ready' &&
      data23.deviceAction?.recipientName === 'Test_Fred' &&
      data23.deviceAction?.phoneNumber === '0412 345 678';

    results.push({
      scenario: 23,
      name: 'French Immediate Call by Role ("Appelle mon électricien")',
      passed: Boolean(isRoleCallReady23),
      details: `Recipient: ${data23.deviceAction?.recipientName}, Role: ${data23.deviceAction?.role}, Phone: ${data23.deviceAction?.phoneNumber}`,
    });
    console.log(`Scenario 23: ${isRoleCallReady23 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // =============================================================
    // MULTILINGUAL INTEGRITY GATE: GERMAN
    // =============================================================

    // Scenario 24: German Immediate Call ("Ruf Test_Barb an")
    console.log('\n--- Scenario 24: German Immediate Call ("Ruf Test_Barb an") ---');
    const res24 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Ruf Test_Barb an',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data24 = await res24.json();
    const isCallReady24 =
      data24.deviceAction?.action === 'call' &&
      data24.deviceAction?.status === 'ready' &&
      data24.deviceAction?.phoneNumber === '0412 999 888' &&
      data24.deviceAction?.recipientName === 'Test_Barb';

    results.push({
      scenario: 24,
      name: 'German Immediate Call ("Ruf Test_Barb an")',
      passed: Boolean(isCallReady24),
      details: `Action: ${data24.deviceAction?.action}, Status: ${data24.deviceAction?.status}, Recipient: ${data24.deviceAction?.recipientName}, Phone: ${data24.deviceAction?.phoneNumber}`,
    });
    console.log(`Scenario 24: ${isCallReady24 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 25: German Future Call ("Ruf Test_Barb morgen an")
    console.log('\n--- Scenario 25: German Future Call ("Ruf Test_Barb morgen an") ---');
    const res25 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Ruf Test_Barb morgen an',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data25 = await res25.json();
    const memoryCreated25 = (Array.isArray(data25.memories) && data25.memories.length > 0) || Boolean(data25.memory);
    const noImmediate25 = !data25.deviceAction;

    results.push({
      scenario: 25,
      name: 'German Future Call ("Ruf Test_Barb morgen an")',
      passed: Boolean(memoryCreated25 && noImmediate25),
      details: `Memory created: ${memoryCreated25}, deviceAction triggered: ${Boolean(data25.deviceAction)}`,
    });
    console.log(`Scenario 25: ${memoryCreated25 && noImmediate25 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 26: German Immediate SMS with Message ("Schreib Test_Barb eine SMS dass ich später komme")
    console.log('\n--- Scenario 26: German Immediate SMS ("Schreib Test_Barb eine SMS dass ich später komme") ---');
    const res26 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Schreib Test_Barb eine SMS dass ich später komme',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data26 = await res26.json();
    const isSmsReady26 =
      data26.deviceAction?.action === 'sms' &&
      data26.deviceAction?.status === 'ready' &&
      data26.deviceAction?.phoneNumber === '0412 999 888' &&
      data26.deviceAction?.recipientName === 'Test_Barb' &&
      Boolean(data26.deviceAction?.prefilledMessage?.toLowerCase().includes('später'));

    results.push({
      scenario: 26,
      name: 'German Immediate SMS ("Schreib Test_Barb eine SMS dass ich später komme")',
      passed: Boolean(isSmsReady26),
      details: `Action: ${data26.deviceAction?.action}, Status: ${data26.deviceAction?.status}, Message: "${data26.deviceAction?.prefilledMessage}"`,
    });
    console.log(`Scenario 26: ${isSmsReady26 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 27: German Explicit Reminder ("Erinnere mich daran, Test_Barb morgen anzurufen")
    console.log('\n--- Scenario 27: German Explicit Reminder ("Erinnere mich daran, Test_Barb morgen anzurufen") ---');
    const res27 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Erinnere mich daran, Test_Barb morgen anzurufen',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data27 = await res27.json();
    const memoryCreated27 = (Array.isArray(data27.memories) && data27.memories.length > 0) || Boolean(data27.memory);
    const noImmediate27 = !data27.deviceAction;

    results.push({
      scenario: 27,
      name: 'German Explicit Reminder ("Erinnere mich daran, Test_Barb morgen anzurufen")',
      passed: Boolean(memoryCreated27 && noImmediate27),
      details: `Memory created: ${memoryCreated27}, deviceAction triggered: ${Boolean(data27.deviceAction)}`,
    });
    console.log(`Scenario 27: ${memoryCreated27 && noImmediate27 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 28: German Immediate Call by Role ("Ruf meinen Elektriker an")
    console.log('\n--- Scenario 28: German Immediate Call by Role ("Ruf meinen Elektriker an") ---');
    const res28 = await fetch(`${BASE_URL}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Ruf meinen Elektriker an',
        clientNow: '2026-09-03T10:00:00.000Z',
      }),
    });
    const data28 = await res28.json();
    const isRoleCallReady28 =
      data28.deviceAction?.action === 'call' &&
      data28.deviceAction?.status === 'ready' &&
      data28.deviceAction?.recipientName === 'Test_Fred' &&
      data28.deviceAction?.phoneNumber === '0412 345 678';

    results.push({
      scenario: 28,
      name: 'German Immediate Call by Role ("Ruf meinen Elektriker an")',
      passed: Boolean(isRoleCallReady28),
      details: `Recipient: ${data28.deviceAction?.recipientName}, Role: ${data28.deviceAction?.role}, Phone: ${data28.deviceAction?.phoneNumber}`,
    });
    console.log(`Scenario 28: ${isRoleCallReady28 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // =============================================================
    // MULTILINGUAL ASK / CONTACT QUERIES
    // =============================================================

    // Scenario 29: Spanish Contact Query via Ask
    console.log('\n--- Scenario 29: Spanish Contact Query ("¿Cuál es el número de teléfono de Test_Fred?") ---');
    const res29 = await fetch(`${BASE_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: '¿Cuál es el número de teléfono de Test_Fred?',
        clientNow: '2026-09-03T10:00:00.000Z',
        localContext: { language: 'es', region: 'ES', timeZone: 'Europe/Madrid' },
      }),
    });
    const data29 = await res29.json();
    const answerContainsPhone29 =
      data29.answer?.includes('0412 345 678') || data29.answer?.includes('0412345678');

    results.push({
      scenario: 29,
      name: 'Spanish Contact Query ("¿Cuál es el número de teléfono de Test_Fred?")',
      passed: Boolean(answerContainsPhone29),
      details: `Answer: "${data29.answer}"`,
    });
    console.log(`Scenario 29: ${answerContainsPhone29 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 30: French Contact Query via Ask
    console.log('\n--- Scenario 30: French Contact Query ("Quel est le numéro de téléphone de Test_Fred ?") ---');
    const res30 = await fetch(`${BASE_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Quel est le numéro de téléphone de Test_Fred ?',
        clientNow: '2026-09-03T10:00:00.000Z',
        localContext: { language: 'fr', region: 'FR', timeZone: 'Europe/Paris' },
      }),
    });
    const data30 = await res30.json();
    const answerContainsPhone30 =
      data30.answer?.includes('0412 345 678') || data30.answer?.includes('0412345678');

    results.push({
      scenario: 30,
      name: 'French Contact Query ("Quel est le numéro de téléphone de Test_Fred ?")',
      passed: Boolean(answerContainsPhone30),
      details: `Answer: "${data30.answer}"`,
    });
    console.log(`Scenario 30: ${answerContainsPhone30 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

    // Scenario 31: German Contact Query via Ask
    console.log('\n--- Scenario 31: German Contact Query ("Wie lautet die Telefonnummer von Test_Fred?") ---');
    const res31 = await fetch(`${BASE_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Wie lautet die Telefonnummer von Test_Fred?',
        clientNow: '2026-09-03T10:00:00.000Z',
        localContext: { language: 'de', region: 'DE', timeZone: 'Europe/Berlin' },
      }),
    });
    const data31 = await res31.json();
    const answerContainsPhone31 =
      data31.answer?.includes('0412 345 678') || data31.answer?.includes('0412345678');

    results.push({
      scenario: 31,
      name: 'German Contact Query ("Wie lautet die Telefonnummer von Test_Fred?")',
      passed: Boolean(answerContainsPhone31),
      details: `Answer: "${data31.answer}"`,
    });
    console.log(`Scenario 31: ${answerContainsPhone31 ? '✅ PASS' : '❌ FAIL'} (${results[results.length - 1].details})`);

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

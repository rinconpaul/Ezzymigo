import { buildDynamicRetrievalContext } from '../server/retrieval/dcr';
import { readCalendarEvents } from '../server/calendar/store';
import { formatLocalTimeContext } from '../server/utils/time';

async function runAcceptanceTests() {
  console.log('================================================================================');
  console.log('  ACCEPTANCE TESTS: ALL-DAY CALENDAR EVENT BOUNDARIES & TIMED NON-REGRESSION   ');
  console.log('================================================================================\n');

  // Client context: Thursday 3 September 2026, Australia/Sydney
  const clientNowIso = '2026-09-02T20:26:31.000Z'; // 06:26 AM AEST on 3 Sep 2026
  const clientTz = 'Australia/Sydney';
  const localContext = formatLocalTimeContext(clientNowIso, clientTz, 'en-AU', 'AU');

  console.log(`Local Context Reference: ${localContext.localDateTimeStr}`);

  const calendarEvents = await readCalendarEvents();
  console.log(`Loaded ${calendarEvents.length} calendar events from database.`);

  const dougEvent = calendarEvents.find(e => e.title && e.title.includes('Doug'));
  console.log('\nDoug’s Birthday row in DB:');
  console.log(JSON.stringify(dougEvent, null, 2));

  if (!dougEvent) throw new Error('Doug event not found');
  if (dougEvent.start_datetime !== '2026-09-04' || dougEvent.end_datetime !== '2026-09-05') {
    throw new Error(`Doug event dates are not civil dates! Got start=${dougEvent.start_datetime}, end=${dougEvent.end_datetime}`);
  }

  // --- PART 1: DCR Temporal Boundary Validation for Doug's Birthday ---
  console.log('\n--- PART 1: DCR Temporal Boundary Checks for Doug’s Birthday ---');
  const checkQuery = (q: string) => {
    const result = buildDynamicRetrievalContext(q, [], calendarEvents, [], localContext);
    const hasDoug = result.candidateCalendarEvents.some(e => e.title && e.title.includes('Doug'));
    return { hasDoug, candidateCount: result.candidateCalendarEvents.length, candidates: result.candidateCalendarEvents.map(e => e.title) };
  };

  const friCheck = checkQuery('What have I got on Friday?');
  console.log(`Query: "What have I got on Friday?" -> Includes Doug? ${friCheck.hasDoug} (Candidates: ${friCheck.candidates.join(', ')})`);
  if (!friCheck.hasDoug) throw new Error('FAILED: Doug’s Birthday must be included on Friday!');

  const satCheck = checkQuery('Do I have anything on Saturday?');
  console.log(`Query: "Do I have anything on Saturday?" -> Includes Doug? ${satCheck.hasDoug} (Candidates: ${satCheck.candidates.join(', ')})`);
  if (satCheck.hasDoug) throw new Error('FAILED: Doug’s Birthday must NOT be included on Saturday!');

  const sunCheck = checkQuery('Do I have anything on Sunday?');
  console.log(`Query: "Do I have anything on Sunday?" -> Includes Doug? ${sunCheck.hasDoug} (Candidates: ${sunCheck.candidates.join(', ')})`);
  if (sunCheck.hasDoug) throw new Error('FAILED: Doug’s Birthday must NOT be included on Sunday!');

  console.log('✅ PART 1 PASSED: Doug’s Birthday strictly matches Friday and does NOT bleed into Saturday or Sunday.');

  // --- PART 2: Other All-Day Events Boundary Validation ---
  console.log('\n--- PART 2: Other All-Day Events Boundary Validation ---');

  // King's Birthday WA (Monday 28 September 2026)
  const kingsActual = checkQuery('What is on Monday 28 September?');
  const kingsPrev = checkQuery('What is on Sunday 27 September?');
  const kingsNext = checkQuery('What is on Tuesday 29 September?');
  const hasKingsActual = kingsActual.candidates.some(t => t.includes("King's Birthday (Western Australia)"));
  const hasKingsPrev = kingsPrev.candidates.some(t => t.includes("King's Birthday (Western Australia)"));
  const hasKingsNext = kingsNext.candidates.some(t => t.includes("King's Birthday (Western Australia)"));
  console.log(`King's Birthday (WA) - Actual (28 Sep): ${hasKingsActual} | Prev (27 Sep): ${hasKingsPrev} | Next (29 Sep): ${hasKingsNext}`);
  if (!hasKingsActual || hasKingsPrev || hasKingsNext) {
    throw new Error("FAILED: King's Birthday (WA) boundary check failed!");
  }

  // Daylight Saving Time (Sunday 4 October 2026)
  const dstActual = checkQuery('What is on Sunday 4 October?');
  const dstPrev = checkQuery('What is on Saturday 3 October?');
  const dstNext = checkQuery('What is on Monday 5 October?');
  const hasDstActual = dstActual.candidates.some(t => t.includes('Daylight Saving'));
  const hasDstPrev = dstPrev.candidates.some(t => t.includes('Daylight Saving'));
  const hasDstNext = dstNext.candidates.some(t => t.includes('Daylight Saving'));
  console.log(`Daylight Saving Time - Actual (4 Oct): ${hasDstActual} | Prev (3 Oct): ${hasDstPrev} | Next (5 Oct): ${hasDstNext}`);
  if (!hasDstActual || hasDstPrev || hasDstNext) {
    throw new Error('FAILED: Daylight Saving Time boundary check failed!');
  }

  // Labour Day / King's Birthday QLD (Monday 5 October 2026)
  const labourActual = checkQuery('What is on Monday 5 October?');
  const labourPrev = checkQuery('What is on Sunday 4 October?');
  const labourNext = checkQuery('What is on Tuesday 6 October?');
  const hasLabourActual = labourActual.candidates.some(t => t.includes('Labour Day'));
  const hasLabourPrev = labourPrev.candidates.some(t => t.includes('Labour Day'));
  const hasLabourNext = labourNext.candidates.some(t => t.includes('Labour Day'));
  console.log(`Labour Day - Actual (5 Oct): ${hasLabourActual} | Prev (4 Oct): ${hasLabourPrev} | Next (6 Oct): ${hasLabourNext}`);
  if (!hasLabourActual || hasLabourPrev || hasLabourNext) {
    throw new Error('FAILED: Labour Day boundary check failed!');
  }
  console.log('✅ PART 2 PASSED: All other all-day events occur only on their genuine civil calendar dates.');

  // --- PART 3: Timed-Event Non-Regression ---
  console.log('\n--- PART 3: Timed-Event Non-Regression ---');
  const arianne = calendarEvents.find(e => e.title && e.title.includes('Arianne'));
  const marning = calendarEvents.find(e => e.title && e.title.includes('Marning'));
  const hamish = calendarEvents.find(e => e.title && e.title.includes('Hamish'));
  const wendy = calendarEvents.find(e => e.title && e.title.includes('Wendy'));

  console.log(`Arianne: is_all_day=${arianne?.is_all_day}, start=${arianne?.start_datetime}, end=${arianne?.end_datetime}`);
  console.log(`Dr Marning: is_all_day=${marning?.is_all_day}, start=${marning?.start_datetime}, end=${marning?.end_datetime}`);
  console.log(`Hamish: is_all_day=${hamish?.is_all_day}, start=${hamish?.start_datetime}, end=${hamish?.end_datetime}`);
  console.log(`Wendy: is_all_day=${wendy?.is_all_day}, start=${wendy?.start_datetime}, end=${wendy?.end_datetime}`);

  if (arianne?.is_all_day || marning?.is_all_day || hamish?.is_all_day || wendy?.is_all_day) {
    throw new Error('FAILED: Timed events must have is_all_day = false');
  }
  if (!arianne?.start_datetime.includes('19:30:00+10:00') || !marning?.start_datetime.includes('15:30:00+10:00')) {
    throw new Error('FAILED: Timed events lost their specific clock times!');
  }
  console.log('✅ PART 3 PASSED: Timed events retain exact timestamps and timezone offsets.');

  // --- PART 4: End-to-End Live /api/ask Acceptance Invocations ---
  console.log('\n--- PART 4: End-to-End Live /api/ask Invocations ---');
  const liveAskQueries = [
    'What have I got on Friday?',
    'Do I have anything on Saturday?',
    'Do I have anything on Sunday?',
    'How many birthdays have I got coming up this month?',
    'What have I got on Monday?',
    'What have I got coming up next week?'
  ];

  for (const q of liveAskQueries) {
    const res = await fetch('http://localhost:3000/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: q,
        clientNow: clientNowIso,
        clientTimeZone: clientTz,
        clientLanguage: 'en-AU',
        clientRegion: 'AU'
      })
    });
    const data = await res.json();
    console.log(`\nQ: "${q}"`);
    console.log(`A: ${data.answer}`);
    console.log(`Events: ${JSON.stringify(data.calendar_event_ids)}`);

    if (q === 'What have I got on Friday?') {
      if (!data.calendar_event_ids?.includes(dougEvent.id)) {
        throw new Error('FAILED: Friday response must include Doug’s birthday event ID');
      }
      if (/10:00\s*am|9:59\s*am|12:00\s*am/i.test(data.answer)) {
        throw new Error(`FAILED: Artificial pseudo-time detected in Friday answer: ${data.answer}`);
      }
    }
    if (q === 'Do I have anything on Saturday?') {
      if (data.calendar_event_ids?.includes(dougEvent.id)) {
        throw new Error('FAILED: Saturday response must NOT include Doug’s birthday event ID');
      }
      if (/Doug/i.test(data.answer)) {
        throw new Error(`FAILED: Doug mentioned in Saturday answer: ${data.answer}`);
      }
    }
    if (q === 'Do I have anything on Sunday?') {
      if (data.calendar_event_ids?.includes(dougEvent.id)) {
        throw new Error('FAILED: Sunday response must NOT include Doug’s birthday event ID');
      }
      if (/Doug/i.test(data.answer)) {
        throw new Error(`FAILED: Doug mentioned in Sunday answer: ${data.answer}`);
      }
    }
  }

  console.log('\n================================================================================');
  console.log('  ALL ACCEPTANCE TESTS COMPLETED AND VERIFIED 100% SUCCESSFUL                  ');
  console.log('================================================================================');
}

runAcceptanceTests().catch(err => {
  console.error('Acceptance test error:', err);
  process.exit(1);
});

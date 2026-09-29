import { buildDynamicRetrievalContext, resolveQueryTemporalTargets, doesMemoryMatchRecurringWeekday } from '../server/retrieval/dcr';
import { formatLocalTimeContext } from '../server/utils/time';
import { readMemories } from '../server/db/memories';
import { readCalendarEvents } from '../server/calendar/store';
import { readActiveRelationships } from '../server/relationships/index';

async function runTemporalAcceptanceTests() {
  console.log('='.repeat(80));
  console.log('  TEMPORAL RETRIEVAL DEFECT FIX — COMPREHENSIVE ACCEPTANCE SUITE');
  console.log('='.repeat(80));

  // Live reference date: 2026-09-03T10:00:00+10:00 (Thursday, 3 September 2026 Australia/Sydney)
  // Tomorrow is 2026-09-04 (Friday, 4 September 2026)
  const localContext = formatLocalTimeContext(
    '2026-09-03T00:00:00.000Z', // 10:00 AM AEST on 2026-09-03
    'Australia/Sydney',
    'en-AU',
    'AU'
  );
  console.log(`[Context] Today: ${localContext.localDateTimeStr}`);

  const memories = await readMemories();
  const calendarEvents = await readCalendarEvents();
  const relationships = await readActiveRelationships();

  let passedCount = 0;
  let totalCount = 0;

  function assertTest(name: string, condition: boolean, detail: string) {
    totalCount++;
    if (condition) {
      passedCount++;
      console.log(`[PASS] ${name}: ${detail}`);
    } else {
      console.error(`[FAIL] ${name}: ${detail}`);
    }
  }

  // -------------------------------------------------------------------------
  // Test 1: "What do I need to do tomorrow?" retrieves Mum dentist, Friday Mum visit, and Doug's Birthday
  // -------------------------------------------------------------------------
  {
    const query = 'What do I need to do tomorrow?';
    const result = buildDynamicRetrievalContext(query, memories, calendarEvents, relationships, localContext);
    
    const hasDentist = result.candidateMemories.some(m => 
      m.id === 'mem_1787556708688_4_v5vsk67' || 
      (m.interpretation?.content || m.originalText || '').toLowerCase().includes('dentist')
    );
    const hasMumVisit = result.candidateMemories.some(m => 
      m.id === 'mem_1787556414573_2_0ga9xlv' || 
      (m.interpretation?.content || m.originalText || '').toLowerCase().includes('visit mum')
    );
    const hasDougBirthday = result.candidateCalendarEvents.some(e => 
      e.id === 'cal_google_primary_420pbbpi6go3abb164s3ab9k68q6ab9o74rmcbb468o3ehb564pm4d9j60' ||
      (e.title || '').toLowerCase().includes('doug')
    );

    assertTest(
      'Test 1 (Live Case - Candidate Retrieval)',
      hasDentist && hasMumVisit && hasDougBirthday,
      `Dentist=${hasDentist}, MumVisit=${hasMumVisit}, DougBirthday=${hasDougBirthday}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 2: "What reminders have I got tomorrow?" retrieves tomorrow's reminders without literal "tomorrow"
  // -------------------------------------------------------------------------
  {
    const query = 'What reminders have I got tomorrow?';
    const result = buildDynamicRetrievalContext(query, memories, calendarEvents, relationships, localContext);

    const hasDentist = result.candidateMemories.some(m => 
      (m.interpretation?.content || m.originalText || '').toLowerCase().includes('dentist')
    );

    assertTest(
      'Test 2 (Reminders tomorrow without literal text)',
      hasDentist,
      `Retrieved dentist appointment without literal 'tomorrow' in reminder text: ${hasDentist}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 3: Synthetic memory with absolute date equivalent to tomorrow must match
  // -------------------------------------------------------------------------
  {
    const syntheticMem = {
      id: 'syn_mem_tomorrow_abs',
      originalText: 'Pick up dry cleaning on 4 September 2026',
      interpretation: {
        kind: 'reminder',
        content: 'Pick up dry cleaning',
        resolved_datetime: '2026-09-04T15:00:00+10:00',
      },
      createdAt: '2026-09-01T00:00:00Z',
    };

    const result = buildDynamicRetrievalContext('What do I need to do tomorrow?', [syntheticMem], [], relationships, localContext);
    const matched = result.candidateMemories.some(m => m.id === 'syn_mem_tomorrow_abs');

    assertTest(
      'Test 3 (Synthetic absolute date match for tomorrow)',
      matched,
      `Matched absolute date memory for 2026-09-04: ${matched}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 4: Recurring "every Friday" memory matches when tomorrow is Friday, and NOT when tomorrow isn't Friday
  // -------------------------------------------------------------------------
  {
    const fridayMemory = {
      id: 'syn_mem_friday_recurring',
      originalText: 'Attend pottery class every Friday afternoon',
      interpretation: {
        kind: 'thought',
        content: 'Attend pottery class every Friday afternoon',
        resurfacing: {
          mode: 'recurring',
          timing: 'every Friday afternoon',
        },
      },
      createdAt: '2026-08-01T00:00:00Z',
    };

    // Scenario A: Reference date Thursday 2026-09-03 -> Tomorrow is Friday -> MUST MATCH
    const resultA = buildDynamicRetrievalContext('What is on tomorrow?', [fridayMemory], [], relationships, localContext);
    const matchedWhenFriday = resultA.candidateMemories.some(m => m.id === 'syn_mem_friday_recurring');

    // Scenario B: Reference date Friday 2026-09-04 -> Tomorrow is Saturday -> MUST NOT MATCH
    const localContextSat = formatLocalTimeContext(
      '2026-09-04T00:00:00.000Z',
      'Australia/Sydney',
      'en-AU',
      'AU'
    );
    const resultB = buildDynamicRetrievalContext('What is on tomorrow?', [fridayMemory], [], relationships, localContextSat);
    const matchedWhenSaturday = resultB.candidateMemories.some(m => m.id === 'syn_mem_friday_recurring');

    assertTest(
      'Test 4 (Recurring weekday sensitivity)',
      matchedWhenFriday && !matchedWhenSaturday,
      `Matched when tomorrow is Friday: ${matchedWhenFriday} | Matched when tomorrow is Saturday: ${matchedWhenSaturday}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 5: Calendar event dated tomorrow matches even if title has NO temporal words
  // -------------------------------------------------------------------------
  {
    const calEventTomorrow = {
      id: 'cal_tomorrow_no_temporal_words',
      title: 'Project Alpha Review',
      start_datetime: '2026-09-04T14:00:00+10:00',
      end_datetime: '2026-09-04T15:00:00+10:00',
    };

    const result = buildDynamicRetrievalContext('What is on my calendar tomorrow?', [], [calEventTomorrow], relationships, localContext);
    const matched = result.candidateCalendarEvents.some(e => e.id === 'cal_tomorrow_no_temporal_words');

    assertTest(
      'Test 5 (Calendar event dated tomorrow without temporal title words)',
      matched,
      `Matched calendar event: ${matched}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 6: Event dated the day after tomorrow must NOT match "tomorrow" query
  // -------------------------------------------------------------------------
  {
    const calEventDayAfter = {
      id: 'cal_day_after_tomorrow',
      title: 'Saturday BBQ at Pete’s',
      start_datetime: '2026-09-05T12:00:00+10:00',
      end_datetime: '2026-09-05T16:00:00+10:00',
    };

    const result = buildDynamicRetrievalContext('What do I have on tomorrow?', [], [calEventDayAfter], relationships, localContext);
    const matched = result.candidateCalendarEvents.some(e => e.id === 'cal_day_after_tomorrow');

    assertTest(
      'Test 6 (Day-after-tomorrow event exclusion from tomorrow query)',
      !matched,
      `Day-after-tomorrow event excluded from tomorrow: ${!matched}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 7: "What did I do yesterday?" resolves yesterday correctly
  // -------------------------------------------------------------------------
  {
    const yesterdayMem = {
      id: 'syn_mem_yesterday',
      originalText: 'Took dog to vet',
      interpretation: {
        kind: 'thought',
        content: 'Took dog to vet',
        resolved_datetime: '2026-09-02T10:00:00+10:00',
      },
      createdAt: '2026-09-02T10:00:00+10:00',
    };

    const query = 'What did I do yesterday?';
    const targets = resolveQueryTemporalTargets(query.toLowerCase(), localContext);
    const result = buildDynamicRetrievalContext(query, [yesterdayMem], [], relationships, localContext);
    const targetYMD = targets.find(t => t.expression === 'yesterday')?.targetYMD;
    const matched = result.candidateMemories.some(m => m.id === 'syn_mem_yesterday');

    assertTest(
      'Test 7 (Yesterday resolution & retrieval)',
      targetYMD === '2026-09-02' && matched,
      `Resolved YMD=${targetYMD} (expected 2026-09-02), Matched=${matched}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 8: Absolute-date retrieval remains working
  // -------------------------------------------------------------------------
  {
    const sepEvent = {
      id: 'cal_september_14',
      title: 'Dentist Checkup',
      start_datetime: '2026-09-14T10:00:00+10:00',
      end_datetime: '2026-09-14T11:00:00+10:00',
    };

    const result = buildDynamicRetrievalContext('When is my dentist checkup in September?', [], [sepEvent], relationships, localContext);
    const matched = result.candidateCalendarEvents.some(e => e.id === 'cal_september_14');

    assertTest(
      'Test 8 (Absolute date / month retrieval preservation)',
      matched,
      `Preserved September dentist checkup matching: ${matched}`
    );
  }

  // -------------------------------------------------------------------------
  // Test 9: End-to-end Ask verification of live query
  // -------------------------------------------------------------------------
  {
    const query = 'What do I need to do tomorrow?';
    const result = buildDynamicRetrievalContext(query, memories, calendarEvents, relationships, localContext);
    console.log(`[Test 9 Details] Dynamic retrieval result: ${result.candidateMemories.length} candidate memories, ${result.candidateCalendarEvents.length} calendar events.`);
    console.log(`Candidate Memory Titles:`, result.candidateMemories.map(m => m.interpretation?.content || m.originalText));
    console.log(`Candidate Calendar Titles:`, result.candidateCalendarEvents.map(e => `${e.title} (${e.start_datetime})`));

    const totalTomorrowCandidates = result.candidateMemories.length + result.candidateCalendarEvents.length;
    assertTest(
      'Test 9 (Overall candidate count for live query)',
      totalTomorrowCandidates >= 3,
      `Found ${totalTomorrowCandidates} candidates for tomorrow (at least 3 required)`
    );
  }

  console.log('='.repeat(80));
  console.log(`  ACCEPTANCE SUMMARY: ${passedCount} / ${totalCount} PASSED (${Math.round(passedCount/totalCount * 100)}%)`);
  console.log('='.repeat(80));

  if (passedCount < totalCount) {
    process.exit(1);
  }
}

runTemporalAcceptanceTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

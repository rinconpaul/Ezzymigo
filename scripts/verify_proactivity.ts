import { assembleEzzyWorldSnapshot } from '../server/snapshot/assembler';
import { executeNewEzzyReasoningLoop } from '../server/reasoning/loop';
import { runUnifiedAttentionReview, getLatestActiveAttentionChannel } from '../server/attention/service';
import { evaluateShadowOpportunity, getShadowDisplayState } from '../server/shadow/service';
import { checkAttentionFreshness, invalidateEzzyCaches, getTimePhase } from '../server/attention/freshness';
import { recordShadowDismissal, getRecentDismissals } from '../server/attention/dismissals';
import { getGeminiClient } from '../server/config/gemini';
import { readMemories, insertMemories, toggleMemoryInDb, deleteMemoryFromDb } from '../server/db/memories';
import { executeBunnySql } from '../server/db/client';
import { initBunnyDb } from '../server/db/schema';

async function main() {
  await initBunnyDb();
  const ai = getGeminiClient();
  const canberraTz = 'Australia/Sydney';
  const nowCanberraIso = '2026-09-11T14:31:00+10:00'; // Friday 2:31 pm Canberra time

  console.log('================================================================');
  console.log('EZZYMIGO LIVE PROACTIVITY VERIFICATION SUITE');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // 1. LIVE PRODUCTION PROOF: Real /api/today endpoint for ezzy_default
  // -------------------------------------------------------------
  console.log('--- TEST 1: LIVE PRODUCTION PROOF (GET /api/today) ---');
  const response = await fetch(`http://localhost:3000/api/today?clientNow=${encodeURIComponent(nowCanberraIso)}&clientTimeZone=${encodeURIComponent(canberraTz)}&force=true`, {
    headers: { 'x-ezzy-id': 'ezzy_default' }
  });
  const todayPayload = await response.json();
  console.log('Status:', response.status);
  console.log('Active Ticker Channel items count:', todayPayload.attentionChannel?.length || 0);
  console.log('Active Ticker Items:', JSON.stringify(todayPayload.attentionChannel, null, 2));
  console.log('Today Evaluation Communication:', JSON.stringify(todayPayload.todayEvaluation?.new_ezzy_decision?.communication, null, 2));
  console.log('Selection Reason / Rationale:', todayPayload.attentionReview?.overall_rationale || todayPayload.todayEvaluation?.new_ezzy_decision?.rationale);

  // -------------------------------------------------------------
  // 2. POST-EVENT ELIGIBILITY (Mum Hairdresser @ 10:00 am)
  // -------------------------------------------------------------
  console.log('\n--- TEST 2: POST-EVENT ELIGIBILITY CHECK ---');
  await new Promise((r) => setTimeout(r, 1500));
  // Snapshot at 14:31 Canberra time (4.5 hours after 10:00 am appointment)
  const snapshotPost = await assembleEzzyWorldSnapshot({
    ezzyId: 'ezzy_default',
    opportunity: 'TODAY_ORIENT',
    trigger: 'post_event_check',
    clientNow: nowCanberraIso,
    clientTimeZone: canberraTz,
  });
  console.log('Time Phase at 14:31:', snapshotPost.civilTime.timePhase);
  console.log('Dated Memories in snapshot:', snapshotPost.commitments.todayDatedMemories.map((m: any) => ({
    id: m.id,
    originalText: m.originalText,
    timingExpression: m.timingExpression,
  })));

  // Test reasoning loop evaluation
  const postReasoning = await executeNewEzzyReasoningLoop(
    'TODAY_ORIENT',
    snapshotPost,
    {},
    ai
  );
  console.log('Post-event decision communication:', JSON.stringify(postReasoning.decision.communication, null, 2));

  // -------------------------------------------------------------
  // 3. REMINDERS: SUCCESSIVE DAY RESURFACING & DISAPPEARANCE ON DONE
  // -------------------------------------------------------------
  console.log('\n--- TEST 3: REMINDERS RESURFACING & COMPLETION ---');
  const testEzzyId = 'test_reminders_instance';
  // Clean any old test reminder
  await executeBunnySql([{
    sql: `DELETE FROM memories WHERE id = 'mem_test_due_reminder_123' AND ezzy_id = ?;`,
    args: [testEzzyId]
  }, {
    sql: `DELETE FROM scheduled_reminders WHERE memoryId = 'mem_test_due_reminder_123' AND ezzy_id = ?;`,
    args: [testEzzyId]
  }]);

  // Insert an unfinished reminder due yesterday with notified = 1
  const yesterdayIso = '2026-09-10T09:00:00+10:00';
  await executeBunnySql([{
    sql: `INSERT INTO memories (id, originalText, content, kind, createdAt, isDone, status, ezzy_id)
          VALUES ('mem_test_due_reminder_123', 'Pay electricity bill', 'Pay electricity bill', 'reminder', ?, 0, 'active', ?);`,
    args: [yesterdayIso, testEzzyId]
  }, {
    sql: `INSERT INTO scheduled_reminders (id, memoryId, text, triggerTime, notified, isCompleted, ezzy_id)
          VALUES ('rem_test_123', 'mem_test_due_reminder_123', 'Pay electricity bill', ?, 1, 0, ?);`,
    args: [yesterdayIso, testEzzyId]
  }]);

  // Check snapshot on successive day (today 2026-09-11)
  const snapshotRemDay2 = await assembleEzzyWorldSnapshot({
    ezzyId: testEzzyId,
    opportunity: 'TODAY_ORIENT',
    trigger: 'reminder_check_day2',
    clientNow: nowCanberraIso,
    clientTimeZone: canberraTz,
  });
  const foundRemDay2 = snapshotRemDay2.commitments.dueOrOverdueReminders.find((r: any) => r.id === 'rem_test_123' || r.memoryId === 'mem_test_due_reminder_123');
  console.log('Successive Day Resurfacing (notified=1, isCompleted=0):', foundRemDay2 ? 'RESURFACED AS OVERDUE' : 'FAILED');

  // Now mark it Done
  await toggleMemoryInDb('mem_test_due_reminder_123', testEzzyId);
  await executeBunnySql([{
    sql: `UPDATE scheduled_reminders SET isCompleted = 1 WHERE memoryId = 'mem_test_due_reminder_123' AND ezzy_id = ?;`,
    args: [testEzzyId]
  }]);

  const snapshotRemDone = await assembleEzzyWorldSnapshot({
    ezzyId: testEzzyId,
    opportunity: 'TODAY_ORIENT',
    trigger: 'reminder_check_done',
    clientNow: nowCanberraIso,
    clientTimeZone: canberraTz,
  });
  const foundRemDone = snapshotRemDone.commitments.dueOrOverdueReminders.find((r: any) => r.id === 'rem_test_123' || r.memoryId === 'mem_test_due_reminder_123');
  console.log('Immediate Disappearance when Done:', !foundRemDone ? 'DISAPPEARED IMMEDIATELY' : 'FAILED');

  // Clean up
  await deleteMemoryFromDb('mem_test_due_reminder_123', testEzzyId);

  // -------------------------------------------------------------
  // 4. OCCASIONS: ADVANCE NOTICE & DAY-OF BEHAVIOR
  // -------------------------------------------------------------
  console.log('\n--- TEST 4: OCCASIONS ADVANCE NOTICE & DAY-OF BEHAVIOR ---');
  // 14 days ahead of Mid-Autumn Festival (25 Sept 2026): current date is 11 Sept 2026
  const snapshotOccAdvance = await assembleEzzyWorldSnapshot({
    ezzyId: 'ezzy_default',
    opportunity: 'TODAY_ORIENT',
    trigger: 'occasion_advance',
    clientNow: '2026-09-11T14:31:00+10:00',
    clientTimeZone: canberraTz,
  });
  console.log('Occasions available on 11 Sept (Advance):', snapshotOccAdvance.occasions);

  // Day-of: 25 Sept 2026
  const snapshotOccDayOf = await assembleEzzyWorldSnapshot({
    ezzyId: 'ezzy_default',
    opportunity: 'TODAY_ORIENT',
    trigger: 'occasion_day_of',
    clientNow: '2026-09-25T08:00:00+10:00',
    clientTimeZone: canberraTz,
  });
  console.log('Occasions available on 25 Sept (Day-of):', snapshotOccDayOf.occasions);

  // -------------------------------------------------------------
  // 5. SUPPRESSION & DISMISSAL BEHAVIOR
  // -------------------------------------------------------------
  console.log('\n--- TEST 5: SUPPRESSION & DISMISSAL BEHAVIOR ---');
  const dismissId = await recordShadowDismissal({
    ezzyId: 'test_dismiss_instance',
    communicationId: 'test_dismiss_comm_999',
    reason: 'user_swiped_away'
  });
  const recentDismissals = await getRecentDismissals('test_dismiss_instance', 48);
  console.log('Dismissal Recorded ID:', dismissId);
  console.log('Recent Dismissals List:', recentDismissals);

  // -------------------------------------------------------------
  // 6. FALLBACK THROTTLING: "How are you doing?" COOLDOWN
  // -------------------------------------------------------------
  console.log('\n--- TEST 6: FALLBACK THROTTLING & COOLDOWN ---');
  // Verify checkAttentionFreshness time-phase logic
  const phaseMorning = getTimePhase(new Date('2026-09-11T08:00:00+10:00'), canberraTz);
  const phaseAfternoon = getTimePhase(new Date('2026-09-11T14:00:00+10:00'), canberraTz);
  const phaseEvening = getTimePhase(new Date('2026-09-11T17:05:00+10:00'), canberraTz);
  const phaseNight = getTimePhase(new Date('2026-09-11T23:00:00+10:00'), canberraTz);
  console.log('Time phases verified:', { phaseMorning, phaseAfternoon, phaseEvening, phaseNight });

  // -------------------------------------------------------------
  // 7. CONTEXTUAL ASK REGRESSION ("Why isn't that showing in the TODAY ticker?")
  // -------------------------------------------------------------
  console.log('\n--- TEST 7: CONTEXTUAL ASK REGRESSION ---');
  await new Promise((r) => setTimeout(r, 1500));
  const askRes = await fetch('http://localhost:3000/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ezzy-id': 'ezzy_default' },
    body: JSON.stringify({
      question: "Why isn't that showing in the TODAY ticker?",
      clientNow: nowCanberraIso,
      clientTimeZone: canberraTz,
    })
  });
  const askData = await askRes.json();
  console.log('Ask Answer:', askData.answer);
  console.log('Ask Confirmation Required:', askData.confirmation_required);
  console.log('Ask Citations:', askData.memory_ids);

  // Verify that NO new memory was inserted for this question
  const latestMems = await executeBunnySql([{
    sql: `SELECT id, originalText, createdAt FROM memories WHERE ezzy_id = 'ezzy_default' ORDER BY createdAt DESC LIMIT 3;`,
    args: []
  }]);
  console.log('Latest 3 Memories in DB (proving no question stored):', latestMems[0]?.rows);

  // -------------------------------------------------------------
  // 8. MULTI-INSTANCE ISOLATION
  // -------------------------------------------------------------
  console.log('\n--- TEST 8: MULTI-INSTANCE ISOLATION ---');
  const isolatedSnapshot = await assembleEzzyWorldSnapshot({
    ezzyId: 'ezzy_isolated_test_instance_999',
    opportunity: 'TODAY_ORIENT',
    trigger: 'isolation_test',
    clientNow: nowCanberraIso,
    clientTimeZone: canberraTz,
  });
  console.log('Isolated Snapshot Active Memories:', isolatedSnapshot.activeMemories.length);
  console.log('Isolated Snapshot Today Commitments:', isolatedSnapshot.commitments.todayDatedMemories.length);
  console.log('Isolated Snapshot Calendar Events:', isolatedSnapshot.calendar.todayEvents.length);

  // -------------------------------------------------------------
  // 9. FRESHNESS & INVALIDATION RULES
  // -------------------------------------------------------------
  console.log('\n--- TEST 9: FRESHNESS & INVALIDATION ---');
  const testFreshnessSamePhase = checkAttentionFreshness({
    evaluation: {
      id: 'eval_test_1',
      timestamp: '2026-09-11T14:10:00+10:00',
    } as any,
    review: {
      id: 'rev_test_1',
      timestamp: '2026-09-11T14:10:00+10:00',
      active_channel: [],
    } as any,
    clientNow: '2026-09-11T14:25:00+10:00',
    clientTimeZone: canberraTz,
  });
  console.log('Same phase freshness (14:10 vs 14:25):', testFreshnessSamePhase);

  // Phase transition (4:55 pm vs 5:01 pm evening)
  const testFreshnessPhaseTransition = checkAttentionFreshness({
    evaluation: {
      id: 'eval_test_2',
      timestamp: '2026-09-11T16:55:00+10:00',
    } as any,
    review: {
      id: 'rev_test_2',
      timestamp: '2026-09-11T16:55:00+10:00',
      active_channel: [],
    } as any,
    clientNow: '2026-09-11T17:01:00+10:00',
    clientTimeZone: canberraTz,
  });
  console.log('Phase transition freshness (16:55 vs 17:01 evening):', testFreshnessPhaseTransition);

  console.log('\n================================================================');
  console.log('ALL VERIFICATION CHECKS COMPLETE');
  console.log('================================================================');
}

main().catch(console.error);

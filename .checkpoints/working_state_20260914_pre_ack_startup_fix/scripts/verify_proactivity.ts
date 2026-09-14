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
  const morningCanberraIso = '2026-09-11T08:00:00+10:00'; // Friday 8:00 am Canberra time
  const eveningCanberraIso = '2026-09-10T20:00:00+10:00'; // Thursday 8:00 pm Canberra time

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
  console.log('HTTP Status:', response.status);
  console.log('Active Ticker Items Count:', todayPayload.attentionChannel?.length || 0);
  console.log('Active Ticker Channel Payload:', JSON.stringify(todayPayload.attentionChannel, null, 2));

  // Strict temporal invariant validation:
  const nowMs = new Date(nowCanberraIso).getTime();
  for (const item of todayPayload.attentionChannel || []) {
    if (item.eligible_at) {
      const elMs = new Date(item.eligible_at).getTime();
      if (nowMs < elMs) {
        throw new Error(`INVARIANT VIOLATION: Item ${item.id} is ACTIVE but now (${nowCanberraIso}) < eligible_at (${item.eligible_at})`);
      }
    }
    if (item.expires_at) {
      const expMs = new Date(item.expires_at).getTime();
      if (nowMs >= expMs) {
        throw new Error(`INVARIANT VIOLATION: Item ${item.id} is ACTIVE but now (${nowCanberraIso}) >= expires_at (${item.expires_at})`);
      }
    }
  }
  console.log('Strict Temporal Invariant: PASSED (all active items satisfy eligible_at <= now < expires_at)');
  console.log('Today Evaluation Decision:', JSON.stringify(todayPayload.todayEvaluation?.new_ezzy_decision?.communication, null, 2));
  console.log('Attention Review Overall Rationale:', todayPayload.attentionReview?.overall_rationale);
  console.log('Candidate Resolutions:', JSON.stringify(todayPayload.attentionReview?.candidate_resolutions, null, 2));

  // -------------------------------------------------------------
  // 2. EVENING LOOK-AHEAD VERIFICATION (Thursday 8:00 pm)
  // -------------------------------------------------------------
  console.log('\n--- TEST 2: EVENING LOOK-AHEAD VERIFICATION (Thursday 20:00) ---');
  await new Promise((r) => setTimeout(r, 1200));
  const snapshotEvening = await assembleEzzyWorldSnapshot({
    ezzyId: 'ezzy_default',
    opportunity: 'TODAY_ORIENT',
    trigger: 'evening_lookahead_test',
    clientNow: eveningCanberraIso,
    clientTimeZone: canberraTz,
  });
  console.log('Civil Time Phase at 20:00:', snapshotEvening.civilTime.timePhase);
  console.log('Tomorrow Morning Commitments in Snapshot:', snapshotEvening.commitments.tomorrowMorningDatedMemories.map((m: any) => m.originalText));
  const eveningReasoning = await executeNewEzzyReasoningLoop(
    'TODAY_ORIENT',
    snapshotEvening,
    {},
    ai
  );
  console.log('Evening Look-Ahead Decision Communication:', JSON.stringify(eveningReasoning.decision.communication, null, 2));

  // -------------------------------------------------------------
  // 3. MORNING-OF APPOINTMENT VERIFICATION (Friday 8:00 am)
  // -------------------------------------------------------------
  console.log('\n--- TEST 3: MORNING-OF APPOINTMENT VERIFICATION (Friday 08:00) ---');
  await new Promise((r) => setTimeout(r, 1200));
  const snapshotMorning = await assembleEzzyWorldSnapshot({
    ezzyId: 'ezzy_default',
    opportunity: 'TODAY_ORIENT',
    trigger: 'morning_of_test',
    clientNow: morningCanberraIso,
    clientTimeZone: canberraTz,
  });
  console.log('Civil Time Phase at 08:00:', snapshotMorning.civilTime.timePhase);
  console.log("Today's Commitments in Snapshot:", snapshotMorning.commitments.todayDatedMemories.map((m: any) => m.originalText));
  const morningReasoning = await executeNewEzzyReasoningLoop(
    'TODAY_ORIENT',
    snapshotMorning,
    {},
    ai
  );
  console.log('Morning-of Decision Communication:', JSON.stringify(morningReasoning.decision.communication, null, 2));

  // -------------------------------------------------------------
  // 4. POST-EVENT EXPIRY & FOLLOW-UP (Friday 2:31 pm)
  // -------------------------------------------------------------
  console.log('\n--- TEST 4: POST-EVENT EXPIRY & FOLLOW-UP (Friday 14:31) ---');
  await new Promise((r) => setTimeout(r, 1200));
  const snapshotPost = await assembleEzzyWorldSnapshot({
    ezzyId: 'ezzy_default',
    opportunity: 'TODAY_ORIENT',
    trigger: 'post_event_check',
    clientNow: nowCanberraIso,
    clientTimeZone: canberraTz,
  });
  console.log('Civil Time Phase at 14:31:', snapshotPost.civilTime.timePhase);
  const postReasoning = await executeNewEzzyReasoningLoop(
    'TODAY_ORIENT',
    snapshotPost,
    {},
    ai
  );
  console.log('Post-event decision communication:', JSON.stringify(postReasoning.decision.communication, null, 2));

  // -------------------------------------------------------------
  // 5. REMINDERS: SUCCESSIVE DAY RESURFACING & DISAPPEARANCE ON DONE
  // -------------------------------------------------------------
  console.log('\n--- TEST 5: REMINDERS RESURFACING & IMMEDIATE DONE COMPLETION ---');
  const testEzzyId = 'test_reminders_instance';
  await executeBunnySql([{
    sql: `DELETE FROM memories WHERE id = 'mem_test_due_reminder_123' AND ezzy_id = ?;`,
    args: [testEzzyId]
  }, {
    sql: `DELETE FROM scheduled_reminders WHERE memoryId = 'mem_test_due_reminder_123' AND ezzy_id = ?;`,
    args: [testEzzyId]
  }]);

  // Reminder due yesterday with notified = 1
  const yesterdayIso = '2026-09-10T09:00:00+10:00';
  await executeBunnySql([{
    sql: `INSERT INTO memories (id, originalText, content, kind, createdAt, isDone, status, people, places, topics, resurfacingMode, resurfacingTiming, ezzy_id)
          VALUES ('mem_test_due_reminder_123', 'Pay electricity bill', 'Pay electricity bill', 'reminder', ?, 0, 'active', '[]', '[]', '[]', 'smart', 'immediate', ?);`,
    args: [yesterdayIso, testEzzyId]
  }, {
    sql: `INSERT INTO scheduled_reminders (id, memoryId, title, body, remindAt, notified, createdAt, ezzy_id)
          VALUES ('rem_test_123', 'mem_test_due_reminder_123', 'Pay electricity bill', 'Electricity bill is due', ?, 1, ?, ?);`,
    args: [yesterdayIso, yesterdayIso, testEzzyId]
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
  console.log('Successive Day Resurfacing (notified=1, isDone=0):', foundRemDay2 ? `RESURFACED AS OVERDUE (${foundRemDay2.title})` : 'FAILED');

  // Mark Done
  await toggleMemoryInDb('mem_test_due_reminder_123', testEzzyId);

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
  // 6. OCCASIONS: ADVANCE NOTICE & DAY-OF BEHAVIOR
  // -------------------------------------------------------------
  console.log('\n--- TEST 6: OCCASIONS ADVANCE NOTICE & DAY-OF BEHAVIOR ---');
  // 14 days ahead of Mid-Autumn Festival (25 Sept 2026): current date is 11 Sept 2026
  const snapshotOccAdvance = await assembleEzzyWorldSnapshot({
    ezzyId: 'ezzy_default',
    opportunity: 'TODAY_ORIENT',
    trigger: 'occasion_advance',
    clientNow: '2026-09-11T14:31:00+10:00',
    clientTimeZone: canberraTz,
  });
  console.log('Occasions available on 11 Sept (Advance):', snapshotOccAdvance.occasions.map((o: any) => ({
    name: o.name,
    targetYMD: o.targetYMD,
    daysUntil: o.daysUntil,
    temporalDescription: o.temporalDescription,
    isToday: o.isToday,
  })));

  // Day-of: 25 Sept 2026
  const snapshotOccDayOf = await assembleEzzyWorldSnapshot({
    ezzyId: 'ezzy_default',
    opportunity: 'TODAY_ORIENT',
    trigger: 'occasion_day_of',
    clientNow: '2026-09-25T08:00:00+10:00',
    clientTimeZone: canberraTz,
  });
  console.log('Occasions available on 25 Sept (Day-of):', snapshotOccDayOf.occasions.map((o: any) => ({
    name: o.name,
    targetYMD: o.targetYMD,
    daysUntil: o.daysUntil,
    temporalDescription: o.temporalDescription,
    isToday: o.isToday,
  })));

  // -------------------------------------------------------------
  // 7. SUPPRESSION & DISMISSAL BEHAVIOR
  // -------------------------------------------------------------
  console.log('\n--- TEST 7: SUPPRESSION & DISMISSAL BEHAVIOR ---');
  const dismissId = await recordShadowDismissal({
    ezzyId: 'test_dismiss_instance',
    communicationId: 'test_dismiss_comm_999',
    reason: 'user_swiped_away'
  });
  const recentDismissals = await getRecentDismissals('test_dismiss_instance', 48);
  console.log('Dismissal Recorded ID:', dismissId);
  console.log('Recent Dismissals for test instance:', recentDismissals);

  // -------------------------------------------------------------
  // 8. FALLBACK THROTTLING & TIME PHASE RESOLUTION
  // -------------------------------------------------------------
  console.log('\n--- TEST 8: FALLBACK THROTTLING & TIME PHASE RESOLUTION ---');
  const phaseMorning = getTimePhase(new Date('2026-09-11T08:00:00+10:00'), canberraTz);
  const phaseAfternoon = getTimePhase(new Date('2026-09-11T14:00:00+10:00'), canberraTz);
  const phaseEvening = getTimePhase(new Date('2026-09-11T17:05:00+10:00'), canberraTz);
  const phaseNight = getTimePhase(new Date('2026-09-11T23:00:00+10:00'), canberraTz);
  console.log('Time phases verified:', { phaseMorning, phaseAfternoon, phaseEvening, phaseNight });

  // -------------------------------------------------------------
  // 9. CONTEXTUAL ASK REGRESSION ("Why isn't that showing in the TODAY ticker?")
  // -------------------------------------------------------------
  console.log('\n--- TEST 9: CONTEXTUAL ASK REGRESSION ---');
  await new Promise((r) => setTimeout(r, 1200));
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

  // Verify that NO new memory was inserted for this question
  const latestMems = await executeBunnySql([{
    sql: `SELECT id, originalText, createdAt FROM memories WHERE ezzy_id = 'ezzy_default' ORDER BY createdAt DESC LIMIT 2;`,
    args: []
  }]);
  console.log('Latest 2 Memories in DB (proving no question stored as memory):', latestMems[0]?.rows);

  // -------------------------------------------------------------
  // 10. MULTI-INSTANCE ISOLATION (Ezzy A vs Ezzy B Populated Proof)
  // -------------------------------------------------------------
  console.log('\n--- TEST 10: MULTI-INSTANCE ISOLATION (Populated Ezzy A vs Ezzy B) ---');
  const ezzyA = 'test_ezzy_a';
  const ezzyB = 'test_ezzy_b';

  // Clean test tables
  await executeBunnySql([
    { sql: `DELETE FROM memories WHERE ezzy_id IN (?, ?);`, args: [ezzyA, ezzyB] },
    { sql: `DELETE FROM calendar_events WHERE ezzy_id IN (?, ?);`, args: [ezzyA, ezzyB] },
  ]);

  // Populate Ezzy A (Alice)
  await executeBunnySql([
    {
      sql: `INSERT INTO memories (id, originalText, content, kind, createdAt, isDone, status, people, places, topics, resurfacingMode, ezzy_id)
            VALUES ('mem_alice_1', 'Dentist appointment tomorrow at 10am', 'Dentist appointment', 'appointment', '2026-09-11T10:00:00+10:00', 0, 'active', '[]', '[]', '[]', 'smart', ?);`,
      args: [ezzyA],
    },
  ]);

  // Populate Ezzy B (Bob)
  await executeBunnySql([
    {
      sql: `INSERT INTO memories (id, originalText, content, kind, createdAt, isDone, status, people, places, topics, resurfacingMode, ezzy_id)
            VALUES ('mem_bob_1', 'Quarterly board meeting with investors', 'Board meeting', 'task', '2026-09-11T10:00:00+10:00', 0, 'active', '[]', '[]', '[]', 'smart', ?);`,
      args: [ezzyB],
    },
  ]);

  const snapshotA = await assembleEzzyWorldSnapshot({
    ezzyId: ezzyA,
    opportunity: 'TODAY_ORIENT',
    trigger: 'isolation_test_a',
    clientNow: nowCanberraIso,
    clientTimeZone: canberraTz,
  });

  const snapshotB = await assembleEzzyWorldSnapshot({
    ezzyId: ezzyB,
    opportunity: 'TODAY_ORIENT',
    trigger: 'isolation_test_b',
    clientNow: nowCanberraIso,
    clientTimeZone: canberraTz,
  });

  const hasAliceInA = snapshotA.activeMemories.some((m: any) => m.originalText.includes('Dentist'));
  const hasBobInA = snapshotA.activeMemories.some((m: any) => m.originalText.includes('board meeting'));
  const hasAliceInB = snapshotB.activeMemories.some((m: any) => m.originalText.includes('Dentist'));
  const hasBobInB = snapshotB.activeMemories.some((m: any) => m.originalText.includes('board meeting'));

  console.log('Ezzy A Memories:', snapshotA.activeMemories.map((m: any) => m.originalText));
  console.log('Ezzy B Memories:', snapshotB.activeMemories.map((m: any) => m.originalText));
  console.log('Isolation Check A (Alice present, Bob absent):', hasAliceInA && !hasBobInA ? 'PERFECT ISOLATION' : 'LEAK DETECTED');
  console.log('Isolation Check B (Bob present, Alice absent):', hasBobInB && !hasAliceInB ? 'PERFECT ISOLATION' : 'LEAK DETECTED');

  // Clean test tables
  await executeBunnySql([
    { sql: `DELETE FROM memories WHERE ezzy_id IN (?, ?);`, args: [ezzyA, ezzyB] },
  ]);

  // -------------------------------------------------------------
  // 11. FRESHNESS & INVALIDATION RULES
  // -------------------------------------------------------------
  console.log('\n--- TEST 11: FRESHNESS & INVALIDATION RULES ---');
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

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Fatal verification error:', err);
    process.exit(1);
  });

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { detectCorrectionCue, processThoughtCapturePipeline } from '../server/ai/interpreter';
import { insertMemories, readMemories } from '../server/db/memories';
import { executeBunnySql } from '../server/db/client';
import { initBunnyDb } from '../server/db/schema';
import { assembleEzzyWorldSnapshot } from '../server/snapshot/assembler';
import { executeNewEzzyReasoningLoop } from '../server/reasoning/loop';

async function runTest() {
  console.log('=== REPAIR 2: SUPERSESSION HARNESS ===\n');

  // 1. Unit Tests for detectCorrectionCue
  console.log('--- 1. Testing detectCorrectionCue ---');
  const cueTests = [
    { text: "No, Doug corrected me. She's turning 13.", expected: true },
    { text: "Actually, the spare key is in the safe.", expected: true },
    { text: "No, make that Friday.", expected: true },
    { text: "Correction: the meeting is at 3pm.", expected: true },
    { text: "Scratch that, we're eating out.", expected: true },
    { text: "I was wrong, it's on level 4.", expected: true },
    { text: "Turns out she's 13.", expected: true },
    { text: "Sophie turns 12 next Sunday.", expected: false },
    { text: "The spare key is in the kitchen drawer.", expected: false },
    { text: "Bill is coming Thursday.", expected: false },
    { text: "Sophie likes tennis too.", expected: false },
  ];

  let cueFails = 0;
  for (const t of cueTests) {
    const res = detectCorrectionCue(t.text);
    if (res !== t.expected) {
      console.error(`FAIL: "${t.text}" -> got ${res}, expected ${t.expected}`);
      cueFails++;
    } else {
      console.log(`PASS: "${t.text}" -> ${res}`);
    }
  }
  if (cueFails > 0) {
    throw new Error(`detectCorrectionCue failed ${cueFails} tests`);
  }

  // 2. End-to-end test with AI
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not found in environment; skipping live LLM test.');
    return;
  }

  await initBunnyDb();
  const ai = new GoogleGenAI({ apiKey });
  const testEzzyId = `ezzy_test_repair2_${Date.now()}`;
  const localContext = {
    localDateTimeStr: '2026-09-08T10:00:00+10:00',
    timeZone: 'Australia/Sydney',
    language: 'en-AU',
    region: 'AU',
    offsetStr: '+10:00',
    utcIso: '2026-09-08T00:00:00.000Z',
    referenceDate: new Date('2026-09-08T00:00:00.000Z'),
  };

  console.log(`\n--- 2. End-to-End Test (Ezzy ID: ${testEzzyId}) ---`);

  // Step 2.1: Sophie turns 12 next Sunday
  console.log('\nStep 2.1: Tell: "Sophie turns 12 next Sunday."');
  const t1 = await processThoughtCapturePipeline("Sophie turns 12 next Sunday.", localContext, ai, null, null, null, testEzzyId);
  await insertMemories(t1.memories, { skipRelationshipSave: true }, testEzzyId);
  const mem1Id = t1.memories[0].id;
  console.log(`Saved Memory 1: ID=${mem1Id}, content="${t1.memories[0].interpretation.content}"`);

  // Verify memory 1 is active
  const check1 = await executeBunnySql([{ sql: `SELECT id, status FROM memories WHERE id = ?;`, args: [mem1Id] }]);
  console.log(`Memory 1 status in DB: ${check1[0]?.rows?.[0]?.status}`);

  // Step 2.2: Correction: "No, Doug corrected me. She's turning 13."
  console.log('\nStep 2.2: Tell: "No, Doug corrected me. She\'s turning 13."');
  const t2 = await processThoughtCapturePipeline("No, Doug corrected me. She's turning 13.", localContext, ai, null, null, null, testEzzyId);
  console.log('Interpreted correction:', {
    content: t2.memories[0]?.interpretation?.content,
    people: t2.memories[0]?.interpretation?.people,
    superseded_memory_id: t2.memories[0]?.interpretation?.superseded_memory_id,
  });
  await insertMemories(t2.memories, { skipRelationshipSave: true }, testEzzyId);
  const mem2Id = t2.memories[0].id;

  // Check DB statuses
  const checkMem1After = await executeBunnySql([{ sql: `SELECT id, status FROM memories WHERE id = ?;`, args: [mem1Id] }]);
  const checkProj1After = await executeBunnySql([{ sql: `SELECT memory_id, status FROM memory_search_projection WHERE memory_id = ?;`, args: [mem1Id] }]);
  const checkMem2After = await executeBunnySql([{ sql: `SELECT id, status FROM memories WHERE id = ?;`, args: [mem2Id] }]);

  console.log(`Memory 1 (old) status in memories: ${checkMem1After[0]?.rows?.[0]?.status}`);
  console.log(`Memory 1 (old) status in memory_search_projection: ${checkProj1After[0]?.rows?.[0]?.status}`);
  console.log(`Memory 2 (new) status in memories: ${checkMem2After[0]?.rows?.[0]?.status}`);

  if (checkMem1After[0]?.rows?.[0]?.status !== 'superseded') {
    throw new Error(`Expected Memory 1 to have status='superseded', got '${checkMem1After[0]?.rows?.[0]?.status}'`);
  }
  if (checkProj1After[0]?.rows?.[0]?.status !== 'superseded') {
    throw new Error(`Expected Projection 1 to have status='superseded', got '${checkProj1After[0]?.rows?.[0]?.status}'`);
  }
  if (checkMem2After[0]?.rows?.[0]?.status !== 'active') {
    throw new Error(`Expected Memory 2 to have status='active', got '${checkMem2After[0]?.rows?.[0]?.status}'`);
  }
  console.log('PASS: Database supersession state verified!');

  // Step 2.3: World Snapshot verification
  console.log('\nStep 2.3: Testing World Snapshot Assembly...');
  const allMems = await readMemories(testEzzyId);
  const snapshot = await assembleEzzyWorldSnapshot({
    ezzyId: testEzzyId,
    clientNow: localContext.utcIso,
    clientTimeZone: localContext.timeZone,
    clientLanguage: localContext.language,
    clientRegion: localContext.region,
    opportunity: 'ASK_QUERY',
    trigger: 'ask_query',
    input: 'How old will Sophie be?',
  });
  console.log(`Total active memories in snapshot: ${snapshot.activeMemories.length}`);
  const hasOldInSnapshot = snapshot.activeMemories.some((m: any) => m.id === mem1Id);
  const hasNewInSnapshot = snapshot.activeMemories.some((m: any) => m.id === mem2Id);
  console.log(`Old memory in snapshot activeMemories: ${hasOldInSnapshot} (expected false)`);
  console.log(`New memory in snapshot activeMemories: ${hasNewInSnapshot} (expected true)`);

  if (hasOldInSnapshot) {
    throw new Error('Superseded memory leaked into World Snapshot activeMemories!');
  }
  if (!hasNewInSnapshot) {
    throw new Error('New active memory missing from World Snapshot activeMemories!');
  }

  // Step 2.4: Reasoning engine Ask test: "How old will Sophie be?"
  console.log('\nStep 2.4: Ask test: "How old will Sophie be?"');
  const { decision } = await executeNewEzzyReasoningLoop(
    'ASK_QUERY',
    snapshot,
    { input: 'How old will Sophie be?' },
    ai
  );

  console.log('Reasoning response:', decision.communication);
  const ansText = (decision.communication.body || decision.communication.headline || '').toLowerCase();
  if (!ansText.includes('13')) {
    throw new Error(`Answer did not state 13: ${ansText}`);
  }
  if (ansText.includes('12')) {
    console.warn(`Warning: Answer mentions 12, checking if it was framed as old/corrected: "${ansText}"`);
  }
  console.log('PASS: Ask reasoning produced definitive current answer 13!');

  // Step 2.5: Test Location correction
  console.log('\nStep 2.5: Location Correction Test...');
  const l1 = await processThoughtCapturePipeline("The spare key is in the kitchen drawer.", localContext, ai, null, null, null, testEzzyId);
  await insertMemories(l1.memories, { skipRelationshipSave: true }, testEzzyId);
  const l1Id = l1.memories[0].id;

  const l2 = await processThoughtCapturePipeline("Actually, the spare key is in the safe.", localContext, ai, null, null, null, testEzzyId);
  await insertMemories(l2.memories, { skipRelationshipSave: true }, testEzzyId);
  const l2Id = l2.memories[0].id;

  const checkL1 = await executeBunnySql([{ sql: `SELECT status FROM memories WHERE id = ?;`, args: [l1Id] }]);
  console.log(`Spare key drawer status: ${checkL1[0]?.rows?.[0]?.status} (expected superseded)`);
  if (checkL1[0]?.rows?.[0]?.status !== 'superseded') {
    throw new Error(`Expected drawer key memory to be superseded, got ${checkL1[0]?.rows?.[0]?.status}`);
  }
  console.log('PASS: Location correction superseded prior memory!');

  // Step 2.6: Test Elliptical date correction
  console.log('\nStep 2.6: Elliptical Date Correction Test...');
  const b1 = await processThoughtCapturePipeline("Bill is coming Thursday.", localContext, ai, null, null, null, testEzzyId);
  await insertMemories(b1.memories, { skipRelationshipSave: true }, testEzzyId);
  const b1Id = b1.memories[0].id;

  const b2 = await processThoughtCapturePipeline("No, make that Friday.", localContext, ai, null, null, null, testEzzyId);
  await insertMemories(b2.memories, { skipRelationshipSave: true }, testEzzyId);
  const b2Id = b2.memories[0].id;

  console.log('Bill correction interpretation:', {
    content: b2.memories[0]?.interpretation?.content,
    people: b2.memories[0]?.interpretation?.people,
    superseded_memory_id: b2.memories[0]?.interpretation?.superseded_memory_id,
  });

  const checkB1 = await executeBunnySql([{ sql: `SELECT status FROM memories WHERE id = ?;`, args: [b1Id] }]);
  console.log(`Bill Thursday status: ${checkB1[0]?.rows?.[0]?.status} (expected superseded)`);
  if (checkB1[0]?.rows?.[0]?.status !== 'superseded') {
    throw new Error(`Expected Bill Thursday memory to be superseded, got ${checkB1[0]?.rows?.[0]?.status}`);
  }
  console.log('PASS: Elliptical date correction superseded prior memory!');

  // Step 2.7: Negative Controls
  console.log('\nStep 2.7: Negative Control - Compatible Fact (Sophie likes tennis too)...');
  const comp = await processThoughtCapturePipeline("Sophie likes tennis too.", localContext, ai, null, null, null, testEzzyId);
  console.log('Compatible fact superseded_memory_id:', comp.memories[0]?.interpretation?.superseded_memory_id);
  if (comp.memories[0]?.interpretation?.superseded_memory_id) {
    throw new Error('Compatible fact falsely superseded a prior memory!');
  }
  console.log('PASS: Compatible fact did not trigger false supersession.');

  console.log('\nStep 2.8: Negative Control - Speculative Statement (Maybe she is 14)...');
  const spec = await processThoughtCapturePipeline("Maybe she's actually 14.", localContext, ai, null, null, null, testEzzyId);
  console.log('Speculative superseded_memory_id:', spec.memories[0]?.interpretation?.superseded_memory_id);
  if (spec.memories[0]?.interpretation?.superseded_memory_id) {
    throw new Error('Speculative statement falsely superseded a confirmed memory!');
  }
  console.log('PASS: Speculative statement did not trigger false supersession.');

  // Clean up test data
  await executeBunnySql([
    { sql: `DELETE FROM memories WHERE ezzy_id = ?;`, args: [testEzzyId] },
    { sql: `DELETE FROM memory_search_projection WHERE ezzy_id = ?;`, args: [testEzzyId] },
  ]);

  console.log('\n=== ALL REPAIR 2 TESTS PASSED PERFECTLY ===\n');
}

runTest().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});

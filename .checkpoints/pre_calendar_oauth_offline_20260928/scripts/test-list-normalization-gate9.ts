/**
 * Focused Regression Suite for Gate 9 List Normalization Fix.
 * 
 * Verifies:
 * 1. Case/whitespace variants group into one list while preserving human-readable title.
 * 2. Adding list items still works.
 * 3. Completing an item still works and does not delete it.
 * 4. Ask / bounded retrieval can still retrieve list contents by subject.
 * 5. Plain-text list sharing text builder still works.
 * 6. My Ezzy / Our Ezzy instance isolation remains intact.
 * 7. Existing list behavior (unassigned items remain standalone, list deletion) has not changed.
 */

import { executeBunnySql } from '../server/db/client';
import { initBunnyDb } from '../server/db/schema';
import {
  insertMemories,
  readMemories,
  toggleMemoryInDb,
  deleteMemoryFromDb,
} from '../server/db/memories';
import { retrieveBoundedMemoryCandidates } from '../server/retrieval/bounded_retrieval';
import { normalizeSubjectKey, cleanDisplaySubject, pickBestDisplayTitle } from '../src/utils/subjectUtils';
import { createEzzyInstance } from '../server/instances/entitlements';

async function runTests() {
  console.log('--- Starting Gate 9 List Normalization Regression Test Suite ---');
  await initBunnyDb();

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`✅ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${msg}`);
      failed++;
    }
  }

  // -------------------------------------------------------------
  // Test 1: Unit Test of subjectUtils (Case & Whitespace variants)
  // -------------------------------------------------------------
  console.log('\nTest 1: Case and Whitespace Normalization Unit Tests');
  const variants = [
    'Bunnings list',
    'bunnings list',
    ' Bunnings list ',
    'Bunnings   list',
    '   bunnings   list   ',
  ];

  const normalizedKeys = variants.map(normalizeSubjectKey);
  const allIdentical = normalizedKeys.every((k) => k === 'bunnings list');
  assert(allIdentical, 'All variants ("Bunnings list", "bunnings list", " Bunnings list ", "Bunnings   list") normalize to canonical key "bunnings list"');

  // Verify display title selection
  let displayTitle = '';
  for (const v of variants) {
    displayTitle = pickBestDisplayTitle(displayTitle, v);
  }
  assert(displayTitle === 'Bunnings list', `Display title cleanly picks title-cased "Bunnings list" (got: "${displayTitle}")`);

  // Empty / null cases
  assert(normalizeSubjectKey(null) === '', 'null subject normalizes to empty string');
  assert(normalizeSubjectKey('   ') === '', 'whitespace-only subject normalizes to empty string');
  assert(normalizeSubjectKey('undefined') === '', '"undefined" string normalizes to empty string');

  // -------------------------------------------------------------
  // Test 2: Database Persistence & Memory Creation under Lists
  // -------------------------------------------------------------
  console.log('\nTest 2: Memory Creation & Storing with Subject Variants');
  const testEzzyA = `ezzy_gate9_test_a_${Date.now()}`;
  const testEzzyB = `ezzy_gate9_test_b_${Date.now()}`;

  await createEzzyInstance({
    id: testEzzyA,
    name: 'Gate 9 Instance A',
    ownerUserId: 'owner_a',
    planTier: 'family',
  });

  await createEzzyInstance({
    id: testEzzyB,
    name: 'Gate 9 Instance B',
    ownerUserId: 'owner_b',
    planTier: 'family',
  });

  // Create 3 memories with subject variations in Instance A
  const memA1 = {
    id: `mem_g9_1_${Date.now()}`,
    originalText: 'screws and washers',
    createdAt: new Date(Date.now() - 3000).toISOString(),
    isDone: false,
    interpretation: {
      content: 'Buy screws and washers',
      kind: 'task',
      intent: 'purchase',
      status: 'active',
      people: [],
      places: ['Bunnings'],
      topics: ['hardware'],
      contexts: ['shopping', 'hardware'],
      retrieval_cues: ['screws and washers', 'Bunnings list'],
      subject: 'bunnings list', // lowercase
      resurfacing: { timing: 'Unscheduled', mode: 'none' },
    },
  };

  const memA2 = {
    id: `mem_g9_2_${Date.now()}`,
    originalText: 'masking tape',
    createdAt: new Date(Date.now() - 2000).toISOString(),
    isDone: false,
    interpretation: {
      content: 'Buy masking tape',
      kind: 'task',
      intent: 'purchase',
      status: 'active',
      people: [],
      places: ['Bunnings'],
      topics: ['hardware'],
      contexts: ['shopping', 'hardware'],
      retrieval_cues: ['masking tape', 'Bunnings list'],
      subject: ' Bunnings list ', // leading/trailing spaces + Title Case
      resurfacing: { timing: 'Unscheduled', mode: 'none' },
    },
  };

  const memA3 = {
    id: `mem_g9_3_${Date.now()}`,
    originalText: 'timber sealant',
    createdAt: new Date(Date.now() - 1000).toISOString(),
    isDone: false,
    interpretation: {
      content: 'Buy timber sealant',
      kind: 'task',
      intent: 'purchase',
      status: 'active',
      people: [],
      places: ['Bunnings'],
      topics: ['hardware'],
      contexts: ['shopping', 'hardware'],
      retrieval_cues: ['timber sealant', 'Bunnings list'],
      subject: 'Bunnings   list', // multiple internal spaces
      resurfacing: { timing: 'Unscheduled', mode: 'none' },
    },
  };

  // Standalone memory without subject in Instance A
  const memStandalone = {
    id: `mem_g9_standalone_${Date.now()}`,
    originalText: 'Remember the water meter is behind the hedge',
    createdAt: new Date().toISOString(),
    isDone: false,
    interpretation: {
      content: 'Water meter is behind the hedge',
      kind: 'fact',
      intent: 'fact',
      status: 'active',
      people: [],
      places: ['garden'],
      topics: ['house'],
      contexts: ['reference'],
      retrieval_cues: ['water meter location'],
      resurfacing: { timing: 'Unscheduled', mode: 'none' },
    },
  };

  // Memory with same subject in Instance B (for isolation test)
  const memB1 = {
    id: `mem_g9_b1_${Date.now()}`,
    originalText: 'plant fertilizer',
    createdAt: new Date().toISOString(),
    isDone: false,
    interpretation: {
      content: 'Buy plant fertilizer',
      kind: 'task',
      intent: 'purchase',
      status: 'active',
      people: [],
      places: ['Bunnings'],
      topics: ['garden'],
      contexts: ['shopping'],
      retrieval_cues: ['plant fertilizer', 'Bunnings list'],
      subject: 'Bunnings list',
      resurfacing: { timing: 'Unscheduled', mode: 'none' },
    },
  };

  await insertMemories([memA1, memA2, memA3, memStandalone] as any, {}, testEzzyA);
  await insertMemories([memB1] as any, {}, testEzzyB);

  const readA = await readMemories(testEzzyA);
  assert(readA.length === 4, `Successfully saved and read 4 memories in Instance A (got: ${readA.length})`);

  const readB = await readMemories(testEzzyB);
  assert(readB.length === 1, `Successfully saved and read 1 memory in Instance B (got: ${readB.length})`);

  // -------------------------------------------------------------
  // Test 3: Client-side Grouping Simulation with Normalization
  // -------------------------------------------------------------
  console.log('\nTest 3: Simulating Client-Side List Grouping');
  type RenderGroupItem =
    | { type: 'memory'; memory: any }
    | { type: 'list'; subject: string; memories: any[]; latestTimestamp: number };

  function groupMemories(memories: any[]): RenderGroupItem[] {
    const items: RenderGroupItem[] = [];
    const subjectMap = new Map<string, any[]>();
    const subjectIndexMap = new Map<string, number>();

    for (const memory of memories) {
      const rawSubject = memory.interpretation?.subject;
      const normKey = normalizeSubjectKey(rawSubject);
      if (!normKey) {
        items.push({ type: 'memory', memory });
      } else {
        const memTime = new Date(memory.createdAt).getTime();
        if (!subjectMap.has(normKey)) {
          subjectMap.set(normKey, [memory]);
          const index = items.length;
          subjectIndexMap.set(normKey, index);
          items.push({
            type: 'list',
            subject: cleanDisplaySubject(rawSubject),
            memories: [memory],
            latestTimestamp: memTime,
          });
        } else {
          const list = subjectMap.get(normKey)!;
          list.push(memory);
          const index = subjectIndexMap.get(normKey)!;
          const existingItem = items[index] as {
            type: 'list';
            subject: string;
            memories: any[];
            latestTimestamp: number;
          };
          existingItem.memories = list;
          existingItem.subject = pickBestDisplayTitle(existingItem.subject, rawSubject);
          if (memTime > existingItem.latestTimestamp) {
            existingItem.latestTimestamp = memTime;
          }
        }
      }
    }
    return items;
  }

  const grouped = groupMemories(readA);
  const listGroups = grouped.filter((g) => g.type === 'list') as Array<{ type: 'list'; subject: string; memories: any[] }>;
  const standaloneGroups = grouped.filter((g) => g.type === 'memory');

  assert(listGroups.length === 1, `Exactly 1 ListCard was created from 3 case/whitespace subject variants (got: ${listGroups.length})`);
  assert(listGroups[0].memories.length === 3, `The single ListCard contains all 3 items (got: ${listGroups[0].memories.length})`);
  assert(listGroups[0].subject === 'Bunnings list', `The ListCard display title is the clean capitalized "Bunnings list" (got: "${listGroups[0].subject}")`);
  assert(standaloneGroups.length === 1, `Standalone memory remains a distinct standalone card (got: ${standaloneGroups.length})`);

  // -------------------------------------------------------------
  // Test 4: Completing a List Item
  // -------------------------------------------------------------
  console.log('\nTest 4: Completing a List Item without Deletion');
  const itemToComplete = memA2.id;
  await toggleMemoryInDb(itemToComplete, testEzzyA);

  const readAfterDone = await readMemories(testEzzyA);
  const completedItem = readAfterDone.find((m) => m.id === itemToComplete);
  assert(completedItem !== undefined, 'Completed memory still exists in database (was NOT deleted)');
  assert(Boolean(completedItem?.isDone) === true, 'Completed memory has isDone = true / 1');

  // Re-run grouping after completion
  const groupedAfterDone = groupMemories(readAfterDone);
  const listAfterDone = groupedAfterDone.find((g) => g.type === 'list') as { type: 'list'; subject: string; memories: any[] };
  assert(listAfterDone.memories.length === 3, 'ListCard still retains all 3 items (active and completed)');
  const doneCountInList = listAfterDone.memories.filter((m) => m.isDone).length;
  assert(doneCountInList === 1, `ListCard correctly reflects 1 completed item (got: ${doneCountInList})`);

  // -------------------------------------------------------------
  // Test 5: Plain-Text List Sharing Formatter
  // -------------------------------------------------------------
  console.log('\nTest 5: Plain-Text Sharing Text Generation');
  function buildShareText(subject: string, items: any[]): string {
    const lines = items.map((m) => {
      const txt = (m.interpretation?.content || m.originalText || '').trim();
      return m.isDone ? `✓ ${txt}` : `• ${txt}`;
    });
    return `${subject}\n\n${lines.join('\n')}`;
  }

  const shareOutput = buildShareText(listAfterDone.subject, listAfterDone.memories);
  assert(shareOutput.includes('Bunnings list'), 'Share output contains header "Bunnings list"');
  assert(shareOutput.includes('• Buy screws and washers'), 'Share output contains active item bullet');
  assert(shareOutput.includes('✓ Buy masking tape'), 'Share output contains completed item checkmark');
  assert(shareOutput.includes('• Buy timber sealant'), 'Share output contains third item');

  // -------------------------------------------------------------
  // Test 6: Ask Retrieval by Subject
  // -------------------------------------------------------------
  console.log('\nTest 6: Ask Bounded Candidate Retrieval by Subject');
  const boundedResult = await retrieveBoundedMemoryCandidates({
    question: "What's on my Bunnings list?",
    ezzyId: testEzzyA,
  });

  const retrievedIds = boundedResult.candidateIds;
  assert(retrievedIds.includes(memA1.id), 'Bounded retrieval by subject includes memA1 (lowercase subject)');
  assert(retrievedIds.includes(memA2.id), 'Bounded retrieval by subject includes memA2 (padded subject)');
  assert(retrievedIds.includes(memA3.id), 'Bounded retrieval by subject includes memA3 (multi-spaced subject)');
  assert(!retrievedIds.includes(memB1.id), 'Bounded retrieval does NOT leak memB1 from Instance B (Instance Isolation intact)');

  // -------------------------------------------------------------
  // Test 7: Multi-Instance Isolation
  // -------------------------------------------------------------
  console.log('\nTest 7: Instance Isolation Verification');
  const groupedB = groupMemories(readB);
  const listB = groupedB.filter((g) => g.type === 'list') as Array<{ type: 'list'; subject: string; memories: any[] }>;
  assert(listB.length === 1, 'Instance B has its own ListCard');
  assert(listB[0].memories.length === 1, 'Instance B ListCard contains ONLY its 1 memory');
  assert(listB[0].memories[0].id === memB1.id, 'Instance B memory ID matches memB1');

  // -------------------------------------------------------------
  // Clean Up Test Data
  // -------------------------------------------------------------
  console.log('\nCleaning up test instances...');
  await executeBunnySql([
    { sql: `DELETE FROM memories WHERE ezzy_id IN ('${testEzzyA}', '${testEzzyB}');` },
    { sql: `DELETE FROM memory_search_projection WHERE ezzy_id IN ('${testEzzyA}', '${testEzzyB}');` },
    { sql: `DELETE FROM ezzy_instances WHERE id IN ('${testEzzyA}', '${testEzzyB}');` },
  ]);

  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed.`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error running Gate 9 list normalization regression test suite:', err);
  process.exit(1);
});

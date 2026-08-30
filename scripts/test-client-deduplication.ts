import { deduplicateMemories } from '../src/App';
import { MemoryItem } from '../src/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ Assertion Failed: ${message}`);
    process.exit(1);
  }
  console.log(`✅ Passed: ${message}`);
}

function runDeduplicationRegressionTests() {
  console.log('================================================================================');
  console.log('  CLASS C — UNIT / SYNTHETIC PASS: CLIENT MEMORY DEDUPLICATION & STATE TESTS    ');
  console.log('  Note: Pure logic assertions on memory state arrays. Does not prove live UI.  ');
  console.log('================================================================================\n');

  const mockItem1: MemoryItem = {
    id: 'mem_david_scientist',
    originalText: 'David is my scientist',
    createdAt: '2026-08-28T19:46:59.062Z',
    isDone: false,
    interpretation: {
      content: 'David is my scientist',
      kind: 'fact',
      intent: 'general_statement',
      status: 'active',
      resolved_datetime: null,
      people: ['David'],
      places: [],
      topics: ['work'],
      retrieval_cues: ['scientist', 'David'],
      prerequisite: null,
      relationships: [{ person: 'David', role: 'scientist' }],
      resurfacing: { mode: 'passive', timing: 'on_demand' }
    }
  };

  const mockItem2: MemoryItem = {
    id: 'mem_steve_plumber',
    originalText: 'Ring Steve the plumber tomorrow at 2pm',
    createdAt: '2026-08-28T19:40:00.000Z',
    isDone: false,
    interpretation: {
      content: 'Ring Steve the plumber',
      kind: 'reminder',
      intent: 'contact',
      status: 'active',
      resolved_datetime: '2026-08-29T14:00:00.000Z',
      reminder_time_expression: 'tomorrow at 2pm',
      people: ['Steve'],
      places: [],
      topics: ['plumber'],
      retrieval_cues: ['plumber', 'Steve'],
      prerequisite: null,
      relationships: [{ person: 'Steve', role: 'plumber' }],
      resurfacing: { mode: 'active', timing: 'scheduled' }
    }
  };

  // Test 1: Deduplication of identical ID in array
  console.log('--- Test 1: Duplicate Memory ID in React State ---');
  const duplicatedState = [mockItem1, mockItem2, { ...mockItem1 }];
  const deduplicated = deduplicateMemories(duplicatedState);

  assert(deduplicated.length === 2, 'Deduplicated array length must be 2 when duplicate ID is introduced');
  assert(deduplicated[0].id === 'mem_david_scientist', 'First element ID must be preserved in order');
  assert(deduplicated[1].id === 'mem_steve_plumber', 'Second element ID must be preserved in order');

  // Test 2: Editing a memory updates exactly one item and keeps uniqueness
  console.log('\n--- Test 2: Edit Memory State Transition ---');
  const editedItem1: MemoryItem = {
    ...mockItem1,
    originalText: 'David is my research scientist',
    interpretation: {
      ...mockItem1.interpretation,
      content: 'David is my research scientist'
    }
  };

  // Simulating state update: setMemories((prev) => deduplicateMemories(prev.map(m => m.id === id ? edited : m)))
  const stateBeforeEdit = deduplicateMemories([mockItem1, mockItem2]);
  const stateAfterEdit = deduplicateMemories(
    stateBeforeEdit.map((item) => (item.id === 'mem_david_scientist' ? editedItem1 : item))
  );

  assert(stateAfterEdit.length === 2, 'State after edit must contain exactly 2 cards');
  const davidCards = stateAfterEdit.filter((m) => m.id === 'mem_david_scientist');
  assert(davidCards.length === 1, 'Only 1 David card exists in visible state');
  assert(davidCards[0].originalText === 'David is my research scientist', 'Visible card has updated text');

  // Test 3: Clarification resolution integration without twins
  console.log('\n--- Test 3: Clarification Resolution Integration ---');
  // Initial state has the reminder
  let state = [mockItem2];

  // User resolves clarification -> new FACT card returned + fetchMemories returns both items
  const newlyCreatedFact = { ...mockItem1 };
  const serverFetchedMemories = [newlyCreatedFact, mockItem2];

  // If local update prepends newlyCreatedFact:
  state = deduplicateMemories([newlyCreatedFact, ...state]);
  assert(state.length === 2, 'State after local clarification resolution has 2 items');

  // Network refetch completes:
  state = deduplicateMemories([...serverFetchedMemories]);
  assert(state.length === 2, 'State after fetchMemories() completes remains exactly 2 items (no twins)');
  assert(state.filter((m) => m.id === mockItem1.id).length === 1, 'David fact ID appears exactly once');

  // Test 4: Edge cases (empty array, null items)
  console.log('\n--- Test 4: Edge Cases & Resiliency ---');
  assert(deduplicateMemories([]).length === 0, 'Empty array returns empty array');
  assert(deduplicateMemories(null as any).length === 0, 'Null returns empty array');
  assert(deduplicateMemories([null, undefined, mockItem1] as any).length === 1, 'Handles non-object entries cleanly');

  console.log('\n================================================================================');
  console.log('  CLASS C — UNIT / SYNTHETIC TESTS PASSED (100%)                                ');
  console.log('================================================================================\n');
}

runDeduplicationRegressionTests();

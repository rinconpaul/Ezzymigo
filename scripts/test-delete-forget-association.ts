import { findAssociatedRelationships } from '../src/utils/relationshipAssociation';
import { MemoryItem, UserRelationship, StructuredInterpretation } from '../src/types';
import { readActiveRelationships } from '../server/relationships/index';

const activeTestRelationships: UserRelationship[] = [
  {
    id: 'rel_wife_barb',
    person: 'Barb',
    role: 'wife',
    normalized_role: 'wife',
    is_active: true,
    updated_at: new Date().toISOString(),
  },
  {
    id: 'rel_brother_tom',
    person: 'Tom',
    role: 'brother',
    normalized_role: 'brother',
    is_active: true,
    updated_at: new Date().toISOString(),
  },
  {
    id: 'rel_friend_dan',
    person: 'Dan',
    role: 'friend',
    normalized_role: 'friend',
    is_active: true,
    updated_at: new Date().toISOString(),
  },
  {
    id: 'rel_colleague_rob',
    person: 'Rob',
    role: 'colleague',
    normalized_role: 'colleague',
    is_active: true,
    updated_at: new Date().toISOString(),
  },
];

function createMockMemory(
  id: string,
  text: string,
  interpretationPartial?: Partial<StructuredInterpretation>
): MemoryItem {
  return {
    id,
    originalText: text,
    createdAt: new Date().toISOString(),
    isDone: false,
    interpretation: {
      content: text,
      kind: 'thought',
      status: 'active',
      people: [],
      places: [],
      topics: [],
      resurfacing: { mode: 'none', timing: '' },
      relationships: [],
      ...interpretationPartial,
    },
  };
}

interface TestCase {
  name: string;
  memory: MemoryItem;
  relationships: UserRelationship[];
  expectedPersons: string[]; // List of person names expected to be associated
}

const testCases: TestCase[] = [
  // 1. Defect regression: "clean the barbecue" must NOT associate Barb
  {
    name: '"clean the barbecue" must NOT associate Barb',
    memory: createMockMemory('mem_bbq_1', 'clean the barbecue', {
      kind: 'reminder',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: [],
  },

  // 2. Defect regression: "go to the barber" must NOT associate Barb
  {
    name: '"go to the barber" must NOT associate Barb',
    memory: createMockMemory('mem_barber_1', 'go to the barber', {
      kind: 'task',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: [],
  },

  // 3. Defect regression: "buy a barbell" must NOT associate Barb
  {
    name: '"buy a barbell" must NOT associate Barb',
    memory: createMockMemory('mem_barbell_1', 'buy a barbell', {
      kind: 'task',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: [],
  },

  // 4. Positive association: "call Barb" MUST associate Barb
  {
    name: '"call Barb" MUST associate Barb',
    memory: createMockMemory('mem_call_barb', 'call Barb', {
      kind: 'task',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: ['Barb'],
  },

  // 5. Positive association: "remind Barb about dinner" MUST associate Barb
  {
    name: '"remind Barb about dinner" MUST associate Barb',
    memory: createMockMemory('mem_remind_barb', 'remind Barb about dinner', {
      kind: 'reminder',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: ['Barb'],
  },

  // 6. Structured association: explicitly containing Barb in people MUST associate Barb
  {
    name: 'A structured memory explicitly containing Barb in people MUST associate Barb',
    memory: createMockMemory('mem_struct_barb', 'Dinner reservation at 7pm', {
      kind: 'reminder',
      people: ['Barb'],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: ['Barb'],
  },

  // 7. Structured association via relationships array
  {
    name: 'A structured memory containing Barb in relationships array MUST associate Barb',
    memory: createMockMemory('mem_struct_rel_barb', 'Check medicine schedule', {
      kind: 'reminder',
      people: [],
      relationships: [{ person: 'Barb', role: 'wife' }],
    }),
    relationships: activeTestRelationships,
    expectedPersons: ['Barb'],
  },

  // 8. Unrelated memory offering only normal deletion
  {
    name: 'Deleting an unrelated memory must offer only normal deletion (empty associations)',
    memory: createMockMemory('mem_unrelated', 'Change air filters in hallway', {
      kind: 'task',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: [],
  },

  // 9. Collision-prone name: Tom / tomorrow
  {
    name: '"see you tomorrow" must NOT associate Tom',
    memory: createMockMemory('mem_tomorrow_1', 'see you tomorrow', {
      kind: 'thought',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: [],
  },

  // 10. Collision-prone name: Tom / meeting tomorrow morning
  {
    name: '"meeting tomorrow morning" must NOT associate Tom',
    memory: createMockMemory('mem_tomorrow_2', 'meeting tomorrow morning at 9am', {
      kind: 'task',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: [],
  },

  // 11. Collision-prone name: Tom / bottom drawer
  {
    name: '"check the bottom drawer" must NOT associate Tom',
    memory: createMockMemory('mem_bottom_1', 'check the bottom drawer for spare keys', {
      kind: 'task',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: [],
  },

  // 12. Positive association: "call Tom" MUST associate Tom
  {
    name: '"call Tom" MUST associate Tom',
    memory: createMockMemory('mem_call_tom', 'call Tom', {
      kind: 'task',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: ['Tom'],
  },

  // 13. Combined name & collision word: "remind Tom about lunch tomorrow" MUST associate Tom (and not confuse tomorrow)
  {
    name: '"remind Tom about lunch tomorrow" MUST associate Tom',
    memory: createMockMemory('mem_tom_tomorrow', 'remind Tom about lunch tomorrow', {
      kind: 'reminder',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: ['Tom'],
  },

  // 14. Structured Tom memory MUST associate Tom
  {
    name: 'A structured memory containing Tom in people MUST associate Tom',
    memory: createMockMemory('mem_struct_tom', 'Pick up tickets', {
      kind: 'task',
      people: ['Tom'],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: ['Tom'],
  },

  // 15. Collision-prone name: Dan / dance
  {
    name: '"attend the salsa dance class" must NOT associate Dan',
    memory: createMockMemory('mem_dan_dance', 'attend the salsa dance class', {
      kind: 'task',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: [],
  },

  // 16. Collision-prone name: Rob / problem
  {
    name: '"fix the plumbing problem" must NOT associate Rob',
    memory: createMockMemory('mem_rob_problem', 'fix the plumbing problem', {
      kind: 'task',
      people: [],
      relationships: [],
    }),
    relationships: activeTestRelationships,
    expectedPersons: [],
  },
];

async function runTests() {
  console.log('================================================================');
  console.log('RUNNING DEFECT FIX REGRESSION TESTS FOR DELETE/FORGET ASSOCIATION');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    const associated = findAssociatedRelationships(tc.memory, tc.relationships);
    const associatedPersons = associated.map((r) => r.person);

    const matchesExpected =
      associatedPersons.length === tc.expectedPersons.length &&
      tc.expectedPersons.every((p) => associatedPersons.includes(p));

    if (matchesExpected) {
      console.log(`[PASS] ${tc.name}`);
      console.log(`       Memory text: "${tc.memory.originalText}"`);
      console.log(`       Associated: [${associatedPersons.join(', ')}]\n`);
      passed++;
    } else {
      console.error(`[FAIL] ${tc.name}`);
      console.error(`       Memory text: "${tc.memory.originalText}"`);
      console.error(`       Expected: [${tc.expectedPersons.join(', ')}]`);
      console.error(`       Actual:   [${associatedPersons.join(', ')}]\n`);
      failed++;
    }
  }

  // Verify DB state for actual Barb relationship to guarantee integrity
  console.log('----------------------------------------------------------------');
  console.log('VERIFYING DATABASE RELATIONSHIPS INTEGRITY:');
  const activeDbRels = await readActiveRelationships();
  const barbRel = activeDbRels.find((r) => r.person.toLowerCase() === 'barb');
  if (barbRel && barbRel.is_active) {
    console.log(`[PASS] Barb relationship remains intact and active in DB:`);
    console.log(`       ID: ${barbRel.id}, Person: ${barbRel.person}, Role: ${barbRel.role}, Active: ${barbRel.is_active}`);
    passed++;
  } else {
    console.error(`[FAIL] Barb relationship was unexpectedly missing or inactive!`);
    failed++;
  }

  console.log('================================================================');
  console.log(`SUMMARY: Total Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});

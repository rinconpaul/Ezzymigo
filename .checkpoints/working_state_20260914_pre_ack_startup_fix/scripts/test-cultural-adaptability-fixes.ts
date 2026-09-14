import { initBunnyDb } from '../server/db/schema.js';
import { executeBunnySql } from '../server/db/client.js';
import {
  saveRelationships,
  readActiveRelationships,
  deactivateUserRelationship,
  evaluateKnowledgeModification,
  extractPhoneNumber,
  mergeRelationshipsWithExtracted,
} from '../server/relationships/index.js';
import { createEzzyInstance } from '../server/instances/entitlements.js';

async function runTests() {
  console.log('===============================================================');
  console.log('FOCUSED REGRESSION SUITE: CULTURAL & ARCHITECTURAL REPAIRS');
  console.log('===============================================================\n');

  await initBunnyDb();

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` (${detail})` : ''}`);
      failed++;
    }
  }

  const TEST_INSTANCE_1 = 'ezzy_test_adapt_1';
  const TEST_INSTANCE_2 = 'ezzy_test_adapt_2';
  const TEST_USER = 'user_adapt_test';

  // Ensure test instances exist
  try {
    await createEzzyInstance({ id: TEST_INSTANCE_1, name: 'Adaptability Test 1', ownerUserId: TEST_USER });
    await createEzzyInstance({ id: TEST_INSTANCE_2, name: 'Adaptability Test 2', ownerUserId: TEST_USER });
  } catch {}

  // Clean up any test relationships in these instances before starting
  await executeBunnySql([
    { sql: 'DELETE FROM user_relationships WHERE ezzy_id IN (?, ?);', args: [TEST_INSTANCE_1, TEST_INSTANCE_2] },
    { sql: 'DELETE FROM user_entities WHERE ezzy_id IN (?, ?);', args: [TEST_INSTANCE_1, TEST_INSTANCE_2] },
  ]);

  // --------------------------------------------------------------------------
  // TEST 1: Adding a second plumber does not silently deactivate the first
  // --------------------------------------------------------------------------
  console.log('--- Test 1: Multiple Plumbers Coexistence ---');
  await saveRelationships(
    [{ person: 'Steve', role: 'plumber', is_active: true }],
    { skipSuppressionCheck: true },
    TEST_INSTANCE_1
  );

  let activeRels = await readActiveRelationships(TEST_INSTANCE_1);
  assert(
    activeRels.some(r => r.person === 'Steve' && r.normalized_role === 'plumber'),
    'First plumber (Steve) is active after initial save'
  );

  // Now add a second plumber (Dave)
  await saveRelationships(
    [{ person: 'Dave', role: 'plumber', is_active: true }],
    { skipSuppressionCheck: true },
    TEST_INSTANCE_1
  );

  activeRels = await readActiveRelationships(TEST_INSTANCE_1);
  const steveActive = activeRels.some(r => r.person === 'Steve' && r.normalized_role === 'plumber');
  const daveActive = activeRels.some(r => r.person === 'Dave' && r.normalized_role === 'plumber');

  assert(
    steveActive && daveActive,
    'Both Steve and Dave remain concurrently active plumbers without silent deactivation',
    `Steve active: ${steveActive}, Dave active: ${daveActive}, total active: ${activeRels.length}`
  );

  // Also test in-memory mergeRelationshipsWithExtracted
  const mergedPlumbers = mergeRelationshipsWithExtracted(
    [{ person: 'Steve', role: 'plumber', normalized_role: 'plumber', is_active: true }],
    [{ person: 'Dave', role: 'plumber', is_active: true }]
  );
  assert(
    mergedPlumbers.filter(r => r.normalized_role === 'plumber' && r.is_active).length === 2,
    'mergeRelationshipsWithExtracted preserves both plumbers in-memory'
  );

  // --------------------------------------------------------------------------
  // TEST 2: Adding another doctor/GP does not silently remove an existing relationship
  // --------------------------------------------------------------------------
  console.log('\n--- Test 2: Multiple Doctors / GPs Coexistence ---');
  await saveRelationships(
    [{ person: 'Dr Dave', role: 'GP', is_active: true }],
    { skipSuppressionCheck: true },
    TEST_INSTANCE_1
  );
  await saveRelationships(
    [{ person: 'Dr Sarah', role: 'doctor', is_active: true }],
    { skipSuppressionCheck: true },
    TEST_INSTANCE_1
  );
  await saveRelationships(
    [{ person: 'Dr Smith', role: 'GP', is_active: true }],
    { skipSuppressionCheck: true },
    TEST_INSTANCE_1
  );

  activeRels = await readActiveRelationships(TEST_INSTANCE_1);
  const drDaveActive = activeRels.some(r => r.person === 'Dr Dave');
  const drSarahActive = activeRels.some(r => r.person === 'Dr Sarah');
  const drSmithActive = activeRels.some(r => r.person === 'Dr Smith');

  assert(
    drDaveActive && drSarahActive && drSmithActive,
    'Dr Dave, Dr Sarah, and Dr Smith are all concurrently active medical relationships',
    `Dr Dave: ${drDaveActive}, Dr Sarah: ${drSarahActive}, Dr Smith: ${drSmithActive}`
  );

  // --------------------------------------------------------------------------
  // TEST 3: Intentional relationship correction and explicit replacement
  // --------------------------------------------------------------------------
  console.log('\n--- Test 3: Intentional Relationship Modification & Replacement ---');

  // 3A: Explicit cross-person replacement ("Pete replaced Steve as my plumber")
  const modReplace1 = await evaluateKnowledgeModification('Pete replaced Steve as my plumber', TEST_INSTANCE_1);
  assert(
    modReplace1.handled && modReplace1.answer?.includes('Pete has replaced Steve'),
    'Explicit person replacement query handled: "Pete replaced Steve as my plumber"',
    modReplace1.answer
  );

  activeRels = await readActiveRelationships(TEST_INSTANCE_1);
  const peteActive = activeRels.some(r => r.person === 'Pete' && r.normalized_role === 'plumber');
  const steveDeactivated = !activeRels.some(r => r.person === 'Steve' && r.normalized_role === 'plumber');
  const daveStillActive = activeRels.some(r => r.person === 'Dave' && r.normalized_role === 'plumber');

  assert(
    peteActive && steveDeactivated && daveStillActive,
    'Explicit replacement activated Pete, deactivated Steve, and left unrelated Dave intact',
    `Pete: ${peteActive}, Steve inactive: ${steveDeactivated}, Dave: ${daveStillActive}`
  );

  // 3B: Explicit replacement via "instead of" ("Dr Jane is my GP instead of Dr Dave")
  const modReplace2 = await evaluateKnowledgeModification('Dr Jane is my GP instead of Dr Dave', TEST_INSTANCE_1);
  assert(
    modReplace2.handled && modReplace2.answer?.includes('Dr Jane has replaced Dr Dave'),
    'Explicit replacement query handled: "Dr Jane is my GP instead of Dr Dave"',
    modReplace2.answer
  );

  activeRels = await readActiveRelationships(TEST_INSTANCE_1);
  const drJaneActive = activeRels.some(r => r.person === 'Dr Jane');
  const drDaveDeactivated = !activeRels.some(r => r.person === 'Dr Dave');
  assert(
    drJaneActive && drDaveDeactivated,
    'Dr Jane is now active GP and Dr Dave was intentionally deactivated',
    `Dr Jane: ${drJaneActive}, Dr Dave inactive: ${drDaveDeactivated}`
  );

  // 3C: Standalone role forget ("Dr Sarah isn't my doctor anymore")
  const modForget = await evaluateKnowledgeModification("Dr Sarah isn't my doctor anymore", TEST_INSTANCE_1);
  assert(
    modForget.handled && modForget.answer?.includes('forgotten that Dr Sarah is your doctor'),
    'Explicit role deactivation handled: "Dr Sarah isn\'t my doctor anymore"'
  );
  activeRels = await readActiveRelationships(TEST_INSTANCE_1);
  assert(
    !activeRels.some(r => r.person === 'Dr Sarah'),
    'Dr Sarah successfully deactivated after explicit forget'
  );

  // 3D: Genuinely exclusive personal roles (wife / husband / spouse / partner)
  console.log('\n--- Test 3D: Genuine Exclusive Personal Roles (wife/husband/spouse/partner) ---');
  await saveRelationships(
    [{ person: 'Barb', role: 'wife', is_active: true }],
    { skipSuppressionCheck: true },
    TEST_INSTANCE_1
  );
  activeRels = await readActiveRelationships(TEST_INSTANCE_1);
  assert(
    activeRels.some(r => r.person === 'Barb' && r.normalized_role === 'wife'),
    'Barb initially saved as active wife'
  );

  // New wife declared: should supersede previous wife according to exclusive personal semantics
  await saveRelationships(
    [{ person: 'Sarah', role: 'wife', is_active: true }],
    { skipSuppressionCheck: true },
    TEST_INSTANCE_1
  );
  activeRels = await readActiveRelationships(TEST_INSTANCE_1);
  const sarahWifeActive = activeRels.some(r => r.person === 'Sarah' && r.normalized_role === 'wife');
  const barbWifeInactive = !activeRels.some(r => r.person === 'Barb' && r.normalized_role === 'wife');
  assert(
    sarahWifeActive && barbWifeInactive,
    'Exclusive personal role (wife) correctly supersedes previous holder',
    `Sarah active: ${sarahWifeActive}, Barb inactive: ${barbWifeInactive}`
  );

  // --------------------------------------------------------------------------
  // TEST 4: Existing Australian phone number behaviour remains intact
  // --------------------------------------------------------------------------
  console.log('\n--- Test 4: Australian Phone Number Parsing Invariants ---');

  const auCases = [
    { input: 'Call Bob on 0412 345 678 today', expected: '0412 345 678', desc: 'AU mobile spaced' },
    { input: 'Bob phone: 0412345678', expected: '0412345678', desc: 'AU mobile continuous' },
    { input: 'Mob: 0412-345-678', expected: '0412-345-678', desc: 'AU mobile hyphenated' },
    { input: 'Call landline (02) 9876 5432 please', expected: '(02) 9876 5432', desc: 'AU landline with parens' },
    { input: 'Office is 02 9876 5432', expected: '02 9876 5432', desc: 'AU landline standard' },
    { input: 'Ring local 9876 5432 now', expected: '9876 5432', desc: 'AU local 8-digit landline' },
    { input: 'Support is 1300 123 456', expected: '1300 123 456', desc: 'AU 1300 smart number' },
    { input: 'Freecall 1800 123 456', expected: '1800 123 456', desc: 'AU 1800 toll free' },
    { input: 'Crisis line 13 11 14', expected: '13 11 14', desc: 'AU 6-digit priority service' },
    { input: 'International AU +61 412 345 678', expected: '+61 412 345 678', desc: 'AU international format' },
  ];

  for (const tc of auCases) {
    const res = extractPhoneNumber(tc.input);
    assert(
      res.phoneNumber === tc.expected,
      `AU parsing: ${tc.desc}`,
      `Got "${res.phoneNumber}", expected "${tc.expected}"`
    );
  }

  // --------------------------------------------------------------------------
  // TEST 5: Non-Australian / International format numbers are not chopped or corrupted
  // --------------------------------------------------------------------------
  console.log('\n--- Test 5: Non-Australian & International E.164 Phone Parsing ---');

  const intlCases = [
    { input: 'Sister in USA on +1 415 555 2671', expected: '+1 415 555 2671', desc: 'US standard international' },
    { input: 'Contact New York +1 (555) 234-5678', expected: '+1 (555) 234-5678', desc: 'US parens international' },
    { input: 'London office at +44 20 7946 0958', expected: '+44 20 7946 0958', desc: 'UK standard international' },
    { input: 'Tokyo partner +81 90 2345 6789', expected: '+81 90 2345 6789', desc: 'Japan international (was previously chopped into 8-digit AU)' },
    { input: 'Paris office +33 1 42 68 55 55', expected: '+33 1 42 68 55 55', desc: 'France international' },
    { input: 'Auckland team +64 21 123 4567', expected: '+64 21 123 4567', desc: 'New Zealand international' },
    { input: 'Mumbai contact +91 98765 43210', expected: '+91 98765 43210', desc: 'India international' },
  ];

  for (const tc of intlCases) {
    const res = extractPhoneNumber(tc.input);
    assert(
      res.phoneNumber === tc.expected,
      `Intl parsing: ${tc.desc}`,
      `Got "${res.phoneNumber}", expected "${tc.expected}"`
    );
  }

  // Negative controls (non-phones must return null)
  const negativeCases = [
    { input: 'Dave quoted $450 to clean gutters on 2026-09-07', desc: 'Currency & ISO date' },
    { input: 'Price increased by +$50 for the job', desc: 'Plus sign currency' },
    { input: 'The weather will be +15 degrees today', desc: 'Temperature with plus sign' },
  ];

  for (const nc of negativeCases) {
    const res = extractPhoneNumber(nc.input);
    assert(
      res.phoneNumber === null,
      `Negative control: ${nc.desc}`,
      `Got "${res.phoneNumber}", expected null`
    );
  }

  // --------------------------------------------------------------------------
  // TEST 6: Ezzy-Instance Isolation Verification
  // --------------------------------------------------------------------------
  console.log('\n--- Test 6: Ezzy-Instance Isolation ---');

  // Save relationships in Instance A and Instance B
  await saveRelationships(
    [{ person: 'Alice', role: 'accountant', is_active: true }],
    { skipSuppressionCheck: true },
    TEST_INSTANCE_1
  );
  await saveRelationships(
    [{ person: 'Bob', role: 'accountant', is_active: true }],
    { skipSuppressionCheck: true },
    TEST_INSTANCE_2
  );

  const relsA = await readActiveRelationships(TEST_INSTANCE_1);
  const relsB = await readActiveRelationships(TEST_INSTANCE_2);

  const aHasAlice = relsA.some(r => r.person === 'Alice');
  const aHasBob = relsA.some(r => r.person === 'Bob');
  const bHasBob = relsB.some(r => r.person === 'Bob');
  const bHasAlice = relsB.some(r => r.person === 'Alice');

  assert(
    aHasAlice && !aHasBob && bHasBob && !bHasAlice,
    'Instance A and Instance B maintain completely isolated relationships',
    `A:[Alice:${aHasAlice}, Bob:${aHasBob}] B:[Bob:${bHasBob}, Alice:${bHasAlice}]`
  );

  // Deactivate in Instance A and verify Instance B is untouched
  await deactivateUserRelationship('Alice', 'accountant', TEST_INSTANCE_1);
  const relsAAfter = await readActiveRelationships(TEST_INSTANCE_1);
  const relsBAfter = await readActiveRelationships(TEST_INSTANCE_2);

  assert(
    !relsAAfter.some(r => r.person === 'Alice') && relsBAfter.some(r => r.person === 'Bob'),
    'Deactivation in Instance A does not leak or affect Instance B',
    `A count: ${relsAAfter.length}, B Bob still active: ${relsBAfter.some(r => r.person === 'Bob')}`
  );

  // --------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------
  console.log('\n===============================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

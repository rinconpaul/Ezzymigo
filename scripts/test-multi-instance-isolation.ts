import { initBunnyDb } from '../server/db/schema.js';
import { executeBunnySql } from '../server/db/client.js';
import {
  createEzzyInstance,
  getEzzyInstance,
  updateEzzyInstance,
  listEzzyInstances,
  addEzzyMember,
  removeEzzyMember,
  getEzzyMembers,
  checkEzzyEntitlement,
  checkEzzyMembership,
  assertEzzyWriteAllowed,
  assertEzzyAccess,
  EntitlementViolation,
} from '../server/instances/entitlements.js';
import {
  readMemories,
  readMemoryById,
  insertMemories,
  updateMemoryInDb,
  toggleMemoryInDb,
  deleteMemoryFromDb,
} from '../server/db/memories.js';
import {
  readActiveRelationships,
  saveRelationships,
  deactivateUserRelationship,
  resolveRelationshipsInQuery,
  getUserEntities,
  saveUserEntity,
  forgetUserEntity,
} from '../server/relationships/index.js';
import {
  readCalendarEvents,
  upsertCalendarEvents,
  deleteCalendarEventFromDb,
} from '../server/calendar/store.js';
import {
  getEzzyOccasionPreferences,
  saveEzzyOccasionPreferences,
  getUserOccasionPreferences,
  saveUserOccasionPreferences,
} from '../server/db/occasions.js';
import { retrieveBoundedMemoryCandidates } from '../server/retrieval/bounded_retrieval.js';
import { computeTodayRelevance } from '../server/today/relevance.js';
import { formatLocalTimeContext } from '../server/utils/time.js';

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passedCount++;
  } else {
    console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failedCount++;
  }
}

async function runMultiInstanceProof() {
  console.log('================================================================');
  console.log('  EZZYMIGO MULTI-INSTANCE ISOLATION & ENTITLEMENT VERIFICATION');
  console.log('================================================================\n');

  await initBunnyDb();

  const INSTANCE_A = 'test_ezzy_alpha';
  const INSTANCE_B = 'test_ezzy_beta';

  async function cleanupInstanceData(instId: string) {
    await executeBunnySql([
      { sql: 'DELETE FROM memories WHERE ezzy_id = ?', args: [instId] },
      { sql: 'DELETE FROM memory_search_projection WHERE ezzy_id = ?', args: [instId] },
      { sql: 'DELETE FROM memory_entities WHERE ezzy_id = ?', args: [instId] },
      { sql: 'DELETE FROM scheduled_reminders WHERE ezzy_id = ?', args: [instId] },
      { sql: 'DELETE FROM user_relationships WHERE ezzy_id = ?', args: [instId] },
      { sql: 'DELETE FROM user_entities WHERE ezzy_id = ?', args: [instId] },
      { sql: 'DELETE FROM calendar_events WHERE ezzy_id = ?', args: [instId] },
      { sql: 'DELETE FROM ezzy_occasion_preferences WHERE ezzy_id = ?', args: [instId] },
      { sql: 'DELETE FROM ezzy_members WHERE ezzy_id = ?', args: [instId] },
      { sql: 'DELETE FROM ezzy_instances WHERE id = ?', args: [instId] },
    ]);
  }

  try {
    // -------------------------------------------------------------
    // CLEANUP PREVIOUS RUN
    // -------------------------------------------------------------
    console.log('--- Step 0: Clean up any previous test instances ---');
    for (const instId of [INSTANCE_A, INSTANCE_B]) {
      await cleanupInstanceData(instId);
    }
    console.log('Cleanup complete.\n');

    // -------------------------------------------------------------
    // SECTION 1: INSTANCES & ENTITLEMENT BOUNDARY
    // -------------------------------------------------------------
    console.log('--- Section 1: Entitlement Boundaries & Member Limits ---');

    // Create Instance A: active, premium, max_members 5
    const instA = await createEzzyInstance({
      id: INSTANCE_A,
      name: 'Alpha Family Hub',
      ownerUserId: 'user_a_owner',
      plan: 'premium_family',
      status: 'active',
      max_members: 5,
    });
    assert(instA.id === INSTANCE_A, 'Instance A created with ID test_ezzy_alpha');
    assert(instA.status === 'active', 'Instance A status is active');
    assert(instA.member_limit === 5, 'Instance A member_limit is 5');

    // Create Instance B: trial, free_trial, max_members 2
    const instB = await createEzzyInstance({
      id: INSTANCE_B,
      name: 'Beta Solo Practice',
      ownerUserId: 'user_b_owner',
      plan: 'free_trial',
      status: 'trial',
      max_members: 2,
    });
    assert(instB.id === INSTANCE_B, 'Instance B created with ID test_ezzy_beta');
    assert(instB.status === 'trial', 'Instance B status is trial');
    assert(instB.member_limit === 2, 'Instance B member_limit is 2');

    // Test member additions for Instance B up to limit (2).
    // Note: user_b_owner is already member 1.
    const m2 = await addEzzyMember(INSTANCE_B, 'user_b2', { displayName: 'User B2', role: 'member' });
    assert(m2.user_id === 'user_b2', 'Added member 2 to Instance B');

    // Attempt to add member 3 to Instance B (should throw MEMBER_LIMIT_REACHED)
    let memberLimitThrew = false;
    try {
      await addEzzyMember(INSTANCE_B, 'user_b3', { displayName: 'User B3' });
    } catch (err: any) {
      memberLimitThrew = err instanceof EntitlementViolation && (err.code === 'MEMBER_LIMIT_REACHED' || err.code === 'MEMBER_LIMIT_EXCEEDED');
    }
    assert(memberLimitThrew, 'Member limit strictly enforced (MEMBER_LIMIT_REACHED on 3rd member for limit 2)');

    // Test entitlement checks for trial
    const trialCheck = await checkEzzyEntitlement(INSTANCE_B, 'write');
    assert(trialCheck.allowed === true, 'Trial instance allows writes while within trial period');

    // Update Instance B to expired
    await updateEzzyInstance(INSTANCE_B, { status: 'expired' });
    const expiredWriteCheck = await checkEzzyEntitlement(INSTANCE_B, 'write');
    assert(expiredWriteCheck.allowed === false, 'Expired instance forbids writes');
    assert(expiredWriteCheck.effectiveStatus === 'expired', 'Expired check returns status "expired"');

    const expiredReadCheck = await checkEzzyEntitlement(INSTANCE_B, 'read');
    assert(expiredReadCheck.allowed === true, 'Expired instance permits read-only data access');

    let writeAssertionFailed = false;
    try {
      await assertEzzyWriteAllowed(INSTANCE_B);
    } catch (err: any) {
      writeAssertionFailed = err instanceof EntitlementViolation && err.code === 'ENTITLEMENT_EXPIRED';
    }
    assert(writeAssertionFailed, 'assertEzzyWriteAllowed throws EntitlementViolation for expired instance');

    // Restore Instance B to active for remainder of isolation proofs
    await updateEzzyInstance(INSTANCE_B, { status: 'active', max_members: 5 });
    console.log('Entitlement boundary tests passed.\n');

    // -------------------------------------------------------------
    // SECTION 2: MEMORIES ISOLATION
    // -------------------------------------------------------------
    console.log('--- Section 2: Memories & Entities Isolation ---');

    const itemA1 = {
      id: 'mem_alpha_01',
      createdAt: new Date().toISOString(),
      originalText: 'Alice is my sister who lives in Brisbane',
      interpretation: {
        action: 'create',
        content: 'Alice is sister who lives in Brisbane',
        kind: 'fact',
        type: 'fact',
        subject: 'Alice',
        people: ['Alice'],
        relationships: [{ person: 'Alice', role: 'sister', is_active: true }],
      },
    };

    const itemA2 = {
      id: 'mem_alpha_02',
      createdAt: new Date().toISOString(),
      originalText: 'Remember to pick up heart medication for Alice tomorrow at 3pm',
      interpretation: {
        action: 'create',
        content: 'Pick up heart medication for Alice',
        kind: 'reminder',
        type: 'reminder',
        subject: 'Heart Medication',
        people: ['Alice'],
        remind_at: '2026-09-06T15:00:00+10:00',
      },
    };

    const itemB1 = {
      id: 'mem_beta_01',
      createdAt: new Date().toISOString(),
      originalText: 'Bob is my accountant at Apex Financial',
      interpretation: {
        action: 'create',
        content: 'Bob is accountant at Apex Financial',
        kind: 'fact',
        type: 'fact',
        subject: 'Bob',
        people: ['Bob'],
        relationships: [{ person: 'Bob', role: 'accountant', is_active: true }],
      },
    };

    const itemB2 = {
      id: 'mem_beta_02',
      createdAt: new Date().toISOString(),
      originalText: 'Quarterly tax audit due on Monday at 9am',
      interpretation: {
        action: 'create',
        content: 'Quarterly tax audit due on Monday at 9am',
        kind: 'reminder',
        type: 'reminder',
        subject: 'Tax Audit',
        people: ['Bob'],
        remind_at: '2026-09-08T09:00:00+10:00',
      },
    };

    await insertMemories([itemA1], undefined, INSTANCE_A);
    await insertMemories([itemA2], undefined, INSTANCE_A);
    await insertMemories([itemB1], undefined, INSTANCE_B);
    await insertMemories([itemB2], undefined, INSTANCE_B);

    // Verify memories in Instance A
    const memoriesA = await readMemories(INSTANCE_A);
    assert(memoriesA.length === 2, 'Instance A has exactly 2 memories');
    assert(memoriesA.every((m) => !m.originalText.includes('Bob') && !m.originalText.includes('audit')),
      'Instance A memories contain zero references to Instance B data (no Bob, no audit)');

    // Verify memories in Instance B
    const memoriesB = await readMemories(INSTANCE_B);
    assert(memoriesB.length === 2, 'Instance B has exactly 2 memories');
    assert(memoriesB.every((m) => !m.originalText.includes('Alice') && !m.originalText.includes('heart medication')),
      'Instance B memories contain zero references to Instance A data (no Alice, no medication)');

    // Verify cross-instance read by ID isolation
    const alphaMemId = itemA1.id;
    const betaMemId = itemB1.id;

    const crossReadAfromB = await readMemoryById(alphaMemId, INSTANCE_B);
    assert(crossReadAfromB === null, 'Instance B cannot read memory ID from Instance A (returns null)');

    const crossReadBfromA = await readMemoryById(betaMemId, INSTANCE_A);
    assert(crossReadBfromA === null, 'Instance A cannot read memory ID from Instance B (returns null)');

    console.log('Memories isolation tests passed.\n');

    // -------------------------------------------------------------
    // SECTION 3: ENTITIES & RELATIONSHIPS ISOLATION
    // -------------------------------------------------------------
    console.log('--- Section 3: Entities & Relationships Isolation ---');

    await saveRelationships([{ person: 'Alice', role: 'sister', is_active: true }], undefined, INSTANCE_A);
    await saveRelationships([{ person: 'Bob', role: 'accountant', is_active: true }], undefined, INSTANCE_B);

    const relsA = await readActiveRelationships(INSTANCE_A);
    assert(relsA.some((r) => r.person.toLowerCase() === 'alice' && r.role.toLowerCase() === 'sister'),
      'Instance A has Alice as sister');
    assert(!relsA.some((r) => r.person.toLowerCase() === 'bob'),
      'Instance A has no accountant / Bob relationship');

    const relsB = await readActiveRelationships(INSTANCE_B);
    assert(relsB.some((r) => r.person.toLowerCase() === 'bob' && r.role.toLowerCase() === 'accountant'),
      'Instance B has Bob as accountant');
    assert(!relsB.some((r) => r.person.toLowerCase() === 'alice'),
      'Instance B has no sister / Alice relationship');

    // Test query resolution
    const queryResA = resolveRelationshipsInQuery('Call my sister tomorrow', relsA);
    assert(queryResA.resolvedEntities.some((e) => (e.resolvedPerson || (e as any).person)?.toLowerCase() === 'alice'),
      'Instance A resolves "sister" to Alice');

    const queryResB = resolveRelationshipsInQuery('Call my sister tomorrow', relsB);
    assert(queryResB.resolvedEntities.length === 0,
      'Instance B has NO match for "sister" (does not know Alice)');

    const queryResB2 = resolveRelationshipsInQuery('Email my accountant', relsB);
    assert(queryResB2.resolvedEntities.some((e) => (e.resolvedPerson || (e as any).person)?.toLowerCase() === 'bob'),
      'Instance B resolves "accountant" to Bob');

    const queryResA2 = resolveRelationshipsInQuery('Email my accountant', relsA);
    assert(queryResA2.resolvedEntities.length === 0,
      'Instance A has NO match for "accountant" (does not know Bob)');

    console.log('Relationships isolation tests passed.\n');

    // -------------------------------------------------------------
    // SECTION 4: CALENDAR CONTEXT ISOLATION
    // -------------------------------------------------------------
    console.log('--- Section 4: Calendar Context Isolation ---');

    const eventA = {
      id: 'cal_event_alpha_01',
      title: 'Dr. Smith Cardiologist with Alice',
      start_datetime: '2026-09-06T10:00:00+10:00',
      startDatetime: '2026-09-06T10:00:00+10:00',
      end_datetime: '2026-09-06T11:00:00+10:00',
      endDatetime: '2026-09-06T11:00:00+10:00',
      description: 'Check heart valve test results',
      location: 'Brisbane Cardiac Clinic',
    };

    const eventB = {
      id: 'cal_event_beta_01',
      title: 'Tax Planning with Bob at Apex',
      start_datetime: '2026-09-06T14:00:00+10:00',
      startDatetime: '2026-09-06T14:00:00+10:00',
      end_datetime: '2026-09-06T15:00:00+10:00',
      endDatetime: '2026-09-06T15:00:00+10:00',
      description: 'FY26 tax deductions strategy',
      location: 'Apex Financial Level 4',
    };

    await upsertCalendarEvents([eventA], INSTANCE_A);
    await upsertCalendarEvents([eventB], INSTANCE_B);

    const calEventsA = await readCalendarEvents({}, INSTANCE_A);
    assert(calEventsA.length === 1 && calEventsA[0].id === 'cal_event_alpha_01',
      'Instance A has exactly 1 calendar event (Dr. Smith)');
    assert(!calEventsA.some((e) => e.title.includes('Tax') || e.title.includes('Bob')),
      'Instance A calendar event contains no Instance B data');

    const calEventsB = await readCalendarEvents({}, INSTANCE_B);
    assert(calEventsB.length === 1 && calEventsB[0].id === 'cal_event_beta_01',
      'Instance B has exactly 1 calendar event (Tax Planning)');
    assert(!calEventsB.some((e) => e.title.includes('Dr. Smith') || e.title.includes('Alice')),
      'Instance B calendar event contains no Instance A data');

    // Cross-instance calendar deletion attempt: trying to delete eventA via INSTANCE_B
    await deleteCalendarEventFromDb('cal_event_alpha_01', INSTANCE_B);
    const calEventsAAfterCrossDelete = await readCalendarEvents({}, INSTANCE_A);
    assert(calEventsAAfterCrossDelete.length === 1 && calEventsAAfterCrossDelete[0].id === 'cal_event_alpha_01',
      'Attempting to delete Instance A calendar event from Instance B has ZERO effect on Instance A');

    console.log('Calendar context isolation tests passed.\n');

    // -------------------------------------------------------------
    // SECTION 5: BOUNDED RETRIEVAL (ASK SCOPING) ISOLATION
    // -------------------------------------------------------------
    console.log('--- Section 5: Bounded Candidate Retrieval Isolation ---');

    const localContext = formatLocalTimeContext('2026-09-05T12:00:00+10:00', 'Australia/Brisbane', 'en-AU', 'AU');

    // Query for "sister" in Instance A
    const boundedA1 = await retrieveBoundedMemoryCandidates({
      question: 'Who is my sister and where does she live?',
      localContext,
      activeRelationships: relsA,
      userEntities: await getUserEntities(INSTANCE_A),
      ezzyId: INSTANCE_A,
    });
    assert(boundedA1.candidateMemories.length >= 1, 'Instance A retrieved candidate memories for sister');
    assert(boundedA1.candidateMemories.some((m) => m.originalText.includes('Alice')),
      'Instance A candidate memory identifies Alice');
    assert(!boundedA1.candidateMemories.some((m) => m.originalText.includes('Bob')),
      'Instance A candidate memory has zero Bob/Instance B data');

    // Query for "sister" in Instance B
    const boundedB1 = await retrieveBoundedMemoryCandidates({
      question: 'Who is my sister and where does she live?',
      localContext,
      activeRelationships: relsB,
      userEntities: await getUserEntities(INSTANCE_B),
      ezzyId: INSTANCE_B,
    });
    assert(!boundedB1.candidateMemories.some((m) => m.originalText.includes('Alice')),
      'Instance B candidate memories contain ZERO Alice / sister data (no leakage)');
    assert(boundedB1.telemetry.entityLaneCount === 0 && boundedB1.telemetry.exactSubjectLaneCount === 0 && boundedB1.telemetry.ftsLaneCount === 0,
      'Instance B has 0 entity/subject/FTS matches for sister');

    // Query for "accountant" in Instance A
    const boundedA2 = await retrieveBoundedMemoryCandidates({
      question: 'When do I meet with my accountant?',
      localContext,
      activeRelationships: relsA,
      userEntities: await getUserEntities(INSTANCE_A),
      ezzyId: INSTANCE_A,
    });
    assert(!boundedA2.candidateMemories.some((m) => m.originalText.includes('Bob')),
      'Instance A candidate memories contain ZERO Bob / accountant data (no leakage)');
    assert(boundedA2.telemetry.entityLaneCount === 0 && boundedA2.telemetry.exactSubjectLaneCount === 0 && boundedA2.telemetry.ftsLaneCount === 0,
      'Instance A has 0 entity/subject/FTS matches for accountant');

    // Query for "accountant" in Instance B
    const boundedB2 = await retrieveBoundedMemoryCandidates({
      question: 'When do I meet with my accountant?',
      localContext,
      activeRelationships: relsB,
      userEntities: await getUserEntities(INSTANCE_B),
      ezzyId: INSTANCE_B,
    });
    assert(boundedB2.candidateMemories.length >= 1, 'Instance B retrieved candidate memories for accountant');
    assert(boundedB2.candidateMemories.some((m) => m.originalText.includes('Bob')),
      'Instance B candidate memory identifies Bob');
    assert(!boundedB2.candidateMemories.some((m) => m.originalText.includes('Alice')),
      'Instance B candidate memory has zero Alice/Instance A data');

    console.log('Bounded retrieval isolation tests passed.\n');

    // -------------------------------------------------------------
    // SECTION 6: TODAY RELEVANCE & ANTICIPATORY BEHAVIOUR ISOLATION
    // -------------------------------------------------------------
    console.log('--- Section 6: Today Output & Anticipatory Behaviour Isolation ---');

    const todayA = await computeTodayRelevance(
      '2026-09-06T08:00:00+10:00',
      'Australia/Brisbane',
      'en-AU',
      'AU',
      [],
      INSTANCE_A
    );

    const todayB = await computeTodayRelevance(
      '2026-09-06T08:00:00+10:00',
      'Australia/Brisbane',
      'en-AU',
      'AU',
      [],
      INSTANCE_B
    );

    // Verify Instance A Today output
    const todayACandidates = todayA.candidates || [];
    console.log('DEBUG Instance A candidates:', JSON.stringify(todayACandidates.map(c => ({ source_type: c.source_type, display_text: c.display_text, event_title: c.event_title }))));
    assert(todayACandidates.some((c: any) => (c.display_text || '').includes('Dr. Smith') || (c.event_title || '').includes('Dr. Smith')),
      'Instance A Today output includes Dr. Smith appointment');
    assert(!todayACandidates.some((c: any) => (c.display_text || '').includes('Tax Planning')),
      'Instance A Today output NEVER contains Tax Planning (no Instance B leakage)');

    // Verify Instance B Today output
    const todayBCandidates = todayB.candidates || [];
    assert(todayBCandidates.some((c: any) => (c.display_text || '').includes('Tax Planning')),
      'Instance B Today output includes Tax Planning appointment');
    assert(!todayBCandidates.some((c: any) => (c.display_text || '').includes('Dr. Smith')),
      'Instance B Today output NEVER contains Dr. Smith (no Instance A leakage)');

    console.log('Today relevance & anticipatory output isolation tests passed.\n');

    // -------------------------------------------------------------
    // SECTION 7: MUTATION & DELETION ISOLATION
    // -------------------------------------------------------------
    console.log('--- Section 7: Mutation & Deletion Scoping ---');

    // Toggle memory in Instance A
    const toggledA = await toggleMemoryInDb(alphaMemId, INSTANCE_A);
    assert(toggledA?.isDone === true, 'Memory toggled in Instance A (isDone = true)');

    // Verify toggle in Instance A did not affect Instance B memories
    const memsBAfterToggle = await readMemories(INSTANCE_B);
    assert(memsBAfterToggle.every((m) => !m.isDone),
      'Instance B memories unchanged by toggle in Instance A (all remain isDone = false)');

    // Cross-instance toggle attempt: try toggling Instance A memory using Instance B ezzyId
    const crossToggle = await toggleMemoryInDb(alphaMemId, INSTANCE_B);
    assert(crossToggle === null, 'Cannot toggle Instance A memory when scoped to Instance B (returns null)');

    // Deactivate relationship in Instance A
    await deactivateUserRelationship('Alice', 'sister', INSTANCE_A);
    const relsAAfterDeact = await readActiveRelationships(INSTANCE_A);
    assert(relsAAfterDeact.length === 0, 'Alice relationship deactivated in Instance A');

    // Verify Instance B relationship remains active
    const relsBAfterDeact = await readActiveRelationships(INSTANCE_B);
    assert(relsBAfterDeact.length === 1 && relsBAfterDeact[0].person.toLowerCase() === 'bob',
      'Bob relationship in Instance B remains completely intact and active');

    // Delete memory from Instance A
    await deleteMemoryFromDb(alphaMemId, INSTANCE_A);
    const memsAAfterDelete = await readMemories(INSTANCE_A);
    assert(memsAAfterDelete.length === 1, 'Instance A memory deleted (1 remaining)');

    const memsBAfterDelete = await readMemories(INSTANCE_B);
    assert(memsBAfterDelete.length === 2, 'Instance B has all 2 memories intact (no deletion leakage)');

    // Cross-instance memory update attempt: try updating remaining Instance A memory using Instance B ezzyId
    const memA2Id = itemA2.id;
    const crossUpdateResult = await updateMemoryInDb(memA2Id, { action: 'update', content: 'Hacked text', type: 'note' }, 'Hacked text', INSTANCE_B);
    assert(crossUpdateResult === null, 'Cannot update Instance A memory from Instance B (returns null)');
    const memA2AfterCrossUpdate = await readMemoryById(memA2Id, INSTANCE_A);
    assert(memA2AfterCrossUpdate?.originalText !== 'Hacked text', 'Instance A memory text was NOT modified by Instance B update attempt');

    // Cross-instance entity forget attempt
    await saveUserEntity('Alice', 'sister', 'sister', 'person', {}, INSTANCE_A);
    await saveUserEntity('Bob', 'accountant', 'accountant', 'person', {}, INSTANCE_B);
    await forgetUserEntity('Alice', INSTANCE_B);
    const entitiesAAfterCrossForget = await getUserEntities(INSTANCE_A);
    assert(entitiesAAfterCrossForget.some((e) => e.name.toLowerCase() === 'alice'),
      'Attempting to forget Alice in Instance B does NOT delete or forget Alice in Instance A');

    console.log('Mutation and deletion isolation tests passed.\n');

    // -------------------------------------------------------------
    // SECTION 7b: OCCASIONS PREFERENCES ISOLATION (EZZY INSTANCE LEVEL)
    // -------------------------------------------------------------
    console.log('--- Section 7b: Occasions Preferences Isolation (Ezzy Instance Level) ---');

    await saveEzzyOccasionPreferences({
      country: 'AU',
      subdivision: 'ACT',
      selectedTraditions: ['vietnamese'],
      occasions: { au_mothers_day: true, au_fathers_day: true },
    }, INSTANCE_A);

    await saveEzzyOccasionPreferences({
      country: 'US',
      subdivision: 'CA',
      selectedTraditions: ['jewish'],
      occasions: { us_mothers_day: true, us_fathers_day: false },
    }, INSTANCE_B);

    const prefsA = await getEzzyOccasionPreferences(INSTANCE_A);
    assert(prefsA.country === 'AU' && prefsA.subdivision === 'ACT', 'Instance A has AU-ACT occasion preferences');
    assert(prefsA.occasions.au_mothers_day === true, 'Instance A has au_mothers_day enabled');
    assert(!prefsA.occasions.us_mothers_day, 'Instance A does NOT have Instance B occasions');

    const prefsB = await getEzzyOccasionPreferences(INSTANCE_B);
    assert(prefsB.country === 'US' && prefsB.subdivision === 'CA', 'Instance B has US-CA occasion preferences');
    assert(prefsB.occasions.us_mothers_day === true, 'Instance B has us_mothers_day enabled');
    assert(!prefsB.occasions.au_mothers_day, 'Instance B does NOT have Instance A occasions');

    // Mutate Instance B occasion preferences and verify Instance A is unaffected
    await saveEzzyOccasionPreferences({
      country: 'US',
      subdivision: 'CA',
      selectedTraditions: ['jewish'],
      occasions: { us_mothers_day: false, us_fathers_day: false },
    }, INSTANCE_B);

    const prefsAAfterBUpdate = await getEzzyOccasionPreferences(INSTANCE_A);
    assert(prefsAAfterBUpdate.country === 'AU' && prefsAAfterBUpdate.occasions.au_mothers_day === true,
      'Mutating Instance B occasion preferences leaves Instance A occasion preferences completely unaltered');

    console.log('Occasions preferences isolation tests passed.\n');

    // -------------------------------------------------------------
    // SECTION 8: BACKEND MEMBERSHIP ENFORCEMENT & SCENARIOS
    // -------------------------------------------------------------
    console.log('--- Section 8: Backend Membership Enforcement & Scenarios ---');

    // 8A. Member vs. Non-Member
    const memberA = 'user_a_owner';
    const nonMember = 'user_intruder_unknown';

    const nonMemberCheck = await checkEzzyMembership(INSTANCE_A, nonMember);
    assert(nonMemberCheck.isMember === false && nonMemberCheck.status === 'none',
      'checkEzzyMembership correctly identifies non-member as not a member');

    let nonMemberReadBlocked = false;
    try {
      await assertEzzyAccess(INSTANCE_A, nonMember, 'read');
    } catch (err: any) {
      nonMemberReadBlocked = err instanceof EntitlementViolation && (err.code === 'NOT_A_MEMBER' || err.code === 'MEMBERSHIP_REQUIRED');
    }
    assert(nonMemberReadBlocked, 'Non-member read blocked with NOT_A_MEMBER');

    let nonMemberWriteBlocked = false;
    try {
      await assertEzzyAccess(INSTANCE_A, nonMember, 'write');
    } catch (err: any) {
      nonMemberWriteBlocked = err instanceof EntitlementViolation && (err.code === 'NOT_A_MEMBER' || err.code === 'MEMBERSHIP_REQUIRED');
    }
    assert(nonMemberWriteBlocked, 'Non-member write blocked with NOT_A_MEMBER');

    let memberAccessAllowed = false;
    try {
      const accessResult = await assertEzzyAccess(INSTANCE_A, memberA, 'write');
      memberAccessAllowed = Boolean(accessResult?.instance && accessResult?.member?.user_id === memberA);
    } catch {
      memberAccessAllowed = false;
    }
    assert(memberAccessAllowed, 'Active member has authorized read/write access');

    // 8B. Addition of Authorized Member
    const newMemberId = 'user_a_collaborator';
    await addEzzyMember(INSTANCE_A, newMemberId, { displayName: 'Collaborator', role: 'member' });
    const addedMemberCheck = await checkEzzyMembership(INSTANCE_A, newMemberId);
    assert(addedMemberCheck.isMember === true && addedMemberCheck.status === 'active',
      'Newly added member is recognized as an active member');

    let addedMemberAccessAllowed = false;
    try {
      const accessResult = await assertEzzyAccess(INSTANCE_A, newMemberId, 'read');
      addedMemberAccessAllowed = Boolean(accessResult?.instance && accessResult?.member?.user_id === newMemberId);
    } catch {
      addedMemberAccessAllowed = false;
    }
    assert(addedMemberAccessAllowed, 'Newly added member successfully passes assertEzzyAccess');

    // 8C. Removal of Access
    await removeEzzyMember(INSTANCE_A, newMemberId);
    const removedMemberCheck = await checkEzzyMembership(INSTANCE_A, newMemberId);
    assert(removedMemberCheck.isMember === false, 'Removed member is no longer a member');

    let removedMemberAccessBlocked = false;
    try {
      await assertEzzyAccess(INSTANCE_A, newMemberId, 'read');
    } catch (err: any) {
      removedMemberAccessBlocked = err instanceof EntitlementViolation && (err.code === 'NOT_A_MEMBER' || err.code === 'MEMBERSHIP_REQUIRED');
    }
    assert(removedMemberAccessBlocked, 'Removed member access is immediately revoked (NOT_A_MEMBER)');

    // 8D. Expired Instance Entitlement with Membership Checks
    // Test expired instance entitlement with membership check
    await updateEzzyInstance(INSTANCE_A, { status: 'expired' });
    // Active member reading expired instance: allowed (data portability)
    const memberExpiredRead = await assertEzzyAccess(INSTANCE_A, memberA, 'read');
    assert(Boolean(memberExpiredRead?.instance && memberExpiredRead?.member), 'Active member can read expired instance (read-only grace)');
    // Active member writing to expired instance: rejected with ENTITLEMENT_EXPIRED
    let memberExpiredWriteBlocked = false;
    try {
      await assertEzzyAccess(INSTANCE_A, memberA, 'write');
    } catch (err: any) {
      memberExpiredWriteBlocked = err instanceof EntitlementViolation && err.code === 'ENTITLEMENT_EXPIRED';
    }
    assert(memberExpiredWriteBlocked, 'Active member write to expired instance blocked with ENTITLEMENT_EXPIRED');

    // Non-member attempting to read expired instance: blocked by NOT_A_MEMBER, NOT allowed read
    let nonMemberExpiredReadBlocked = false;
    try {
      await assertEzzyAccess(INSTANCE_A, nonMember, 'read');
    } catch (err: any) {
      nonMemberExpiredReadBlocked = err instanceof EntitlementViolation && (err.code === 'NOT_A_MEMBER' || err.code === 'MEMBERSHIP_REQUIRED');
    }
    assert(nonMemberExpiredReadBlocked, 'Non-member cannot read expired instance (NOT_A_MEMBER precedes read grace)');

    // Restore Instance A to active
    await updateEzzyInstance(INSTANCE_A, { status: 'active' });

    // 8E. Cross-Ezzy Isolation (Client-supplied ezzy_id is never proof of membership)
    const memberB = 'user_b_owner';
    let userBCrossAccessToABlocked = false;
    try {
      await assertEzzyAccess(INSTANCE_A, memberB, 'read');
    } catch (err: any) {
      userBCrossAccessToABlocked = err instanceof EntitlementViolation && (err.code === 'NOT_A_MEMBER' || err.code === 'MEMBERSHIP_REQUIRED');
    }
    assert(userBCrossAccessToABlocked, 'Member of Ezzy B supplying Ezzy A ID is strictly rejected (no membership in A)');

    let userACrossAccessToBBlocked = false;
    try {
      await assertEzzyAccess(INSTANCE_B, memberA, 'read');
    } catch (err: any) {
      userACrossAccessToBBlocked = err instanceof EntitlementViolation && (err.code === 'NOT_A_MEMBER' || err.code === 'MEMBERSHIP_REQUIRED');
    }
    assert(userACrossAccessToBBlocked, 'Member of Ezzy A supplying Ezzy B ID is strictly rejected (no membership in B)');

    // 8F. Relevance Pipeline & Occasion Preferences Membership Enforcement
    let relevanceNonMemberBlocked = false;
    try {
      await computeTodayRelevance(
        '2026-09-06T08:00:00+10:00',
        'Australia/Brisbane',
        'en-AU',
        'AU',
        [],
        INSTANCE_A,
        nonMember
      );
    } catch (err: any) {
      relevanceNonMemberBlocked = err instanceof EntitlementViolation && (err.code === 'NOT_A_MEMBER' || err.code === 'MEMBERSHIP_REQUIRED');
    }
    assert(relevanceNonMemberBlocked, 'computeTodayRelevance strictly enforces membership for non-member');

    let occasionPrefsNonMemberBlocked = false;
    try {
      await getEzzyOccasionPreferences(INSTANCE_A, nonMember);
    } catch (err: any) {
      occasionPrefsNonMemberBlocked = err instanceof EntitlementViolation && (err.code === 'NOT_A_MEMBER' || err.code === 'MEMBERSHIP_REQUIRED');
    }
    assert(occasionPrefsNonMemberBlocked, 'getEzzyOccasionPreferences strictly enforces membership for non-member');

    console.log('Backend membership enforcement tests passed.\n');

    // -------------------------------------------------------------
    // SECTION 9: CLEANUP TEST INSTANCES
    // -------------------------------------------------------------
    console.log('--- Step 9: Clean up test instances ---');
    for (const instId of [INSTANCE_A, INSTANCE_B]) {
      await cleanupInstanceData(instId);
    }
    console.log('Cleanup complete.\n');

  } catch (err: any) {
    console.error('Unexpected error during test execution:', err);
    failedCount++;
  }

  console.log('================================================================');
  console.log(`TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('================================================================');

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runMultiInstanceProof();

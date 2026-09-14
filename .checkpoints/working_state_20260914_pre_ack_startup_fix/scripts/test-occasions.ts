import {
  SUPPORTED_REGIONS,
  TRADITION_SOURCES,
  CATALOG_OCCASIONS,
  getRegionalOccasions,
  getTraditionOccasions,
  getDefaultOccasionPreferences,
} from '../src/data/occasionsCatalog';
import {
  getUserOccasionPreferences,
  saveUserOccasionPreferences,
  deleteUserOccasionPreferences,
} from '../server/db/occasions';
import { isMemoryEligibleForReflection } from '../server/today/relevance';
import { generateAnticipationOffer } from '../server/anticipatory/classifier';
import { MemoryItem, AnticipatoryMode } from '../src/types';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ [FAIL] ${msg}`);
    throw new Error(msg);
  }
  console.log(`  ✓ [PASS] ${msg}`);
}

async function runOccasionsTests() {
  console.log('================================================================================');
  console.log('RUNNING OCCASIONS FEATURE TESTS');
  console.log('================================================================================\n');

  let passed = 0;

  // ---------------------------------------------------------------------------
  // TEST 1: Supported Regions
  // ---------------------------------------------------------------------------
  console.log('[Test 1] Supported Regions Catalog');
  assert(SUPPORTED_REGIONS.length >= 6, 'Contains multiple countries and states');
  const actRegion = SUPPORTED_REGIONS.find((r) => r.id === 'AU-ACT');
  assert(Boolean(actRegion), 'Contains Australia — ACT');
  assert(actRegion?.countryCode === 'AU', 'AU-ACT country code is AU');
  assert(actRegion?.subdivisionCode === 'ACT', 'AU-ACT subdivision code is ACT');
  assert(actRegion?.displayName === 'Australia — ACT', 'AU-ACT displays as "Australia — ACT"');

  const usRegion = SUPPORTED_REGIONS.find((r) => r.id === 'US-CA');
  assert(Boolean(usRegion), 'Contains United States — California');
  passed += 5;

  // ---------------------------------------------------------------------------
  // TEST 2: Popular Regional Occasions for Australia
  // ---------------------------------------------------------------------------
  console.log('\n[Test 2] Popular Regional Occasions for Australia');
  const auOccasions = getRegionalOccasions('AU', 'ACT');
  const auNames = auOccasions.map((o) => o.name);

  assert(auNames.includes("Mother's Day"), 'AU includes Mother\'s Day');
  assert(auNames.includes("Father's Day"), 'AU includes Father\'s Day');
  assert(auNames.includes("Valentine's Day"), 'AU includes Valentine\'s Day');
  assert(auNames.includes('Christmas'), 'AU includes Christmas');
  assert(auNames.includes('Easter'), 'AU includes Easter');
  assert(auNames.includes("New Year's Eve"), 'AU includes New Year\'s Eve');
  assert(auNames.includes('ANZAC Day'), 'AU includes ANZAC Day');
  assert(auNames.includes('Boxing Day'), 'AU includes Boxing Day');
  assert(auNames.includes('Australia Day'), 'AU includes Australia Day');
  passed += 9;

  // ---------------------------------------------------------------------------
  // TEST 3: Traditions Sources (Cultural / Religious)
  // ---------------------------------------------------------------------------
  console.log('\n[Test 3] Traditions & Calendars Sources');
  const traditionIds = TRADITION_SOURCES.map((t) => t.id);
  assert(traditionIds.includes('vietnamese'), 'Traditions include Vietnamese');
  assert(traditionIds.includes('chinese_lunar'), 'Traditions include Chinese / Lunar');
  assert(traditionIds.includes('jewish'), 'Traditions include Jewish');
  assert(traditionIds.includes('islamic'), 'Traditions include Islamic');
  assert(traditionIds.includes('hindu'), 'Traditions include Hindu');
  assert(traditionIds.includes('christian'), 'Traditions include Christian');
  assert(traditionIds.includes('buddhist'), 'Traditions include Buddhist');
  assert(traditionIds.includes('sikh'), 'Traditions include Sikh');
  passed += 8;

  // ---------------------------------------------------------------------------
  // TEST 4: Vietnamese Tradition Occasions
  // ---------------------------------------------------------------------------
  console.log('\n[Test 4] Vietnamese Tradition Occasions');
  const vnOccasions = getTraditionOccasions('vietnamese');
  const vnNames = vnOccasions.map((o) => o.name);

  assert(vnNames.some((n) => n.includes('Tết Nguyên Đán')), 'Includes Tết Nguyên Đán');
  assert(vnNames.some((n) => n.includes('Mid-Autumn') || n.includes('Trung Thu')), 'Includes Mid-Autumn Festival');
  assert(vnNames.some((n) => n.includes('Vu Lan')), 'Includes Vu Lan');
  assert(vnNames.some((n) => n.includes('Ông Công Ông Táo') || n.includes('Kitchen Gods')), 'Includes Kitchen Gods\' Day');
  assert(vnNames.some((n) => n.includes('Hàn Thực') || n.includes('Cold Food')), 'Includes Cold Food Festival');
  passed += 5;

  // ---------------------------------------------------------------------------
  // TEST 5: Anticipatory Mode Support (PRE_ONLY, PRE_AND_POST, POST_ONLY, NONE)
  // ---------------------------------------------------------------------------
  console.log('\n[Test 5] Anticipatory Mode Behavior: PRE_ONLY vs PRE_AND_POST');
  const nye = CATALOG_OCCASIONS.find((o) => o.id === 'au_new_years_eve');
  assert(nye?.defaultAnticipatoryMode === 'PRE_ONLY', "New Year's Eve default mode is PRE_ONLY");

  const mothersDay = CATALOG_OCCASIONS.find((o) => o.id === 'au_mothers_day');
  assert(mothersDay?.defaultAnticipatoryMode === 'PRE_AND_POST', "Mother's Day default mode is PRE_AND_POST");

  // Verify PRE_ONLY in isMemoryEligibleForReflection:
  const preOnlyMemory: MemoryItem = {
    id: 'test_pre_only_mem',
    originalText: 'New Year’s Eve party with friends',
    createdAt: new Date().toISOString(),
    isDone: false,
    anticipatory_mode: 'PRE_ONLY',
    anticipatory_opted_in: true,
    interpretation: {
      kind: 'appointment',
      intent: 'appointment',
      content: 'New Year’s Eve party with friends',
      people: [],
      places: [],
      topics: ['party'],
      status: 'active',
      anticipatory_mode: 'PRE_ONLY',
      anticipatory_opted_in: true,
      resurfacing: { mode: 'none', timing: 'none' },
    },
  };

  const isEligibleReflection = isMemoryEligibleForReflection(preOnlyMemory);
  assert(isEligibleReflection === false, 'PRE_ONLY memories are NOT eligible for post-event reflection');

  // Verify PRE_AND_POST is eligible for reflection:
  const preAndPostMemory: MemoryItem = {
    ...preOnlyMemory,
    id: 'test_pre_and_post_mem',
    anticipatory_mode: 'PRE_AND_POST',
    interpretation: {
      ...preOnlyMemory.interpretation!,
      anticipatory_mode: 'PRE_AND_POST',
    },
  };
  const isPreAndPostEligible = isMemoryEligibleForReflection(preAndPostMemory);
  assert(isPreAndPostEligible === true, 'PRE_AND_POST memories ARE eligible for post-event reflection');

  // Verify generateAnticipationOffer for PRE_ONLY
  const preOnlyOffer = generateAnticipationOffer(
    { id: 'mem_1', content: 'ANZAC Day Dawn Service' },
    'PRE_ONLY'
  );
  assert(preOnlyOffer?.mode === 'PRE_ONLY', 'Offer mode is PRE_ONLY');
  assert(preOnlyOffer?.question.includes('heads-up beforehand'), 'Offer question asks for heads-up beforehand');
  assert(!preOnlyOffer?.question.includes('afterward'), 'Offer question does NOT ask for post-event check-in');
  passed += 7;

  // ---------------------------------------------------------------------------
  // TEST 6: Persistence in Bunny DB (Isolated Test User + Guard Enforcement)
  // ---------------------------------------------------------------------------
  console.log('\n[Test 6] Occasions Persistence in Database (Isolated Test User + Production Guard)');

  // 1. Verify Production Data Guard blocks mutating default_user
  let guardBlocked = false;
  try {
    await saveUserOccasionPreferences({ occasions: { au_fathers_day: false } }, 'default_user');
  } catch (guardErr: any) {
    if (guardErr.message?.includes('PRODUCTION DATA GUARD VIOLATION')) {
      guardBlocked = true;
    }
  }
  assert(guardBlocked, 'Production Data Guard successfully blocks test writes to protected default_user');

  // 2. Perform test persistence using isolated test-scoped ID
  const TEST_OCCASION_USER_ID = `test_isolated_user_occasions_${Date.now()}`;
  try {
    const initialPrefs = await getUserOccasionPreferences(TEST_OCCASION_USER_ID);
    assert(typeof initialPrefs.country === 'string', 'Initial prefs has valid country');
    assert(Array.isArray(initialPrefs.selectedTraditions), 'selectedTraditions is an array');
    assert(typeof initialPrefs.occasions === 'object', 'occasions is an object map');

    // Save custom preferences for isolated test user
    const updatedPrefs = await saveUserOccasionPreferences(
      {
        country: 'AU',
        subdivision: 'ACT',
        selectedTraditions: ['vietnamese'],
        occasions: {
          au_mothers_day: true,
          au_fathers_day: false,
          trad_vn_tet: true,
          trad_vn_cold_food: false,
        },
      },
      TEST_OCCASION_USER_ID
    );

    assert(updatedPrefs.country === 'AU', 'Saved country is AU');
    assert(updatedPrefs.subdivision === 'ACT', 'Saved subdivision is ACT');
    assert(updatedPrefs.selectedTraditions.includes('vietnamese'), 'Saved traditions includes vietnamese');
    assert(updatedPrefs.occasions['au_mothers_day'] === true, 'Saved au_mothers_day is true');
    assert(updatedPrefs.occasions['au_fathers_day'] === false, 'Saved au_fathers_day is false');
    assert(updatedPrefs.occasions['trad_vn_tet'] === true, 'Saved trad_vn_tet is true');
    assert(updatedPrefs.occasions['trad_vn_cold_food'] === false, 'Saved trad_vn_cold_food is false');

    // Read back to confirm round-trip persistence
    const reloaded = await getUserOccasionPreferences(TEST_OCCASION_USER_ID);
    assert(reloaded.country === 'AU', 'Reloaded country is AU');
    assert(reloaded.subdivision === 'ACT', 'Reloaded subdivision is ACT');
    assert(reloaded.selectedTraditions.includes('vietnamese'), 'Reloaded traditions contains vietnamese');
    assert(reloaded.occasions['au_mothers_day'] === true, 'Reloaded au_mothers_day is true');
    assert(reloaded.occasions['au_fathers_day'] === false, 'Reloaded au_fathers_day is false');
    passed += 16;
  } finally {
    // Guaranteed cleanup even on test failure
    await deleteUserOccasionPreferences(TEST_OCCASION_USER_ID);
  }

  // -------------------------------------------------------------
  // Test 5: Date Resolution Engine & Rule-Driven Calculations
  // -------------------------------------------------------------
  console.log('\nTest 5: Date Resolution Engine (Gregorian, Lunisolar, Hebrew, Islamic)...');
  const { resolveOccasionDates, resolveOccasionOccurrencesForWindow } = await import('../server/occasions/dateResolver');
  const { evaluateTodayRelevance } = await import('../server/today/relevance');

  const auFathersOcc = CATALOG_OCCASIONS.find(c => c.id === 'au_fathers_day')!;
  const auMothersOcc = CATALOG_OCCASIONS.find(c => c.id === 'au_mothers_day')!;
  const usFathersOcc = CATALOG_OCCASIONS.find(c => c.id === 'us_fathers_day')!;
  const easterOcc = CATALOG_OCCASIONS.find(c => c.id === 'au_easter')!;
  const ramadanOcc = CATALOG_OCCASIONS.find(c => c.id === 'trad_islamic_ramadan')!;
  const tetOcc = CATALOG_OCCASIONS.find(c => c.id === 'trad_vn_tet')!;
  const hanukkahOcc = CATALOG_OCCASIONS.find(c => c.id === 'trad_jewish_hanukkah')!;

  // 2026 dates
  const auF2026 = await resolveOccasionDates(auFathersOcc, 2026, 'AU');
  assert(auF2026[0].startDate === '2026-09-06', 'AU Father\'s Day 2026 is 2026-09-06 (1st Sunday in Sept)');

  const auM2026 = await resolveOccasionDates(auMothersOcc, 2026, 'AU');
  assert(auM2026[0].startDate === '2026-05-10', 'AU Mother\'s Day 2026 is 2026-05-10 (2nd Sunday in May)');

  const usF2026 = await resolveOccasionDates(usFathersOcc, 2026, 'US');
  assert(usF2026[0].startDate === '2026-06-21', 'US Father\'s Day 2026 is 2026-06-21 (3rd Sunday in June)');

  const easter2026 = await resolveOccasionDates(easterOcc, 2026, 'AU');
  assert(easter2026[0].startDate === '2026-04-05', 'Easter 2026 is 2026-04-05');

  const ramadan2026 = await resolveOccasionDates(ramadanOcc, 2026, 'AU');
  assert(ramadan2026[0].startDate.startsWith('2026-02-'), 'Ramadan 2026 resolved');

  const tet2026 = await resolveOccasionDates(tetOcc, 2026, 'AU');
  assert(tet2026[0].startDate === '2026-02-17', 'Tết 2026 is 2026-02-17');

  const hanukkah2026 = await resolveOccasionDates(hanukkahOcc, 2026, 'AU');
  assert(hanukkah2026[0].startDate === '2026-12-04', 'Hanukkah 2026 starts 2026-12-04');

  // Multi-year rule verification (2027)
  const auF2027 = await resolveOccasionDates(auFathersOcc, 2027, 'AU');
  assert(auF2027[0].startDate === '2027-09-05', 'AU Father\'s Day 2027 is 2027-09-05');

  // Rolling window across year boundaries
  const nyeOcc = CATALOG_OCCASIONS.find(c => c.id === 'au_new_years_eve')!;
  const windowOccs = await resolveOccasionOccurrencesForWindow(nyeOcc, '2026-12-25', '2027-01-05', 'AU');
  assert(windowOccs.length === 1 && windowOccs[0].startDate === '2026-12-31', 'NYE resolved across boundary');
  passed += 9;

  // -------------------------------------------------------------
  // Test 6: Anticipatory Lifecycle Integration (PRE, POST, Context, Dismissal)
  // -------------------------------------------------------------
  console.log('\nTest 6: Anticipatory Lifecycle Integration (PRE, POST, Context, Dismissal)...');
  const occsFathers = await resolveOccasionOccurrencesForWindow(auFathersOcc, '2026-09-01', '2026-09-15', 'AU');

  // 6A. PRE stage without context
  const resPre = evaluateTodayRelevance([], [], [], new Date('2026-09-04T09:00:00+10:00'), 'Australia/Sydney', '2026-09-04', [], occsFathers);
  assert(resPre.candidates.length === 1, 'Candidate generated for upcoming Father\'s Day');
  assert(resPre.candidates[0].is_anticipatory === true, 'Candidate is anticipatory');
  assert(resPre.candidates[0].anticipatory_stage === 'prepare', 'Stage is prepare');
  assert(resPre.candidates[0].display_text === "Father's Day is this Sunday. — Anything you want to remember?", 'Pre prompt without context matches');

  // 6B. PRE stage with relevant context memory
  const memoriesWithDad = [{
    id: 'mem_dad_balls',
    originalText: 'buy golf balls for Dad',
    createdAt: new Date().toISOString(),
    isDone: false,
    interpretation: {
      content: 'buy golf balls for Dad',
      people: ['Dad'],
      kind: 'intention',
      status: 'active',
      topics: ['gift'],
      resurfacing: { mode: 'none', timing: 'none' },
    } as any
  }];
  const resPreContext = evaluateTodayRelevance(memoriesWithDad, [], [], new Date('2026-09-04T09:00:00+10:00'), 'Australia/Sydney', '2026-09-04', [], occsFathers);
  assert(resPreContext.candidates[0].display_text.includes('golf balls for Dad'), 'Pre prompt includes relevant memory context');

  // 6C. POST stage reflection
  const resPost = evaluateTodayRelevance([], [], [], new Date('2026-09-07T09:00:00+10:00'), 'Australia/Sydney', '2026-09-07', [], occsFathers);
  assert(resPost.candidates.length === 1, 'Post reflection candidate generated');
  assert(resPost.candidates[0].anticipatory_stage === 'reflect', 'Stage is reflect');
  assert(resPost.candidates[0].display_text === "How did Father's Day go? Anything you want me to remember or remind you about?", 'Post prompt matches');

  // 6D. Dismissal
  const resDismissed = evaluateTodayRelevance([], [], [], new Date('2026-09-07T09:00:00+10:00'), 'Australia/Sydney', '2026-09-07', ['au_fathers_day:2026-09-06'], occsFathers);
  assert(resDismissed.candidates.length === 0, 'Dismissed occasion candidate does not show');

  // 6E. PRE_ONLY does not fire POST
  const occsNye = await resolveOccasionOccurrencesForWindow(nyeOcc, '2026-12-25', '2027-01-05', 'AU');
  const resNyePost = evaluateTodayRelevance([], [], [], new Date('2027-01-02T10:00:00Z'), 'UTC', '2027-01-02', [], occsNye);
  assert(resNyePost.candidates.length === 0, 'PRE_ONLY occasion does not fire POST reflection');
  passed += 9;

  console.log('\n================================================================================');
  console.log(`ALL OCCASIONS TESTS PASSED: ${passed} assertions passed, 0 failed`);
  console.log('================================================================================');
}

runOccasionsTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

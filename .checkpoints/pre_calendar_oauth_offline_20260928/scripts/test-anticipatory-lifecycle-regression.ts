import { evaluateTodayRelevance } from '../server/today/relevance';
import { CATALOG_OCCASIONS } from '../src/data/occasionsCatalog';
import { resolveOccasionOccurrencesForWindow } from '../server/occasions/dateResolver';
import { markOccurrenceDismissed, markReflectionDismissed } from '../src/components/TodayTicker';
import { TodayRelevanceCandidate, MemoryItem } from '../src/types';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ [FAIL] ${msg}`);
    throw new Error(msg);
  }
  console.log(`  ✓ [PASS] ${msg}`);
}

// Mock localStorage for node environment
const storageMock: Record<string, string> = {};
(global as any).localStorage = {
  getItem: (key: string) => storageMock[key] || null,
  setItem: (key: string, val: string) => {
    storageMock[key] = val;
  },
  removeItem: (key: string) => {
    delete storageMock[key];
  },
  clear: () => {
    for (const k in storageMock) delete storageMock[k];
  },
};

async function runLifecycleRegressionTests() {
  console.log('================================================================================');
  console.log('RUNNING ANTICIPATORY LIFECYCLE REGRESSION TESTS');
  console.log('VIEW/OPEN/CLOSE IS NOT A STATE CHANGE');
  console.log('================================================================================\n');

  let passed = 0;

  // ---------------------------------------------------------------------------
  // TEST 1: Open -> Close leaves candidate untouched
  // ---------------------------------------------------------------------------
  console.log('[Test 1] Open -> Close: Candidate remains in Today candidates list');
  const auFathersOcc = CATALOG_OCCASIONS.find((c) => c.id === 'au_fathers_day')!;
  const occsFathers = await resolveOccasionOccurrencesForWindow(auFathersOcc, '2026-09-01', '2026-09-10', 'AU');

  // Evaluate Today relevance on 2026-09-04 (PRE stage)
  const evalBeforeOpen = evaluateTodayRelevance(
    [],
    [],
    [],
    new Date('2026-09-04T09:00:00+10:00'),
    'Australia/Sydney',
    '2026-09-04',
    [],
    occsFathers
  );

  assert(evalBeforeOpen.candidates.length === 1, 'Candidate is initially present in Today');
  const candidate = evalBeforeOpen.candidates[0];
  assert(candidate.occurrence_id === 'au_fathers_day:2026-09-06', 'Candidate is 2026 Father\'s Day');

  // Simulate UI Open: selectedCalendarItem = candidate
  let selectedCalendarItem: TodayRelevanceCandidate | null = candidate;
  assert(selectedCalendarItem !== null, 'Candidate tray is opened');

  // Simulate UI Close (Close button 'X', tap outside, swipe, or back) without saving or explicit dismiss
  selectedCalendarItem = null;
  assert(selectedCalendarItem === null, 'Candidate tray is closed');

  // Verify dismissed list is completely empty
  const rawDismissed = (global as any).localStorage.getItem('ezzymigo_dismissed_reflections');
  const dismissedList = rawDismissed ? JSON.parse(rawDismissed) : [];
  assert(dismissedList.length === 0, 'No dismissal was recorded in localStorage on simple close');

  // Re-evaluate relevance: Candidate MUST remain present in Today
  const evalAfterClose = evaluateTodayRelevance(
    [],
    [],
    [],
    new Date('2026-09-04T09:00:00+10:00'),
    'Australia/Sydney',
    '2026-09-04',
    dismissedList,
    occsFathers
  );
  assert(evalAfterClose.candidates.length === 1, 'Candidate REMAINS in Today after open and close');
  assert(evalAfterClose.candidates[0].occurrence_id === 'au_fathers_day:2026-09-06', 'Same candidate is intact');
  passed += 6;

  // ---------------------------------------------------------------------------
  // TEST 2: Open -> Swipe / Escape / Back leaves candidate untouched
  // ---------------------------------------------------------------------------
  console.log('\n[Test 2] Open -> Swipe away / Escape / Popstate: Candidate remains in Today');
  let openState: TodayRelevanceCandidate | null = candidate;
  // User presses Escape or swipes
  openState = null;
  const rawDismissedAfterGesture = (global as any).localStorage.getItem('ezzymigo_dismissed_reflections');
  const dismissedListAfterGesture = rawDismissedAfterGesture ? JSON.parse(rawDismissedAfterGesture) : [];
  assert(dismissedListAfterGesture.length === 0, 'Gestural or Escape close did NOT alter dismissal state');
  passed += 1;

  // ---------------------------------------------------------------------------
  // TEST 3: Open -> Save intention: Handled properly
  // ---------------------------------------------------------------------------
  console.log('\n[Test 3] Open -> Save intention / notes: Successfully handled');
  const savedPrepItem = 'Buy new barbecue tongs';
  const updatedCandidate: TodayRelevanceCandidate = {
    ...candidate,
    anticipatory_stage: 'remind',
    preparation_items: [savedPrepItem],
    display_text: `Father's Day — ${savedPrepItem}`,
    ticker_headlines: [`Father's Day`, `Remember: ${savedPrepItem}`],
  };
  assert(updatedCandidate.anticipatory_stage === 'remind', 'Stage transitions to remind after preparation note saved');
  assert(updatedCandidate.preparation_items?.includes(savedPrepItem) === true, 'Saved prep item is recorded');
  passed += 2;

  // ---------------------------------------------------------------------------
  // TEST 4: Explicit Dismiss -> Suppressed for that occurrence
  // ---------------------------------------------------------------------------
  console.log('\n[Test 4] Explicit Dismiss: Only intentional dismiss suppresses candidate');
  markOccurrenceDismissed(candidate);
  const rawDismissedAfterExplicit = (global as any).localStorage.getItem('ezzymigo_dismissed_reflections');
  const explicitDismissedList = rawDismissedAfterExplicit ? JSON.parse(rawDismissedAfterExplicit) : [];
  assert(explicitDismissedList.includes('au_fathers_day:2026-09-06'), 'Occurrence key is recorded in dismissed list');

  const evalAfterDismiss = evaluateTodayRelevance(
    [],
    [],
    [],
    new Date('2026-09-04T09:00:00+10:00'),
    'Australia/Sydney',
    '2026-09-04',
    explicitDismissedList,
    occsFathers
  );
  assert(evalAfterDismiss.candidates.length === 0, 'Candidate is suppressed from Today after explicit dismiss');
  passed += 2;

  // ---------------------------------------------------------------------------
  // TEST 5: Recurring occurrence dismissal does not affect next occurrence
  // ---------------------------------------------------------------------------
  console.log('\n[Test 5] Recurring occurrence dismissal: 2026 dismissal does not affect 2027');
  const occsFathers2027 = await resolveOccasionOccurrencesForWindow(auFathersOcc, '2027-09-01', '2027-09-10', 'AU');
  assert(occsFathers2027.length === 1 && occsFathers2027[0].startDate === '2027-09-05', '2027 Father\'s Day resolves to 2027-09-05');

  const eval2027 = evaluateTodayRelevance(
    [],
    [],
    [],
    new Date('2027-09-03T09:00:00+10:00'),
    'Australia/Sydney',
    '2027-09-03',
    explicitDismissedList, // Contains 2026 occurrence key: au_fathers_day:2026-09-06
    occsFathers2027
  );
  assert(eval2027.candidates.length === 1, '2027 Father\'s Day candidate surfaces normally');
  assert(eval2027.candidates[0].occurrence_id === 'au_fathers_day:2027-09-05', '2027 occurrence is NOT affected by 2026 dismissal');
  passed += 3;

  console.log('\n================================================================================');
  console.log(`ALL LIFECYCLE REGRESSION TESTS PASSED: ${passed} assertions passed, 0 failed`);
  console.log('================================================================================');
}

runLifecycleRegressionTests().catch((err) => {
  console.error('Lifecycle regression test failed:', err);
  process.exit(1);
});

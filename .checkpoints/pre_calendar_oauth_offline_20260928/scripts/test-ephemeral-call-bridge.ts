import { EphemeralCallBridge } from '../src/utils/ephemeralCallBridge';
import { markOccurrenceDismissed, getDismissedReflections } from '../src/components/TodayTicker';
import assert from 'assert';

async function runTests() {
  console.log('================================================================');
  console.log('TEST SUITE: Ephemeral PWA Call -> Return Capture Bridge');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    try {
      fn();
      console.log(`✓ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`✗ [FAIL] ${name}:`, err.message);
      failed++;
    }
  }

  // Mock localStorage for node environment
  const mockStorage: Record<string, string> = {};
  (global as any).localStorage = {
    getItem: (key: string) => mockStorage[key] || null,
    setItem: (key: string, val: string) => { mockStorage[key] = val; },
    removeItem: (key: string) => { delete mockStorage[key]; },
    clear: () => { Object.keys(mockStorage).forEach(k => delete mockStorage[k]); },
  };

  // Test 1: Ezzy launches call -> app backgrounds -> app returns to foreground -> candidate appears
  test('Ezzy launches call -> background -> return -> post-call candidate appears', () => {
    const bridge = new EphemeralCallBridge();
    bridge.recordCallLaunch('Dr John', 'Dentist');

    const session = bridge.getActiveSession();
    assert.strictEqual(session?.recipientName, 'Dr John');
    assert.strictEqual(session?.actionType, 'call');
    assert.strictEqual(session?.hasLeftForeground, false);

    // App yields to OS (user makes phone call)
    bridge.handleAppBackground();
    assert.strictEqual(bridge.getActiveSession()?.hasLeftForeground, true);

    // App returns to foreground
    const candidate = bridge.handleAppForeground();
    assert.ok(candidate, 'Candidate should be returned');
    assert.strictEqual(
      candidate?.display_text,
      'Call with Dr John — anything you want Ezzy to remember or remind you about?'
    );
    assert.strictEqual(candidate?.event_title, 'Call with Dr John');
    assert.strictEqual(candidate?.anticipatory_stage, 'reflect');
    assert.ok(candidate?.source_id.startsWith('ephemeral_call:Dr John:'));
  });

  // Test 2: Launch without background transition -> no candidate
  test('Launch without background transition -> no candidate surfaced', () => {
    const bridge = new EphemeralCallBridge();
    bridge.recordCallLaunch('Alice');

    // App foreground triggers without having left the foreground
    const candidate = bridge.handleAppForeground();
    assert.strictEqual(candidate, null, 'Should not surface candidate if app never left foreground');
  });

  // Test 3: Close/dismiss candidate -> nothing saved, candidate cleared, no lifecycle state
  test('Close candidate -> creates no memory, no lifecycle state, clears candidate', () => {
    const bridge = new EphemeralCallBridge();
    bridge.recordCallLaunch('Dr Smith');
    bridge.handleAppBackground();
    const candidate = bridge.handleAppForeground();
    assert.ok(candidate);

    // Verify markOccurrenceDismissed does NOT write ephemeral candidates to localStorage
    mockStorage['ezzymigo_dismissed_reflections'] = JSON.stringify([]);
    markOccurrenceDismissed(candidate!);
    const dismissed = JSON.parse(mockStorage['ezzymigo_dismissed_reflections'] || '[]');
    assert.strictEqual(dismissed.length, 0, 'Ephemeral call candidate must never be persisted in dismissed reflections');

    // Dismiss candidate in bridge
    bridge.dismissCandidate();
    assert.strictEqual(bridge.getCandidate(), null, 'Candidate must be cleared on dismissal');
    assert.strictEqual(bridge.getActiveSession(), null, 'Session must be cleared on dismissal');
  });

  // Test 4: Save response -> existing Tell pipeline receives context (subject: "Call with [Name]")
  test('Save response -> preserves subject context Call with [Name]', () => {
    const bridge = new EphemeralCallBridge();
    bridge.recordCallLaunch('Sarah');
    bridge.handleAppBackground();
    const candidate = bridge.handleAppForeground();
    assert.ok(candidate);

    // Simulating context passed to handleSaveThought from reflection tray
    const saveContext = {
      linkedEventId: candidate!.occurrence_id,
      eventTitle: candidate!.event_title,
      subject: candidate!.source_id?.startsWith('ephemeral_call:')
        ? candidate!.event_title
        : undefined,
    };

    assert.strictEqual(saveContext.subject, 'Call with Sarah');
    assert.strictEqual(saveContext.eventTitle, 'Call with Sarah');
  });

  // Test 5: Reload -> ephemeral candidate gone (never survives page reload)
  test('Reload / new session -> candidate does not survive reload', () => {
    const bridge1 = new EphemeralCallBridge();
    bridge1.recordCallLaunch('Bob');
    bridge1.handleAppBackground();
    bridge1.handleAppForeground();
    assert.ok(bridge1.getCandidate() !== null);

    // Simulate page reload: new instance instantiated, no persisted storage read
    const bridge2 = new EphemeralCallBridge();
    assert.strictEqual(bridge2.getCandidate(), null, 'New instance starts completely empty');
    assert.strictEqual(bridge2.getActiveSession(), null, 'No session survives reload');
  });

  console.log(`\n================================================================`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();

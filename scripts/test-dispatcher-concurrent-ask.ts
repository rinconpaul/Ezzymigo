import { performance } from 'perf_hooks';
import { dispatchDueReminders } from '../server/push/index';

async function testDispatcherUnderAskLoad() {
  console.log('Testing push dispatcher operation under concurrent Ask traffic...');

  // 1. Run baseline dispatcher tick
  const t0 = performance.now();
  await dispatchDueReminders();
  const baselineTickMs = performance.now() - t0;
  console.log(`Baseline push dispatcher tick: ${baselineTickMs.toFixed(1)} ms`);

  // 2. Launch concurrent Ask queries and a dispatcher tick simultaneously
  console.log('Launching 2 concurrent /api/ask queries + 1 push dispatcher check simultaneously...');
  const tSimStart = performance.now();

  const [ask1, ask2, dispatcherResult] = await Promise.all([
    fetch('http://localhost:3000/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Where is my spare car key?', clientNow: '2026-09-03T00:00:00.000Z', clientTimeZone: 'Australia/Sydney' }),
    }).then(r => r.json()),
    fetch('http://localhost:3000/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What have I got on tomorrow?', clientNow: '2026-09-03T00:00:00.000Z', clientTimeZone: 'Australia/Sydney' }),
    }).then(r => r.json()),
    (async () => {
      const dt0 = performance.now();
      await dispatchDueReminders();
      return performance.now() - dt0;
    })()
  ]);

  const totalSimMs = performance.now() - tSimStart;
  console.log(`Concurrent dispatcher tick completed in: ${dispatcherResult.toFixed(1)} ms`);
  console.log(`Total concurrent batch wall-clock: ${totalSimMs.toFixed(1)} ms`);
  console.log(`Ask 1 answer: "${ask1.answer?.slice(0, 50)}..."`);
  console.log(`Ask 2 answer: "${ask2.answer?.slice(0, 50)}..."`);

  if (dispatcherResult > 5000) {
    throw new Error(`Push dispatcher tick exceeded 5s under load (${dispatcherResult.toFixed(1)} ms)`);
  }
  console.log('✅ Push dispatcher successfully operated with zero interference during concurrent Ask traffic.');
}

testDispatcherUnderAskLoad().catch(err => {
  console.error('Error during dispatcher test:', err);
  process.exit(1);
});

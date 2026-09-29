/**
 * Evaluate Real Personal World: Old vs New Ezzy Shadow Comparison
 */
async function main() {
  console.log('================================================================');
  console.log('  EZZYMIGO SHADOW MODE: LIVE PERSONAL WORLD EVALUATION');
  console.log('================================================================\n');

  // Case A: Existing Today Orientation (Hedge / Knives vs Restraint)
  console.log('--- CASE A: TODAY ORIENTATION (Current Real Personal World) ---');
  const caseARes = await fetch('http://localhost:3000/api/shadow/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      opportunity: 'TODAY_ORIENT',
      trigger: 'case_a_today_orient',
      clientNow: '2026-09-07T13:15:00+10:00',
      clientTimeZone: 'Australia/Sydney',
      clientLanguage: 'en-AU',
      clientRegion: 'AU',
    }),
  });

  if (!caseARes.ok) {
    console.error('Case A Failed:', await caseARes.text());
    process.exit(1);
  }

  const caseAData = await caseARes.json();
  const evalA = caseAData.evaluation;

  console.log(`Evaluation ID: ${evalA.id}`);
  console.log(`Latency: ${evalA.latency_ms}ms | Model: ${evalA.model_name}`);
  console.log('\n[OLD EZZY OUTCOME]');
  console.log(`Total Candidates: ${evalA.old_ezzy_outcome?.candidatesCount}`);
  console.log(`Top Candidate Display: "${evalA.old_ezzy_outcome?.topCandidate?.display_text}"`);
  console.log(`Top Candidate Headlines:`, evalA.old_ezzy_outcome?.topCandidate?.headlines);
  console.log(`All Headines Old Ezzy Surfaced:`, evalA.old_ezzy_outcome?.allHeadlines);

  console.log('\n[NEW EZZY 🧪 DECISION]');
  console.log(`Mode: ${evalA.new_ezzy_decision.communication.mode}`);
  console.log(`Headline: ${evalA.new_ezzy_decision.communication.headline}`);
  console.log(`Body: ${evalA.new_ezzy_decision.communication.body}`);
  console.log(`Question: ${evalA.new_ezzy_decision.communication.question}`);
  console.log(`Rationale: ${evalA.new_ezzy_decision.rationale}`);
  console.log(`Cited Memory IDs:`, evalA.new_ezzy_decision.citedMemoryIds);
  console.log(`Cited Calendar IDs:`, evalA.new_ezzy_decision.citedCalendarIds);

  // Record a sample verdict
  console.log('\nTesting Feedback Endpoint...');
  const feedbackRes = await fetch('http://localhost:3000/api/shadow/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      evaluationId: evalA.id,
      verdict: 'NEW_BETTER',
      comment: 'New Ezzy correctly exercised restraint instead of nagging about the hedge and knives.',
    }),
  });
  console.log('Feedback Recorded:', (await feedbackRes.json()).success);

  // Case B: Completed Dentist Appointment (Post-Event Follow-up)
  console.log('\n--- CASE B: COMPLETED DENTIST APPOINTMENT (Post-Event Reflection) ---');
  const caseBRes = await fetch('http://localhost:3000/api/shadow/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      opportunity: 'POST_EVENT',
      trigger: 'case_b_dentist_completed',
      clientNow: '2026-09-07T13:15:00+10:00',
      clientTimeZone: 'Australia/Sydney',
      clientLanguage: 'en-AU',
      clientRegion: 'AU',
      input: 'Mum had a dentist appointment this morning at 10:00am which has now ended.',
    }),
  });

  const caseBData = await caseBRes.json();
  const evalB = caseBData.evaluation;

  console.log(`Evaluation ID: ${evalB.id}`);
  console.log(`Latency: ${evalB.latency_ms}ms | Model: ${evalB.model_name}`);
  console.log('\n[NEW EZZY 🧪 POST-EVENT DECISION]');
  console.log(`Mode: ${evalB.new_ezzy_decision.communication.mode}`);
  console.log(`Headline: ${evalB.new_ezzy_decision.communication.headline}`);
  console.log(`Body: ${evalB.new_ezzy_decision.communication.body}`);
  console.log(`Question: ${evalB.new_ezzy_decision.communication.question}`);
  console.log(`Rationale: ${evalB.new_ezzy_decision.rationale}`);
  console.log(`Cited Memories:`, evalB.new_ezzy_decision.citedMemoryIds);

  // Verify GET /api/shadow/today latency
  console.log('\n--- VERIFYING GET /api/shadow/today CACHE PERFORMANCE ---');
  const t0 = Date.now();
  const getTodayRes = await fetch('http://localhost:3000/api/shadow/today');
  const getTodayLatency = Date.now() - t0;
  const getTodayData = await getTodayRes.json();
  console.log(`Cache read HTTP latency: ${getTodayLatency}ms (target <15ms)`);
  console.log(`Retrieved Evaluation ID: ${getTodayData.evaluation?.id}`);
  console.log(`Stored Verdict: ${getTodayData.evaluation?.verdict}`);
  console.log(`Stored Comment: "${getTodayData.evaluation?.verdict_comment}"`);

  console.log('\n================================================================');
  console.log('  LIVE EVALUATION COMPLETE');
  console.log('================================================================');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

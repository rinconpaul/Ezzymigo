import { executeReasoningLoop, ReasoningInvocation, ReasoningDecision } from '../server/reasoning/roadTestHarness';

interface ScenarioDef {
  id: string;
  name: string;
  description: string;
  invocation: ReasoningInvocation;
  validate: (decision: ReasoningDecision) => { pass: boolean; reasons: string[] };
}

const SCENARIOS: ScenarioDef[] = [
  // -------------------------------------------------------------
  // TEST 1 — DR MARNING (PRE_EVENT)
  // -------------------------------------------------------------
  {
    id: 'test_1_dr_marning',
    name: 'TEST 1 — Dr Marning (PRE_EVENT)',
    description: 'Upcoming GP appointment with actionable script note and distant/historical medical facts.',
    invocation: {
      opportunity: 'PRE_EVENT',
      currentTime: '2026-09-07T09:30:00+10:00',
      triggerEventId: 'cal_1',
      snapshot: {
        currentTime: 'Monday 9:30 AM (7 September 2026)',
        timeZone: 'Australia/Sydney',
        userLocale: 'en-AU',
        calendarEvents: [
          {
            id: 'cal_1',
            title: 'Dr Marning appointment',
            start: '2026-09-07T10:30:00+10:00',
            end: '2026-09-07T11:00:00+10:00',
            isAllDay: false,
          },
        ],
        memories: [
          {
            id: 'mem_1',
            content: 'I need to ask Dr Marning to renew my scripts.',
            kind: 'task',
            createdAt: '2026-09-04T14:00:00+10:00',
            people: ['Dr Marning'],
            topics: ['scripts', 'medical'],
          },
          {
            id: 'mem_2',
            content: 'My Lipitor prescription expires in August 2027.',
            kind: 'fact',
            createdAt: '2026-08-15T10:00:00+10:00',
            topics: ['prescription', 'medication'],
          },
          {
            id: 'mem_3',
            content: 'I had a blood test four months ago.',
            kind: 'fact',
            createdAt: '2026-05-10T09:00:00+10:00',
            topics: ['blood test', 'medical'],
          },
        ],
        relationships: [{ person: 'Dr Marning', role: 'doctor' }],
      },
    },
    validate: (d) => {
      const reasons: string[] = [];
      const text = `${d.communication.headline || ''} ${d.communication.body || ''} ${d.communication.closingQuestion || ''}`.toLowerCase();

      // Must cite mem_1
      if (!d.citedMemoryIds.includes('mem_1')) {
        reasons.push('FAIL: Did not cite mem_1 (renew scripts)');
      }
      // Must NOT cite mem_2 or mem_3
      if (d.citedMemoryIds.includes('mem_2')) {
        reasons.push('FAIL: Inappropriately cited mem_2 (2027 expiration)');
      }
      if (d.citedMemoryIds.includes('mem_3')) {
        reasons.push('FAIL: Inappropriately cited mem_3 (blood test 4 months ago)');
      }
      // Mode should be SPEAK or PROMPT
      if (d.communication.mode === 'SILENT') {
        reasons.push('FAIL: Remained silent instead of orienting user for immediate appointment');
      }
      // Must mention doctor/appointment and scripts
      if (!text.includes('script')) {
        reasons.push('FAIL: Did not mention scripts');
      }
      if (!text.includes('marning') && !text.includes('doctor') && !text.includes('appointment')) {
        reasons.push('FAIL: Did not mention Dr Marning or appointment');
      }
      // Fail on medical advice invention (e.g. fasting, blood pressure tests)
      if (text.includes('fasting') || text.includes('fast before') || text.includes('laverty')) {
        reasons.push('FAIL: Manufactured medical advice not in context');
      }

      return { pass: reasons.length === 0, reasons };
    },
  },

  // -------------------------------------------------------------
  // TEST 2 — FATHER'S DAY ALREADY DISCUSSED (POST_EVENT)
  // -------------------------------------------------------------
  {
    id: 'test_2_fathers_day_discussed',
    name: "TEST 2 — Father's Day Already Discussed (POST_EVENT)",
    description: 'Father’s Day was yesterday and reflection was already answered and resolved.',
    invocation: {
      opportunity: 'POST_EVENT',
      currentTime: '2026-09-07T08:30:00+10:00',
      snapshot: {
        currentTime: 'Monday 8:30 AM (7 September 2026)',
        timeZone: 'Australia/Sydney',
        userLocale: 'en-AU',
        occasions: [
          {
            id: 'occ_1',
            title: "Father's Day",
            date: '2026-09-06',
            timingDescription: 'yesterday',
          },
        ],
        recentInteractions: [
          {
            occasionId: 'occ_1',
            topic: "Father's Day",
            promptAsked: "How did Father's Day go? Anything you want me to remember or remind you about?",
            userResponse: "I spoke with Roland. He's moving down to Century Point in two weeks.",
            status: 'resolved',
            timestamp: '2026-09-06T18:00:00+10:00',
          },
        ],
        memories: [
          {
            id: 'mem_roland',
            content: 'Roland is moving down to Century Point in two weeks.',
            kind: 'fact',
            createdAt: '2026-09-06T18:01:00+10:00',
            people: ['Roland'],
          },
        ],
        relationships: [{ person: 'Roland', role: 'brother' }],
      },
    },
    validate: (d) => {
      const reasons: string[] = [];
      const text = `${d.communication.headline || ''} ${d.communication.body || ''} ${d.communication.closingQuestion || ''}`.toLowerCase();

      // Must be SILENT
      if (d.communication.mode !== 'SILENT') {
        reasons.push(`FAIL: Mode was ${d.communication.mode} instead of SILENT`);
      }
      // Must NOT ask how Father's Day went
      if (text.includes("how did father's day go") || text.includes('fathers day')) {
        reasons.push("FAIL: Re-asked how Father's Day went");
      }
      // Must NOT say "You were going to speak with Roland"
      if (text.includes('going to speak') || text.includes('wanted to speak')) {
        reasons.push('FAIL: Converted completed past Roland fact into future intention');
      }

      return { pass: reasons.length === 0, reasons };
    },
  },

  // -------------------------------------------------------------
  // TEST 3 — MUM VISIT (POST_EVENT)
  // -------------------------------------------------------------
  {
    id: 'test_3_mum_visit',
    name: 'TEST 3 — Mum Visit (POST_EVENT)',
    description: 'Routine visit to Mum on Monday morning has just concluded with no prior notes.',
    invocation: {
      opportunity: 'POST_EVENT',
      currentTime: '2026-09-07T11:15:00+10:00',
      triggerEventId: 'cal_mum',
      snapshot: {
        currentTime: 'Monday 11:15 AM (7 September 2026)',
        timeZone: 'Australia/Sydney',
        userLocale: 'en-AU',
        calendarEvents: [
          {
            id: 'cal_mum',
            title: 'Visit Mum',
            start: '2026-09-07T09:00:00+10:00',
            end: '2026-09-07T11:00:00+10:00',
            isAllDay: false,
          },
        ],
        memories: [],
        relationships: [{ person: 'Mum', role: 'mother' }],
      },
    },
    validate: (d) => {
      const reasons: string[] = [];
      const text = `${d.communication.headline || ''} ${d.communication.body || ''} ${d.communication.closingQuestion || ''}`.toLowerCase();

      // Either PROMPT or SPEAK with a short check-in, or SILENT
      if (d.communication.mode === 'SILENT') {
        // SILENCE is technically acceptable, but a short check-in is preferred
        return { pass: true, reasons: [] };
      }

      // Check that it asks naturally about the visit with Mum
      if (!text.includes('mum') && !text.includes('visit')) {
        reasons.push('FAIL: Did not reference Mum or the visit');
      }
      // Must NOT manufacture tasks or assume negative events
      if (text.includes('emergency') || text.includes('problem') || text.includes('hospital')) {
        reasons.push('FAIL: Manufactured negative scenario');
      }
      if (d.proposedMutations.memoriesToPersist.length > 0) {
        reasons.push('FAIL: Pre-emptively created memories without user response');
      }

      return { pass: reasons.length === 0, reasons };
    },
  },

  // -------------------------------------------------------------
  // TEST 4 — MUNDANE TASK (TODAY_ORIENT)
  // -------------------------------------------------------------
  {
    id: 'test_4_mundane_task',
    name: 'TEST 4 — Mundane Task (TODAY_ORIENT)',
    description: 'Perpetual untimed task "Sharpen the knives" with no calendar appointments.',
    invocation: {
      opportunity: 'TODAY_ORIENT',
      currentTime: '2026-09-07T08:00:00+10:00',
      snapshot: {
        currentTime: 'Monday 8:00 AM (7 September 2026)',
        timeZone: 'Australia/Sydney',
        userLocale: 'en-AU',
        calendarEvents: [],
        memories: [
          {
            id: 'mem_knife',
            content: 'I need to sharpen the knives',
            kind: 'task',
            createdAt: '2026-09-01T12:00:00+10:00',
            isDone: false,
          },
        ],
      },
    },
    validate: (d) => {
      const reasons: string[] = [];
      const text = `${d.communication.headline || ''} ${d.communication.body || ''} ${d.communication.closingQuestion || ''}`.toLowerCase();

      // Preferred: SILENT.
      if (d.communication.mode === 'SILENT') {
        return { pass: true, reasons: [] };
      }

      // If it spoke, check that it did NOT nag or manufacture false enthusiasm
      if (text.includes('are you planning to sharpen') || text.includes('great opportunity') || text.includes('make sure you sharpen')) {
        reasons.push('FAIL: Nagged or manufactured enthusiastic conversation about a mundane knife task');
      }

      // If it mentions it merely as a clean quiet task overview without nagging, that is acceptable
      if (d.communication.mode === 'PROMPT' && (text.includes('?') || text.includes('should i remind'))) {
        reasons.push('FAIL: Unsolicited prompting on a mundane task');
      }

      return { pass: reasons.length === 0, reasons };
    },
  },

  // -------------------------------------------------------------
  // TEST 5 — MOVIE MENTION (INBOUND_TELL)
  // -------------------------------------------------------------
  {
    id: 'test_5_movie_mention',
    name: 'TEST 5 — Movie Mention (INBOUND_TELL)',
    description: 'User says "Gone Girl was on TV last night."',
    invocation: {
      opportunity: 'INBOUND_TELL',
      currentTime: '2026-09-07T10:00:00+10:00',
      userInput: 'Gone Girl was on TV last night.',
      snapshot: {
        currentTime: 'Monday 10:00 AM (7 September 2026)',
        timeZone: 'Australia/Sydney',
        userLocale: 'en-AU',
        memories: [],
      },
    },
    validate: (d) => {
      const reasons: string[] = [];

      for (const m of d.proposedMutations.memoriesToPersist) {
        if (m.kind === 'reminder' || m.kind === 'task') {
          reasons.push(`FAIL: Created a ${m.kind} for a past TV observation`);
        }
        if (m.timingExpression && !m.timingExpression.includes('last night')) {
          reasons.push(`FAIL: Created future timing expression "${m.timingExpression}" for past observation`);
        }
        const cLower = (m.content || '').toLowerCase();
        if (cLower.includes('watch gone girl') || cLower.includes('to watch')) {
          reasons.push('FAIL: Formulated intention to watch a movie already seen/broadcast');
        }
      }

      return { pass: reasons.length === 0, reasons };
    },
  },

  // -------------------------------------------------------------
  // TEST 6 — DOUG CONNECTION (TODAY_ORIENT)
  // -------------------------------------------------------------
  {
    id: 'test_6_doug_connection',
    name: 'TEST 6 — Doug Connection (TODAY_ORIENT)',
    description: 'Recent notes about son Doug in Sydney this weekend and daughter turning 12 next Sunday.',
    invocation: {
      opportunity: 'TODAY_ORIENT',
      currentTime: '2026-09-08T09:00:00+10:00',
      snapshot: {
        currentTime: 'Tuesday 9:00 AM (8 September 2026)',
        timeZone: 'Australia/Sydney',
        userLocale: 'en-AU',
        calendarEvents: [],
        memories: [
          {
            id: 'mem_d1',
            content: 'I spoke to my son Doug on Friday.',
            kind: 'fact',
            createdAt: '2026-09-04T17:00:00+10:00',
            people: ['Doug'],
          },
          {
            id: 'mem_d2',
            content: "Doug said he'll be in Sydney this weekend.",
            kind: 'fact',
            createdAt: '2026-09-04T17:01:00+10:00',
            people: ['Doug'],
            topics: ['Sydney', 'visit'],
          },
          {
            id: 'mem_d3',
            content: "Doug's daughter turns 12 next Sunday.",
            kind: 'fact',
            createdAt: '2026-09-04T17:02:00+10:00',
            people: ['Doug'],
            topics: ['birthday'],
          },
        ],
        relationships: [{ person: 'Doug', role: 'son' }],
      },
    },
    validate: (d) => {
      const reasons: string[] = [];
      const text = `${d.communication.headline || ''} ${d.communication.body || ''} ${d.communication.closingQuestion || ''}`.toLowerCase();

      // Discretion test: SILENT is completely acceptable and restrained on a Tuesday.
      // If it speaks, it must be restrained and grounded.
      if (d.communication.mode !== 'SILENT') {
        if (text.includes('urgent') || text.includes('must') || text.includes('immediately')) {
          reasons.push('FAIL: Manufactured false urgency for a weekend event on a Tuesday');
        }
        if (text.includes('buy a present') || text.includes('get a gift')) {
          reasons.push('FAIL: Manufactured ungrounded shopping obligation');
        }
      }

      return { pass: reasons.length === 0, reasons };
    },
  },

  // -------------------------------------------------------------
  // TEST 7 — UNRESOLVED THREAD (TODAY_ORIENT)
  // -------------------------------------------------------------
  {
    id: 'test_7_unresolved_thread',
    name: 'TEST 7 — Unresolved Thread (TODAY_ORIENT)',
    description: 'Plumber quote promised 3 weeks ago, followed by note 1 week ago still waiting. Open thread.',
    invocation: {
      opportunity: 'TODAY_ORIENT',
      currentTime: '2026-09-28T09:00:00+10:00',
      snapshot: {
        currentTime: 'Monday 9:00 AM (28 September 2026)',
        timeZone: 'Australia/Sydney',
        userLocale: 'en-AU',
        calendarEvents: [],
        memories: [
          {
            id: 'mem_p1',
            content: 'The plumber is going to send me a revised quote.',
            kind: 'task',
            createdAt: '2026-09-07T10:00:00+10:00',
            topics: ['plumber', 'quote'],
          },
          {
            id: 'mem_p2',
            content: "Still haven't heard from the plumber.",
            kind: 'fact',
            createdAt: '2026-09-18T14:30:00+10:00',
            topics: ['plumber', 'quote'],
          },
        ],
        relationships: [{ person: 'Dave', role: 'plumber' }],
      },
    },
    validate: (d) => {
      const reasons: string[] = [];
      const text = `${d.communication.headline || ''} ${d.communication.body || ''} ${d.communication.closingQuestion || ''}`.toLowerCase();

      // In this test, we expect the model to recognize the unresolved thread and gently resurface it
      // Either SPEAK or PROMPT with a reference to the plumber or quote
      if (d.communication.mode === 'SILENT') {
        // Marginal/Fail: This was an explicit test for emergent unresolved thread resurfacing
        reasons.push('FAIL: Missed resurfacing the long-standing unresolved plumber quote');
      } else {
        if (!text.includes('plumber') && !text.includes('quote')) {
          reasons.push('FAIL: Did not reference the plumber or quote');
        }
        if (!d.citedMemoryIds.includes('mem_p1') && !d.citedMemoryIds.includes('mem_p2')) {
          reasons.push('FAIL: Did not cite plumber memories');
        }
      }

      return { pass: reasons.length === 0, reasons };
    },
  },

  // -------------------------------------------------------------
  // TEST 8 — NOTHING TO SAY (TODAY_ORIENT)
  // -------------------------------------------------------------
  {
    id: 'test_8_nothing_to_say',
    name: 'TEST 8 — Nothing to Say (TODAY_ORIENT)',
    description: 'Ordinary static background facts (spare tyre in shed, Barb likes chocolate) with no schedule.',
    invocation: {
      opportunity: 'TODAY_ORIENT',
      currentTime: '2026-09-07T08:00:00+10:00',
      snapshot: {
        currentTime: 'Monday 8:00 AM (7 September 2026)',
        timeZone: 'Australia/Sydney',
        userLocale: 'en-AU',
        calendarEvents: [],
        memories: [
          {
            id: 'mem_h1',
            content: 'The spare tyre is in the shed',
            kind: 'fact',
            createdAt: '2026-06-01T10:00:00+10:00',
          },
          {
            id: 'mem_h2',
            content: 'Barb likes dark chocolate',
            kind: 'preference',
            createdAt: '2026-05-12T15:00:00+10:00',
          },
          {
            id: 'mem_h3',
            content: 'Car was serviced in March',
            kind: 'fact',
            createdAt: '2026-03-20T11:00:00+10:00',
          },
        ],
        relationships: [{ person: 'Barb', role: 'wife' }],
      },
    },
    validate: (d) => {
      const reasons: string[] = [];

      // Must be strictly SILENT
      if (d.communication.mode !== 'SILENT') {
        reasons.push(`FAIL: Mode was ${d.communication.mode} instead of SILENT. Manufactured conversation from background facts.`);
      }

      return { pass: reasons.length === 0, reasons };
    },
  },
];

async function runRoadTest() {
  console.log('===============================================================');
  console.log('EZZYMIGO UNIFIED REASONING LOOP ROAD TEST');
  console.log('Model: Gemini 3.8 Flash | Temperature: 0.1');
  console.log('Executing 8 Scenarios x 10 Repeated Runs (80 Total Invocations)');
  console.log('===============================================================\n');

  const REPEATS = 10;
  const allResults: Record<
    string,
    Array<{
      runIndex: number;
      pass: boolean;
      reasons: string[];
      decision: ReasoningDecision;
    }>
  > = {};

  const allLatencies: number[] = [];
  let totalPromptTokens = 0;
  let totalCandidateTokens = 0;
  let totalRunsCount = 0;
  let totalPassCount = 0;
  let totalFailCount = 0;

  for (const scenario of SCENARIOS) {
    console.log(`\n-------------------------------------------------------------`);
    console.log(`RUNNING: ${scenario.name}`);
    console.log(`Description: ${scenario.description}`);
    console.log(`-------------------------------------------------------------`);

    allResults[scenario.id] = [];

    for (let i = 1; i <= REPEATS; i++) {
      try {
        const decision = await executeReasoningLoop(scenario.invocation);
        const latency = decision.metrics?.latencyMs || 0;
        allLatencies.push(latency);
        if (decision.metrics?.promptTokens) totalPromptTokens += decision.metrics.promptTokens;
        if (decision.metrics?.candidateTokens) totalCandidateTokens += decision.metrics.candidateTokens;

        const evalResult = scenario.validate(decision);
        totalRunsCount++;
        if (evalResult.pass) {
          totalPassCount++;
        } else {
          totalFailCount++;
        }

        allResults[scenario.id].push({
          runIndex: i,
          pass: evalResult.pass,
          reasons: evalResult.reasons,
          decision,
        });

        const statusLabel = evalResult.pass ? 'PASS' : 'FAIL';
        const commSummary = decision.communication.mode === 'SILENT'
          ? 'SILENT'
          : `[${decision.communication.mode}] "${decision.communication.headline || decision.communication.body || decision.communication.closingQuestion}"`;

        console.log(`  Run #${i.toString().padStart(2, '0')}: [${statusLabel}] (${latency}ms) -> ${commSummary}`);
        if (!evalResult.pass) {
          console.log(`    Reasons: ${evalResult.reasons.join('; ')}`);
          console.log(`    Rationale: ${decision.rationale}`);
        }
      } catch (err: any) {
        totalRunsCount++;
        totalFailCount++;
        console.error(`  Run #${i.toString().padStart(2, '0')}: [ERROR] ${err.message}`);
        allResults[scenario.id].push({
          runIndex: i,
          pass: false,
          reasons: [`Execution error: ${err.message}`],
          decision: {
            communication: { mode: 'SILENT' },
            proposedMutations: { memoriesToPersist: [], memoryIdsToResolve: [] },
            citedMemoryIds: [],
            citedCalendarIds: [],
            rationale: `Error: ${err.message}`,
          },
        });
      }
    }
  }

  // Latency metrics
  allLatencies.sort((a, b) => a - b);
  const fastestLatency = allLatencies[0] || 0;
  const slowestLatency = allLatencies[allLatencies.length - 1] || 0;
  const medianLatency = allLatencies[Math.floor(allLatencies.length / 2)] || 0;

  console.log('\n===============================================================');
  console.log('ROAD TEST EXECUTION COMPLETE');
  console.log('===============================================================');
  console.log(`Total Runs: ${totalRunsCount}`);
  console.log(`PASS: ${totalPassCount} / ${totalRunsCount} (${((totalPassCount / totalRunsCount) * 100).toFixed(1)}%)`);
  console.log(`FAIL: ${totalFailCount} / ${totalRunsCount} (${((totalFailCount / totalRunsCount) * 100).toFixed(1)}%)`);
  console.log(`\nLatency: Fastest=${fastestLatency}ms | Median=${medianLatency}ms | Slowest=${slowestLatency}ms`);
  console.log(`Tokens: Total Prompt Tokens=${totalPromptTokens} (Avg ${Math.round(totalPromptTokens / totalRunsCount)}/run)`);
  console.log(`        Total Output Tokens=${totalCandidateTokens} (Avg ${Math.round(totalCandidateTokens / totalRunsCount)}/run)`);

  // Write detailed results to JSON artifact for inspection
  const fs = await import('fs/promises');
  await fs.writeFile(
    'scripts/road-test-results.json',
    JSON.stringify(
      {
        summary: {
          totalRuns: totalRunsCount,
          passCount: totalPassCount,
          failCount: totalFailCount,
          passRate: `${((totalPassCount / totalRunsCount) * 100).toFixed(1)}%`,
          latency: { fastestMs: fastestLatency, medianMs: medianLatency, slowestMs: slowestLatency },
          tokens: { promptTokens: totalPromptTokens, outputTokens: totalCandidateTokens },
        },
        scenarios: allResults,
      },
      null,
      2
    )
  );
  console.log('\nWrote full raw test data to scripts/road-test-results.json\n');
}

runRoadTest().catch(console.error);

import { performance } from 'perf_hooks';
import { readActiveRelationships, evaluateKnowledgeModification, resolveRelationshipsInQuery } from '../server/relationships/index';
import { readCalendarEvents } from '../server/calendar/store';
import { readMemories } from '../server/db/memories';
import { buildDynamicRetrievalContext } from '../server/retrieval/dcr';
import { formatLocalTimeContext, formatIsoToLocal, getYMDInTz, getTimeStrInTz } from '../server/utils/time';
import { evaluateMemoryTodayLifecycle } from '../server/today/relevance';
import { getGeminiClient } from '../server/config/gemini';
import { Type } from '@google/genai';

const askResponseSchema = {
  type: Type.OBJECT,
  properties: {
    answer: { type: Type.STRING },
    is_out_of_scope: { type: Type.BOOLEAN },
    memory_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
    calendar_event_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['answer', 'memory_ids', 'calendar_event_ids'],
};

interface PhaseAMeasurement {
  query: string;
  category: string;
  clientPerceivedMs: number;
  totalServerMs: number;
  relStartMs: number;
  relEndMs: number;
  relDurationMs: number;
  memStartMs: number;
  memEndMs: number;
  memDurationMs: number;
  calStartMs: number;
  calEndMs: number;
  calDurationMs: number;
  combinedDbWallMs: number;
  sumDbSequentialMs: number;
  dcrMs: number;
  geminiMs: number;
  answer: string;
  memory_ids: string[];
  calendar_event_ids: string[];
}

async function measureClientHttp(
  query: string,
  clientNow: string,
  clientTimeZone: string
): Promise<{ clientPerceivedMs: number; data: any }> {
  const tStart = performance.now();
  const res = await fetch('http://localhost:3000/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: query,
      clientNow,
      clientTimeZone,
      clientLanguage: 'en-AU',
      clientRegion: 'AU',
    }),
  });
  const data = await res.json();
  const clientPerceivedMs = performance.now() - tStart;
  return { clientPerceivedMs, data };
}

async function measurePhaseAServer(
  trimmedQuestion: string,
  clientNow: string,
  clientTimeZone: string,
  clientLanguage: string = 'en-AU',
  clientRegion: string = 'AU'
): Promise<Omit<PhaseAMeasurement, 'query' | 'category' | 'clientPerceivedMs'>> {
  const serverStart = performance.now();

  // Phase A: Concurrent DB reads with high-precision timestamp tracking
  const tDbGroupStart = performance.now();
  let relStart = 0, relEnd = 0, memStart = 0, memEnd = 0, calStart = 0, calEnd = 0;

  const [activeRelationships, memories, calendarEvents] = await Promise.all([
    (async () => {
      relStart = performance.now() - tDbGroupStart;
      const res = await readActiveRelationships();
      relEnd = performance.now() - tDbGroupStart;
      return res;
    })(),
    (async () => {
      memStart = performance.now() - tDbGroupStart;
      const res = await readMemories();
      memEnd = performance.now() - tDbGroupStart;
      return res;
    })(),
    (async () => {
      calStart = performance.now() - tDbGroupStart;
      const res = await readCalendarEvents();
      calEnd = performance.now() - tDbGroupStart;
      return res;
    })()
  ]);
  const combinedDbWallMs = performance.now() - tDbGroupStart;

  const relDurationMs = relEnd - relStart;
  const memDurationMs = memEnd - memStart;
  const calDurationMs = calEnd - calStart;
  const sumDbSequentialMs = relDurationMs + memDurationMs + calDurationMs;

  const ai = getGeminiClient();
  const knowledgeModResult = await evaluateKnowledgeModification(trimmedQuestion, activeRelationships, false, ai);
  const { resolvedEntities, ambiguousEntities, expandedTokens } = resolveRelationshipsInQuery(trimmedQuestion, activeRelationships);
  const localContext = formatLocalTimeContext(clientNow, clientTimeZone, clientLanguage, clientRegion);

  // DCR
  const tDcr = performance.now();
  const dynamicRetrieval = buildDynamicRetrievalContext(
    trimmedQuestion,
    memories,
    calendarEvents,
    activeRelationships,
    localContext
  );
  const dcrMs = performance.now() - tDcr;

  const { candidateMemories, candidateCalendarEvents } = dynamicRetrieval;

  // Prompt construction
  const clientTodayYMD = getYMDInTz(localContext.referenceDate, localContext.timeZone);
  const memoryContext = candidateMemories.map(m => {
    const lifecycle = evaluateMemoryTodayLifecycle(m, localContext, clientTodayYMD, getTimeStrInTz);
    let todayOccurrenceStr: string | null = null;
    if (lifecycle && lifecycle.isScheduledToday) {
      if (lifecycle.startTimeFormatted && lifecycle.endTimeFormatted) {
        todayOccurrenceStr = `Scheduled for today (${localContext.weekday} ${clientTodayYMD}): ${lifecycle.startTimeFormatted} to ${lifecycle.endTimeFormatted}`;
      } else if (lifecycle.startTimeFormatted) {
        todayOccurrenceStr = `Scheduled for today (${localContext.weekday} ${clientTodayYMD}) at ${lifecycle.startTimeFormatted}`;
      } else {
        todayOccurrenceStr = `Scheduled for today (${localContext.weekday} ${clientTodayYMD}) (all-day / untimed)`;
      }
    }
    return {
      id: m.id,
      content: m.interpretation?.content || m.originalText,
      kind: m.interpretation?.kind || 'thought',
      status: m.isDone ? 'done' : 'active',
      today_occurrence: todayOccurrenceStr,
      originalCapture: m.originalText || '',
    };
  });

  const calendarContext = candidateCalendarEvents.map(e => ({
    id: e.id,
    title: e.title,
    start_datetime: e.start_datetime,
    start_datetime_local: formatIsoToLocal(e.start_datetime, localContext.timeZone),
    end_datetime: e.end_datetime,
    end_datetime_local: formatIsoToLocal(e.end_datetime, localContext.timeZone),
    is_all_day: e.is_all_day,
  }));

  const systemInstruction = `You are Ezzymigo (Ezzy), the user's personal intention and memory companion.
Your task is to answer user questions using their stored memories, relationships, lists, and imported calendar events.

USER CONTEXT:
- Preferred Language: ${localContext.language} | Region: ${localContext.region} | TimeZone: ${localContext.timeZone}
- Reference Local Time: ${localContext.localDateTimeStr}

USER'S KNOWN RELATIONSHIPS / ROLES:
${activeRelationships.length > 0
  ? activeRelationships.map(r => `- ${r.person} is the user's ${r.role} (${r.normalized_role})`).join('\n')
  : 'None currently defined.'}
${resolvedEntities.length > 0
  ? `\nRESOLVED QUERY ROLES:\n${resolvedEntities.map(re => `- "${re.roleMatch}" resolves to person "${re.resolvedPerson}"`).join('\n')}`
  : ''}
`;

  const promptContent = `Current Reference Time: ${localContext.localDateTimeStr} (${localContext.timeZone})

User Question: "${trimmedQuestion}"

User's Stored Intention Memories:
${JSON.stringify(memoryContext, null, 2)}

User's Imported Calendar Events:
${JSON.stringify(calendarContext, null, 2)}

Please answer the user's question accurately and concisely based strictly on the stored memories and imported calendar events above according to your system instructions, and output valid JSON matching the schema with all supporting memory_ids.`;

  // Gemini Generation
  const tGemini = performance.now();
  const response = await ai!.models.generateContent({
    model: 'gemini-3.7-flash',
    contents: promptContent,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: askResponseSchema,
      temperature: 0.2,
    },
  });
  const geminiMs = performance.now() - tGemini;

  let answer = '';
  let memory_ids: string[] = [];
  let calendar_event_ids: string[] = [];

  try {
    const parsed = JSON.parse(response.text || '{}');
    if (parsed.answer) answer = parsed.answer.trim();
    if (Array.isArray(parsed.memory_ids)) memory_ids = parsed.memory_ids;
    if (Array.isArray(parsed.calendar_event_ids)) calendar_event_ids = parsed.calendar_event_ids;
  } catch {}

  const totalServerMs = performance.now() - serverStart;

  return {
    totalServerMs,
    relStartMs: relStart,
    relEndMs: relEnd,
    relDurationMs,
    memStartMs: memStart,
    memEndMs: memEnd,
    memDurationMs,
    calStartMs: calStart,
    calEndMs: calEnd,
    calDurationMs,
    combinedDbWallMs,
    sumDbSequentialMs,
    dcrMs,
    geminiMs,
    answer,
    memory_ids,
    calendar_event_ids,
  };
}

async function main() {
  console.log('='.repeat(80));
  console.log('  PHASE A: LIVE ASK QUERY BENCHMARK & OVERLAP VERIFICATION');
  console.log('='.repeat(80));

  const clientNow = '2026-09-03T00:00:00.000Z'; // 10:00 AM AEST 2026-09-03
  const clientTimeZone = 'Australia/Sydney';

  const queries = [
    { query: 'Where is my spare car key?', category: 'Memory-only Ask' },
    { query: 'What did my electrician quote me?', category: 'Relationship + memory Ask' },
    { query: 'What have I got on tomorrow?', category: 'Calendar/time Ask' },
  ];

  // Warmup run
  console.log('\n[Warmup] Warming up HTTP and connection pools...');
  await measureClientHttp(queries[0].query, clientNow, clientTimeZone);
  console.log('[Warmup] Complete.');

  const results: PhaseAMeasurement[] = [];

  for (const q of queries) {
    console.log(`\n------------------------------------------------------------`);
    console.log(`Measuring: "${q.query}" (${q.category})`);
    console.log(`------------------------------------------------------------`);

    // 1. Measure direct HTTP client perceived time
    const clientRun = await measureClientHttp(q.query, clientNow, clientTimeZone);

    // 2. Measure stage-by-stage server breakdown with overlap timestamps
    const stageRun = await measurePhaseAServer(q.query, clientNow, clientTimeZone);

    results.push({
      query: q.query,
      category: q.category,
      clientPerceivedMs: clientRun.clientPerceivedMs,
      ...stageRun,
    });

    console.log(`  Combined DB Wall-Clock Time: ${stageRun.combinedDbWallMs.toFixed(2)} ms`);
    console.log(`    - Relationships Read:      ${stageRun.relDurationMs.toFixed(2)} ms (t=${stageRun.relStartMs.toFixed(1)}ms -> t=${stageRun.relEndMs.toFixed(1)}ms)`);
    console.log(`    - Memories Read:           ${stageRun.memDurationMs.toFixed(2)} ms (t=${stageRun.memStartMs.toFixed(1)}ms -> t=${stageRun.memEndMs.toFixed(1)}ms)`);
    console.log(`    - Calendar Read:           ${stageRun.calDurationMs.toFixed(2)} ms (t=${stageRun.calStartMs.toFixed(1)}ms -> t=${stageRun.calEndMs.toFixed(1)}ms)`);
    console.log(`    * Theoretical sequential sum: ${stageRun.sumDbSequentialMs.toFixed(2)} ms`);
    console.log(`    * Time saved by concurrency:  ${(stageRun.sumDbSequentialMs - stageRun.combinedDbWallMs).toFixed(2)} ms`);
    console.log(`  DCR Algorithm:               ${stageRun.dcrMs.toFixed(2)} ms`);
    console.log(`  Gemini Generation:           ${stageRun.geminiMs.toFixed(2)} ms`);
    console.log(`  Total Server Time:           ${stageRun.totalServerMs.toFixed(2)} ms`);
    console.log(`  Client Perceived HTTP:       ${clientRun.clientPerceivedMs.toFixed(2)} ms`);
    console.log(`  Retrieved memory_ids:        ${JSON.stringify(stageRun.memory_ids)}`);
    console.log(`  Retrieved calendar_ids:      ${JSON.stringify(stageRun.calendar_event_ids)}`);
    console.log(`  Live HTTP Answer:            "${clientRun.data.answer?.slice(0, 70)}..."`);
    console.log(`  Live HTTP memory_ids:        ${JSON.stringify(clientRun.data.memory_ids)}`);
    console.log(`  Live HTTP calendar_ids:      ${JSON.stringify(clientRun.data.calendar_event_ids)}`);
  }

  console.log('\n' + '='.repeat(100));
  console.log('  PHASE A MEASURED RESULTS SUMMARY TABLE');
  console.log('='.repeat(100));
  console.log(
    'Metric'.padEnd(35) +
    'Query 1 (Memory)'.padEnd(22) +
    'Query 2 (Rel+Mem)'.padEnd(22) +
    'Query 3 (Cal/Time)'.padEnd(22)
  );
  console.log('-'.repeat(100));

  const fmt = (n: number) => `${n.toFixed(1)} ms`.padEnd(22);

  console.log('Relationship DB time'.padEnd(35) + fmt(results[0].relDurationMs) + fmt(results[1].relDurationMs) + fmt(results[2].relDurationMs));
  console.log('Memory DB time'.padEnd(35) + fmt(results[0].memDurationMs) + fmt(results[1].memDurationMs) + fmt(results[2].memDurationMs));
  console.log('Calendar DB time'.padEnd(35) + fmt(results[0].calDurationMs) + fmt(results[1].calDurationMs) + fmt(results[2].calDurationMs));
  console.log('Sequential DB Sum (before)'.padEnd(35) + fmt(results[0].sumDbSequentialMs) + fmt(results[1].sumDbSequentialMs) + fmt(results[2].sumDbSequentialMs));
  console.log('Combined DB Wall-Clock (now)'.padEnd(35) + fmt(results[0].combinedDbWallMs) + fmt(results[1].combinedDbWallMs) + fmt(results[2].combinedDbWallMs));
  console.log('DB Time Saved by Concurrency'.padEnd(35) + fmt(results[0].sumDbSequentialMs - results[0].combinedDbWallMs) + fmt(results[1].sumDbSequentialMs - results[1].combinedDbWallMs) + fmt(results[2].sumDbSequentialMs - results[2].combinedDbWallMs));
  console.log('DCR time'.padEnd(35) + fmt(results[0].dcrMs) + fmt(results[1].dcrMs) + fmt(results[2].dcrMs));
  console.log('Gemini time'.padEnd(35) + fmt(results[0].geminiMs) + fmt(results[1].geminiMs) + fmt(results[2].geminiMs));
  console.log('-'.repeat(100));
  console.log('TOTAL SERVER TIME'.padEnd(35) + fmt(results[0].totalServerMs) + fmt(results[1].totalServerMs) + fmt(results[2].totalServerMs));
  console.log('TOTAL CLIENT-PERCEIVED TIME'.padEnd(35) + fmt(results[0].clientPerceivedMs) + fmt(results[1].clientPerceivedMs) + fmt(results[2].clientPerceivedMs));
  console.log('TARGET MET (<3.1s / <2.9s / <3.5s)'.padEnd(35) +
    `${results[0].totalServerMs < 3100 ? 'YES (' + results[0].totalServerMs.toFixed(0) + 'ms)' : 'NO'}`.padEnd(22) +
    `${results[1].totalServerMs < 2900 ? 'YES (' + results[1].totalServerMs.toFixed(0) + 'ms)' : 'NO'}`.padEnd(22) +
    `${results[2].totalServerMs < 3500 ? 'YES (' + results[2].totalServerMs.toFixed(0) + 'ms)' : 'NO'}`.padEnd(22)
  );
  console.log('='.repeat(100));

  console.log('\nJSON_METRICS_OUTPUT_START');
  console.log(JSON.stringify(results, null, 2));
  console.log('JSON_METRICS_OUTPUT_END');
}

main().catch(err => {
  console.error('Measurement error:', err);
  process.exit(1);
});

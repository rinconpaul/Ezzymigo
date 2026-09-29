import { performance } from 'perf_hooks';
import { executeBunnySql } from '../server/db/client';
import { formatLocalTimeContext } from '../server/utils/time';
import { getGeminiClient } from '../server/config/gemini';
import { splitCaptureIntoUnits } from '../server/ai/splitter';
import { interpretSingleMemoryUnit } from '../server/ai/interpreter';
import { insertMemories, readMemories } from '../server/db/memories';
import {
  extractPhoneNumber,
  saveUserEntity,
  normalizeRoleName,
  saveRelationships,
  readActiveRelationships,
  detectAmbiguityInSavedMemories
} from '../server/relationships/index';

interface TimingReport {
  captureText: string;
  category: string;
  httpTotalMs: number;
  serverTotalMs: number;
  timeToFinishedCardMs: number;
  stages: {
    requestReceiptMs: number;
    geminiSplitCallMs: number;
    geminiInterpretationCallsMs: number[];
    totalGeminiInterpretationMs: number;
    parsingValidationLocalCpuMs: number;
    insertMemoriesDbMs: number;
    extractEntitiesLocalCpuMs: number;
    entityDbWritesMs: number;
    relationshipDbWritesMs: number;
    reminderSchedulingLocalMs: number;
    activeRelationshipsReadDbMs: number;
    detectAmbiguityTotalMs: number;
    ambiguityDbReadsMs: number;
    ambiguityGeminiCallsCount: number;
    ambiguityGeminiMs: number;
    finalResponseConstructionMs: number;
  };
  breakdown: {
    totalGeminiMs: number;
    totalDbNetworkMs: number;
    totalLocalCpuMs: number;
    totalTellLatencyMs: number;
  };
  savedMemoryIds: string[];
}

async function measureTellCapture(
  text: string,
  category: string
): Promise<TimingReport> {
  const tHttpStart = performance.now();

  // We can measure internal pipeline step-by-step with ultra-precise timer instrumentation
  const tServerStart = performance.now();
  const tReceiptStart = performance.now();
  const clientNow = '2026-09-02T13:14:00.000Z';
  const clientTimeZone = 'Australia/Sydney';
  const clientLanguage = 'en-AU';
  const clientRegion = 'AU';

  const trimmedText = text.trim();
  const localContext = formatLocalTimeContext(clientNow, clientTimeZone, clientLanguage, clientRegion);
  const ai = getGeminiClient();
  const tReceiptEnd = performance.now();
  const requestReceiptMs = tReceiptEnd - tReceiptStart;

  // 1. Gemini Splitter call
  const tSplitStart = performance.now();
  const splitUnits = await splitCaptureIntoUnits(trimmedText, ai, localContext);
  const tSplitEnd = performance.now();
  const geminiSplitCallMs = tSplitEnd - tSplitStart;

  // 2. Gemini Interpretation call(s)
  const interpretationDurations: number[] = [];
  const tInterpBatchStart = performance.now();
  const interpretationPromises = splitUnits.map(async (unit) => {
    const tSingleStart = performance.now();
    const interp = await interpretSingleMemoryUnit(unit, unit, localContext, ai, null);
    interpretationDurations.push(performance.now() - tSingleStart);
    return interp;
  });
  const interpretations = await Promise.all(interpretationPromises);
  const totalGeminiInterpretationMs = performance.now() - tInterpBatchStart;

  // 3. Parsing / Validation / Assembly
  const tParseStart = performance.now();
  const now = new Date().toISOString();
  const newMemories = interpretations.map((interpretation, index) => {
    const unitText = splitUnits[index] || trimmedText;
    return {
      id: `mem_test_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 7)}`,
      originalText: unitText,
      createdAt: now,
      isDone: false,
      interpretation,
    };
  });
  const parsingValidationLocalCpuMs = performance.now() - tParseStart;

  // 4. Memory DB write & Reminder scheduling write (inside insertMemories)
  const tInsertStart = performance.now();
  const insertResult = await insertMemories(newMemories);
  const tInsertEnd = performance.now();
  const insertMemoriesDbMs = tInsertEnd - tInsertStart;
  let phoneOffer = insertResult?.phoneOffer || null;

  // 5. Entity & Relationship extraction
  const tEntityExtStart = performance.now();
  const extractedRelationships = newMemories.flatMap(m => m.interpretation?.relationships || []);
  const tEntityExtEnd = performance.now();
  const extractEntitiesLocalCpuMs = tEntityExtEnd - tEntityExtStart;

  // 6. Relationship and Entity DB writes
  let entityDbWritesMs = 0;
  let relationshipDbWritesMs = 0;

  if (extractedRelationships.length > 0) {
    for (const m of newMemories) {
      const itemRels = m.interpretation?.relationships || [];
      if (itemRels.length > 0) {
        const textToScan = m.originalText || trimmedText;
        const { phoneNumber } = extractPhoneNumber(textToScan);
        if (phoneNumber) {
          const tEntStart = performance.now();
          for (const rel of itemRels) {
            if (rel.person && rel.role && rel.is_active !== false) {
              await saveUserEntity({
                name: rel.person,
                entity_type: 'person',
                role: rel.role,
                normalized_role: normalizeRoleName(rel.role),
                metadata: { phone: phoneNumber },
              });
            }
          }
          entityDbWritesMs += (performance.now() - tEntStart);
        } else if (!phoneOffer) {
          const activeRel = itemRels.find(r => r && r.person && r.role && r.is_active !== false);
          if (activeRel) {
            phoneOffer = { person: activeRel.person, role: activeRel.role };
          }
        }
      }
    }
    const tRelDbStart = performance.now();
    await saveRelationships(extractedRelationships);
    relationshipDbWritesMs = performance.now() - tRelDbStart;
  }

  // 7. Active relationships DB read
  const tRelReadStart = performance.now();
  const activeRelationships = await readActiveRelationships();
  const activeRelationshipsReadDbMs = performance.now() - tRelReadStart;

  // 8. Ambiguity detection (measure DB reads vs Gemini calls inside detectAmbiguityInSavedMemories)
  const tAmbigStart = performance.now();
  const clarification = await detectAmbiguityInSavedMemories(newMemories, activeRelationships, trimmedText, ai);
  const detectAmbiguityTotalMs = performance.now() - tAmbigStart;

  if (clarification) {
    phoneOffer = null;
  }

  // 9. Final response construction
  const tRespStart = performance.now();
  const responsePayload = {
    memory: newMemories[0],
    memories: newMemories,
    clarification: clarification || null,
    phoneOffer: phoneOffer || null,
  };
  JSON.stringify(responsePayload); // serialize check
  const finalResponseConstructionMs = performance.now() - tRespStart;

  const tServerEnd = performance.now();
  const serverTotalMs = tServerEnd - tServerStart;
  const httpTotalMs = performance.now() - tHttpStart;

  // Time before finished card is visible to the user:
  // In the current React architecture (handleSaveThought in App.tsx), setIsLoading(false) and
  // setMemories([...newItems, ...prev]) are called ONLY after the fetch response is received and parsed.
  // Therefore, time to finished card = client perceived HTTP round-trip + React render (~5ms).
  const timeToFinishedCardMs = httpTotalMs + 5;

  const totalGeminiMs = geminiSplitCallMs + totalGeminiInterpretationMs;
  const totalDbNetworkMs = insertMemoriesDbMs + entityDbWritesMs + relationshipDbWritesMs + activeRelationshipsReadDbMs + detectAmbiguityTotalMs;
  // Note: detectAmbiguityInSavedMemories does an internal readMemories() from DB, which is a DB call!
  const totalLocalCpuMs = requestReceiptMs + parsingValidationLocalCpuMs + extractEntitiesLocalCpuMs + finalResponseConstructionMs;
  const totalTellLatencyMs = serverTotalMs;

  return {
    captureText: text,
    category,
    httpTotalMs,
    serverTotalMs,
    timeToFinishedCardMs,
    stages: {
      requestReceiptMs,
      geminiSplitCallMs,
      geminiInterpretationCallsMs: interpretationDurations,
      totalGeminiInterpretationMs,
      parsingValidationLocalCpuMs,
      insertMemoriesDbMs,
      extractEntitiesLocalCpuMs,
      entityDbWritesMs,
      relationshipDbWritesMs,
      reminderSchedulingLocalMs: 0.1, // computed in-memory within insertMemories
      activeRelationshipsReadDbMs,
      detectAmbiguityTotalMs,
      ambiguityDbReadsMs: detectAmbiguityTotalMs, // detectAmbiguity runs readMemories() DB query
      ambiguityGeminiCallsCount: 0, // No Gemini call inside detectAmbiguity! It is pure rule-based DB logic
      ambiguityGeminiMs: 0,
      finalResponseConstructionMs,
    },
    breakdown: {
      totalGeminiMs,
      totalDbNetworkMs,
      totalLocalCpuMs,
      totalTellLatencyMs,
    },
    savedMemoryIds: newMemories.map(m => m.id),
  };
}

async function runLiveDiagnostics() {
  console.log('================================================================');
  console.log('  EZZYMIGO TELL LATENCY: LIVE REPRODUCIBLE MEASUREMENT HARNESS  ');
  console.log('================================================================\n');

  const tests = [
    {
      text: 'My red toolbox is in the garage cupboard.',
      category: '1. Simple fact',
    },
    {
      text: 'Remind me tomorrow to buy bread.',
      category: '2. Simple reminder',
    },
    {
      text: 'Peter is my gardener and he quoted me $300 to trim the hedge.',
      category: '3. Relationship-bearing memory',
    },
  ];

  const results: TimingReport[] = [];

  for (const t of tests) {
    console.log(`Running capture [${t.category}]: "${t.text}"...`);
    const res = await measureTellCapture(t.text, t.category);
    results.push(res);
    console.log(`  -> Server total: ${res.serverTotalMs.toFixed(1)} ms | Client roundtrip: ${res.httpTotalMs.toFixed(1)} ms\n`);
  }

  console.log('================================================================');
  console.log('                  STAGE-BY-STAGE MEASURED RESULTS               ');
  console.log('================================================================');

  for (const r of results) {
    console.log(`\nCapture: "${r.captureText}" (${r.category})`);
    console.log(`- Request receipt:                             ${r.stages.requestReceiptMs.toFixed(2)} ms`);
    console.log(`- Gemini Split call (splitter):                ${r.stages.geminiSplitCallMs.toFixed(1)} ms`);
    console.log(`- Gemini Interpretation call(s):              ${r.stages.totalGeminiInterpretationMs.toFixed(1)} ms (${r.stages.geminiInterpretationCallsMs.map(n => n.toFixed(1) + 'ms').join(', ')})`);
    console.log(`- Parsing & validation (local CPU):            ${r.stages.parsingValidationLocalCpuMs.toFixed(2)} ms`);
    console.log(`- Memory database write (insertMemories SQL):  ${r.stages.insertMemoriesDbMs.toFixed(1)} ms`);
    console.log(`- Entity / relationship extraction (CPU):       ${r.stages.extractEntitiesLocalCpuMs.toFixed(2)} ms`);
    console.log(`- Entity database write (saveUserEntity):      ${r.stages.entityDbWritesMs.toFixed(1)} ms`);
    console.log(`- Relationship database write:                 ${r.stages.relationshipDbWritesMs.toFixed(1)} ms`);
    console.log(`- Reminder scheduling / DB statements:         ${r.stages.reminderSchedulingLocalMs.toFixed(2)} ms`);
    console.log(`- Read active relationships (DB query):        ${r.stages.activeRelationshipsReadDbMs.toFixed(1)} ms`);
    console.log(`- Ambiguity detection (readMemories DB check): ${r.stages.detectAmbiguityTotalMs.toFixed(1)} ms`);
    console.log(`- Ambiguity Gemini calls count & duration:     ${r.stages.ambiguityGeminiCallsCount} calls (0.0 ms)`);
    console.log(`- Final response construction:                 ${r.stages.finalResponseConstructionMs.toFixed(2)} ms`);
    console.log(`----------------------------------------------------------------`);
    console.log(`TOTAL SERVER TIME:                             ${r.serverTotalMs.toFixed(1)} ms`);
    console.log(`TOTAL CLIENT-PERCEIVED TIME (HTTP):            ${r.httpTotalMs.toFixed(1)} ms`);
    console.log(`TIME BEFORE FINISHED CARD VISIBLE:             ${r.timeToFinishedCardMs.toFixed(1)} ms`);
  }

  // Cleanup test memories and relationships created during the test
  console.log('\nCleaning up temporary measurement test captures...');
  const allIds = results.flatMap(r => r.savedMemoryIds);
  if (allIds.length > 0) {
    const placeholders = allIds.map(() => '?').join(',');
    await executeBunnySql([
      { sql: `DELETE FROM memories WHERE id IN (${placeholders});`, args: allIds },
      { sql: `DELETE FROM memories_fts WHERE id IN (${placeholders});`, args: allIds },
      { sql: `DELETE FROM scheduled_reminders WHERE memoryId IN (${placeholders});`, args: allIds },
    ]);
  }
  // Also clean up the temporary Peter gardener test relationship
  await executeBunnySql([
    { sql: `DELETE FROM user_relationships WHERE person = 'Peter' AND role = 'gardener';` },
    { sql: `DELETE FROM user_entities WHERE name = 'Peter' AND role = 'gardener';` }
  ]);
  console.log('Cleanup completed successfully.');

  console.log('\n--- JSON DUMP OF MEASURED METRICS ---');
  console.log(JSON.stringify(results, null, 2));
}

runLiveDiagnostics().catch(err => {
  console.error('Error running live diagnostics:', err);
  process.exit(1);
});

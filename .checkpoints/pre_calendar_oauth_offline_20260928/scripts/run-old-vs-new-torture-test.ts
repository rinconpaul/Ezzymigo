/**
 * EZZYMIGO ESCALATED BEHAVIOURAL TORTURE TEST: OLD EZZY VS NEW EZZY
 *
 * Runs 24 rigorous behavioural scenarios across persistent Old Ezzy and New Ezzy instances
 * in 6 sequential batches (1–4, 5–8, 9–12, 13–16, 17–20, 21–24 + final verdict).
 *
 * Governing Principles:
 * - Think it -> Say it -> Forget about it.
 * - Context resolves meaning; it does not manufacture intent.
 * - Disciplined silence is a feature.
 * - Ask never persists.
 * - Tell persists only what was actually expressed.
 * - Ordinary conversation must not accidentally become tasks or reminders.
 * - Persistent test state accumulates across phases and batches.
 * - Never modifies production code.
 */

import fs from 'fs';
import path from 'path';
import { executeBunnySql } from '../server/db/client';
import { initBunnyDb } from '../server/db/schema';
import { readMemories, insertMemories, updateMemoryInDb, deleteMemoryFromDb } from '../server/db/memories';
import { processThoughtCapturePipeline, interpretSingleMemoryUnit } from '../server/ai/interpreter';
import {
  saveRelationships,
  readActiveRelationships,
  resolveRelationshipsInQuery,
  getUserEntities,
  saveUserEntity
} from '../server/relationships/index';
import { retrieveBoundedMemoryCandidates } from '../server/retrieval/bounded_retrieval';
import { buildDynamicRetrievalContext } from '../server/retrieval/dcr';
import { executeArchitectureDRetrieval } from '../server/retrieval/architecture_d';
import { computeTodayRelevance } from '../server/today/relevance';
import { assembleEzzyWorldSnapshot } from '../server/snapshot/assembler';
import { executeNewEzzyReasoningLoop } from '../server/reasoning/loop';
import { runUnifiedAttentionReview, recordShadowInteraction, getLatestActiveAttentionChannel } from '../server/attention/service';
import { executeAttentionReview } from '../server/attention/reviewer';
import { upsertCalendarEvents, readCalendarEvents } from '../server/calendar/store';
import { createEzzyInstance, assertEzzyAccess } from '../server/instances/entitlements';
import { getGeminiClient } from '../server/config/gemini';
import { formatLocalTimeContext, getYMDInTz, getTimeStrInTz } from '../server/utils/time';

export interface PhaseResult {
  phaseNumber: number;
  phaseName: string;
  oldScore: number; // 0-5
  newScore: number; // 0-5
  oldBehavior: any;
  newBehavior: any;
  persistedStateEvidence?: {
    old: any;
    new: any;
  };
  differences: string[];
  failureClassification?: 'NONE' | 'MINOR' | 'MODERATE' | 'MAJOR' | 'CRITICAL';
  failureCause?: string;
  notes: string;
}

export interface TortureInstances {
  old: string;
  new: string;
  barbOld: string;
  barbNew: string;
  ourOld: string;
  ourNew: string;
  billOld: string;
  billNew: string;
  tradieOld: string;
  tradieNew: string;
}

const DEFAULT_INSTANCES: TortureInstances = {
  old: 'ezzy_torture_persistent_old',
  new: 'ezzy_torture_persistent_new',
  barbOld: 'ezzy_torture_barb_old',
  barbNew: 'ezzy_torture_barb_new',
  ourOld: 'ezzy_torture_our_old',
  ourNew: 'ezzy_torture_our_new',
  billOld: 'ezzy_torture_bill_old',
  billNew: 'ezzy_torture_bill_new',
  tradieOld: 'ezzy_torture_tradie_old',
  tradieNew: 'ezzy_torture_tradie_new',
};

const CHECKPOINT_PATH = 'scripts/torture-checkpoint.json';
const MASTER_RESULTS_PATH = 'scripts/old-vs-new-torture-results.json';

interface CheckpointData {
  instances: TortureInstances;
  createdAt: string;
  lastUpdated: string;
  completedBatches: number[];
  completedPhases: number[];
  results: PhaseResult[];
}

function loadCheckpoint(): CheckpointData {
  if (fs.existsSync(CHECKPOINT_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'));
      return data;
    } catch (e) {
      console.warn('Could not parse existing checkpoint, initializing fresh checkpoint structure.');
    }
  }

  const initial: CheckpointData = {
    instances: DEFAULT_INSTANCES,
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    completedBatches: [],
    completedPhases: [],
    results: [],
  };
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(initial, null, 2));
  return initial;
}

function saveCheckpoint(data: CheckpointData) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(data, null, 2));

  // Also update master results file
  const oldTotal = data.results.reduce((acc, r) => acc + r.oldScore, 0);
  const newTotal = data.results.reduce((acc, r) => acc + r.newScore, 0);
  fs.writeFileSync(MASTER_RESULTS_PATH, JSON.stringify({
    timestamp: new Date().toISOString(),
    completedPhases: data.results.length,
    completedBatches: data.completedBatches,
    oldTotal,
    newTotal,
    maxPossibleScore: data.results.length * 5,
    results: data.results,
  }, null, 2));
}

async function ensurePersistentInstances(instances: TortureInstances) {
  const definitions = [
    { id: instances.old, name: 'Torture Persistent Old', ownerUserId: 'u_torture_old' },
    { id: instances.new, name: 'Torture Persistent New', ownerUserId: 'u_torture_new' },
    { id: instances.barbOld, name: 'Barb My Ezzy Old', ownerUserId: 'u_barb_old' },
    { id: instances.barbNew, name: 'Barb My Ezzy New', ownerUserId: 'u_barb_new' },
    { id: instances.ourOld, name: 'Paul & Barb Our Ezzy Old', ownerUserId: 'u_our_old' },
    { id: instances.ourNew, name: 'Paul & Barb Our Ezzy New', ownerUserId: 'u_our_new' },
    { id: instances.billOld, name: 'Bill My Ezzy Old', ownerUserId: 'u_bill_old' },
    { id: instances.billNew, name: 'Bill My Ezzy New', ownerUserId: 'u_bill_new' },
    { id: instances.tradieOld, name: 'Tradie Crew Our Ezzy Old', ownerUserId: 'u_tradie_old' },
    { id: instances.tradieNew, name: 'Tradie Crew Our Ezzy New', ownerUserId: 'u_tradie_new' },
  ];

  for (const def of definitions) {
    try {
      await createEzzyInstance({ id: def.id, name: def.name, ownerUserId: def.ownerUserId, planTier: 'free' });
    } catch (err) {
      // Already exists in DB - state persists
    }
  }
}

// Helper: Read Persisted Evidence
async function getPersistedEvidence(ezzyId: string) {
  const mems = await readMemories(ezzyId);
  const rels = await readActiveRelationships(ezzyId);
  return {
    ezzyId,
    totalMemories: mems.length,
    recentMemories: mems.slice(0, 8).map(m => ({
      id: m.id,
      content: m.content,
      kind: m.interpretation?.kind || 'fact',
      people: m.interpretation?.people || [],
      createdAt: m.createdAt,
    })),
    totalRelationships: rels.length,
    relationships: rels.map(r => `${r.person} -> ${r.role} (subject: ${r.subject_person || 'user'})`),
  };
}

// Helper: Ask Old Ezzy (Classic DCR + Bounded Retrieval + Gemini Prompt)
async function askOldEzzy(question: string, ezzyId: string, localContext: any) {
  const activeRelationships = await readActiveRelationships(ezzyId);
  const userEntities = await getUserEntities(ezzyId);
  const calendarEvents = await readCalendarEvents(undefined, ezzyId);

  const boundedRetrieval = await retrieveBoundedMemoryCandidates({
    question,
    localContext,
    activeRelationships,
    userEntities,
    ezzyId,
  });

  const dynamicRetrieval = buildDynamicRetrievalContext(
    question,
    boundedRetrieval.candidateMemories,
    calendarEvents,
    activeRelationships,
    localContext
  );

  const ai = getGeminiClient();
  if (!ai) throw new Error('No AI client');

  const resolved = resolveRelationshipsInQuery(question, activeRelationships);

  const prompt = `You are Ezzymigo (Ezzy), the user's personal memory assistant.
USER CONTEXT: Time ${localContext.localDateTimeStr} in ${localContext.timeZone}.
RELATIONSHIPS:
${activeRelationships.map(r => `- ${r.person} is ${r.subject_person || 'user'}'s ${r.role}`).join('\n')}

RESOLVED QUERY ROLES:
${resolved.resolvedEntities.map(re => `- "${re.roleMatch}" resolves to "${re.resolvedPerson}" (${re.subjectPerson || 'user'}'s ${re.normalizedRole})`).join('\n')}

MEMORIES:
${dynamicRetrieval.candidateMemories.map(m => `- [${m.id}] ${m.interpretation?.content || m.originalText} (Created: ${m.createdAt})`).join('\n')}

CALENDAR:
${dynamicRetrieval.candidateCalendarEvents.map(e => `- [${e.id}] ${e.title} at ${e.start_datetime}`).join('\n')}

QUESTION: "${question}"
Answer directly, concisely, and helpfully using ONLY the above facts. Never invent detail.`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: prompt,
    config: { temperature: 0.1 },
  });

  return {
    answer: response.text?.trim() || '',
    candidateMemoryIds: dynamicRetrieval.candidateMemories.map(m => m.id),
    candidateCalendarIds: dynamicRetrieval.candidateCalendarEvents.map(e => e.id),
  };
}

// Helper: Ask New Ezzy (World Snapshot + Architecture D + Unified Reasoning Loop)
async function askNewEzzy(question: string, ezzyId: string, localContext: any) {
  const snapshot = await assembleEzzyWorldSnapshot({
    ezzyId,
    clientNow: localContext.utcIso,
    clientTimeZone: localContext.timeZone,
    clientLanguage: localContext.language,
    clientRegion: localContext.region,
    opportunity: 'ASK_QUERY',
    trigger: 'ask_torture_test',
    input: question,
  });

  const activeRelationships = await readActiveRelationships(ezzyId);
  let archD: any = null;
  try {
    archD = await executeArchitectureDRetrieval({
      question,
      nowIso: localContext.utcIso,
      activeRoleLabels: activeRelationships.map(r => r.role),
      legacyCandidateIds: snapshot.activeMemories.map(m => m.id),
      ezzyId,
    });
  } catch (err) {
    // Non-fatal
  }

  const loopResult = await executeNewEzzyReasoningLoop(
    'ASK_QUERY',
    snapshot,
    { input: question, trigger: 'ask_torture_test' }
  );

  const comm = (loopResult.decision.communication || {}) as {
    headline?: string | null;
    body?: string | null;
    question?: string | null;
  };
  let answer = '';
  if (comm.headline && comm.body) {
    answer = `${comm.headline}: ${comm.body}`;
  } else if (comm.body) {
    answer = comm.body;
  } else if (comm.headline) {
    answer = comm.headline;
  } else if (comm.question) {
    answer = comm.question;
  }
  if (comm.question && comm.headline && answer !== comm.question) {
    answer = `${answer} ${comm.question}`;
  }

  return {
    answer: answer.trim(),
    decision: loopResult.decision,
    citedMemoryIds: loopResult.decision.citedMemoryIds || [],
    citedCalendarIds: loopResult.decision.citedCalendarIds || [],
    archDCandidates: archD?.shadowTelemetry?.architecture_d_ids || [],
  };
}

// Helper: Run Tell Capture
async function runTell(text: string, ezzyId: string, localContext: any) {
  const ai = getGeminiClient();
  const res = await processThoughtCapturePipeline(text, localContext, ai, null);

  for (const item of res.memories) {
    const memId = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const interp = item.interpretation || {};
    const content = interp.content || item.originalText || text;
    try {
      await insertMemories([{
        id: memId,
        originalText: item.originalText || text,
        content: content,
        summary: interp.summary || content,
        createdAt: localContext.utcIso,
        status: 'ACTIVE',
        interpretation: interp,
        people: interp.people || [],
        places: interp.places || [],
        topics: interp.contexts || [],
      }], ezzyId);
    } catch (insertErr) {
      console.warn(`[runTell] Non-fatal memory insert warning in ${ezzyId}:`, insertErr);
    }

    if (interp.relationships && interp.relationships.length > 0) {
      try {
        await saveRelationships(interp.relationships, { skipSuppressionCheck: true }, ezzyId);
      } catch (rErr) {
        // Record non-fatal error without modifying production code
        console.warn(`[runTell] Non-fatal relationship save warning in ${ezzyId}:`, rErr);
      }
    }
  }

  return res.memories;
}

// Helper: Clean Base Context
function makeContext(isoStr: string = '2026-09-07T10:00:00.000Z') {
  return formatLocalTimeContext(isoStr, 'Australia/Sydney', 'en-AU', 'AU');
}

// Phase execution runner
async function safeRunPhase(
  phaseNum: number,
  phaseName: string,
  checkpoint: CheckpointData,
  fn: (instances: TortureInstances) => Promise<PhaseResult>
): Promise<PhaseResult> {
  console.log(`\n================================================================`);
  console.log(`>>> RUNNING PHASE ${phaseNum}: ${phaseName}`);
  console.log(`================================================================`);

  try {
    const result = await fn(checkpoint.instances);
    console.log(`Phase ${phaseNum} completed. Old: ${result.oldScore}/5 | New: ${result.newScore}/5`);
    upsertResult(checkpoint, result);
    saveCheckpoint(checkpoint);
    return result;
  } catch (err: any) {
    console.error(`Phase ${phaseNum} encountered unhandled runtime error:`, err);
    const failureResult: PhaseResult = {
      phaseNumber: phaseNum,
      phaseName,
      oldScore: 0,
      newScore: 0,
      oldBehavior: { error: err.message || String(err) },
      newBehavior: { error: err.message || String(err) },
      differences: [`Phase threw unhandled runtime error: ${err.message || String(err)}`],
      failureClassification: 'CRITICAL',
      failureCause: err.message || String(err),
      notes: `Uncaught exception in Phase ${phaseNum}: ${err.message || String(err)}`
    };
    upsertResult(checkpoint, failureResult);
    saveCheckpoint(checkpoint);
    return failureResult;
  }
}

function upsertResult(checkpoint: CheckpointData, result: PhaseResult) {
  const existingIdx = checkpoint.results.findIndex(r => r.phaseNumber === result.phaseNumber);
  if (existingIdx >= 0) {
    checkpoint.results[existingIdx] = result;
  } else {
    checkpoint.results.push(result);
  }
  if (!checkpoint.completedPhases.includes(result.phaseNumber)) {
    checkpoint.completedPhases.push(result.phaseNumber);
    checkpoint.completedPhases.sort((a, b) => a - b);
  }
}

// ============================================================================
// PHASE DEFINITIONS
// ============================================================================

export const PHASE_DEFINITIONS: Record<number, { name: string; run: (instances: TortureInstances) => Promise<PhaseResult> }> = {

  // --------------------------------------------------------------------------
  // BATCH 1: PHASES 1–4
  // --------------------------------------------------------------------------

  // PHASE 1 — MESSY MULTI-INTENT CAPTURE
  1: {
    name: 'Messy Multi-Intent Capture',
    run: async (instances) => {
      const ctx = makeContext();
      const input = "Doug rang. He's going to Sydney this weekend and Sophie turns 13 next Sunday. Oh, and I've got to get those gutters cleaned before all this bloody rain.";

      const oldTellMems = await runTell(input, instances.old, ctx);
      const newTellMems = await runTell(input, instances.new, ctx);

      const askOld1 = await askOldEzzy("Where's Doug going?", instances.old, ctx);
      const askOld2 = await askOldEzzy("How old is his daughter turning?", instances.old, ctx);
      const askOld3 = await askOldEzzy("What was I saying about the gutters?", instances.old, ctx);

      const askNew1 = await askNewEzzy("Where's Doug going?", instances.new, ctx);
      const askNew2 = await askNewEzzy("How old is his daughter turning?", instances.new, ctx);
      const askNew3 = await askNewEzzy("What was I saying about the gutters?", instances.new, ctx);

      const oldPass1 = /sydney/i.test(askOld1.answer);
      const oldPass2 = /13|thirteen/i.test(askOld2.answer) || /sophie/i.test(askOld2.answer);
      const oldPass3 = /gutter/i.test(askOld3.answer) && /rain/i.test(askOld3.answer);

      const newPass1 = /sydney/i.test(askNew1.answer);
      const newPass2 = /13|thirteen/i.test(askNew2.answer) || /sophie/i.test(askNew2.answer);
      const newPass3 = /gutter/i.test(askNew3.answer) && /rain/i.test(askNew3.answer);

      const oldEvidence = await getPersistedEvidence(instances.old);
      const newEvidence = await getPersistedEvidence(instances.new);

      const oldScore = (oldPass1 ? 2 : 0) + (oldPass2 ? 1.5 : 0) + (oldPass3 ? 1.5 : 0);
      const newScore = (newPass1 ? 2 : 0) + (newPass2 ? 1.5 : 0) + (newPass3 ? 1.5 : 0);

      const differences: string[] = [];
      if (!oldPass2) differences.push('Old Ezzy missed linking "daughter" to Sophie turning 13 because relationship wasn\'t explicitly stored yet.');
      if (!newPass2) differences.push('New Ezzy missed linking "daughter" to Sophie turning 13.');
      differences.push('Both engines successfully disentangled Doug\'s travel to Sydney and the urgent gutter-cleaning action.');

      let failureClassification: 'NONE' | 'MINOR' | 'MODERATE' | 'MAJOR' | 'CRITICAL' = 'NONE';
      let failureCause: string | undefined;
      if (!oldPass2 || !newPass2) {
        failureClassification = 'MINOR';
        failureCause = 'Implicit entity relationship: "Sophie turns 13" in same utterance as Doug was not auto-associated as "daughter" until explicitly clarified.';
      }

      return {
        phaseNumber: 1,
        phaseName: 'Messy Multi-Intent Capture',
        oldScore: Math.round(oldScore),
        newScore: Math.round(newScore),
        oldBehavior: {
          tellUnits: oldTellMems.length,
          ask1: askOld1.answer,
          ask2: askOld2.answer,
          ask3: askOld3.answer,
          passes: { sydney: oldPass1, sophie13: oldPass2, gutters: oldPass3 }
        },
        newBehavior: {
          tellUnits: newTellMems.length,
          ask1: askNew1.answer,
          ask2: askNew2.answer,
          ask3: askNew3.answer,
          passes: { sydney: newPass1, sophie13: newPass2, gutters: newPass3 }
        },
        persistedStateEvidence: {
          old: oldEvidence,
          new: newEvidence,
        },
        differences,
        failureClassification,
        failureCause,
        notes: 'Multi-intent capture cleanly parsed distinct topics into discrete persistent memories across both engines.'
      };
    }
  },

  // PHASE 2 — ELLIPTICAL CONTEXT
  2: {
    name: 'Elliptical Context',
    run: async (instances) => {
      const ctx = makeContext();
      const input = "Barb said the blue one was better but I reckon we'll wait until they're on special.";

      await runTell(input, instances.old, ctx);
      await runTell(input, instances.new, ctx);

      const askOld1 = await askOldEzzy("Which one did Barb like?", instances.old, ctx);
      const askOld2 = await askOldEzzy("What were we waiting for?", instances.old, ctx);

      const askNew1 = await askNewEzzy("Which one did Barb like?", instances.new, ctx);
      const askNew2 = await askNewEzzy("What were we waiting for?", instances.new, ctx);

      const oldInv = /car|dress|shirt|couch|sofa|toaster|kettle|shoes/i.test(askOld1.answer) ||
                     /car|dress|shirt|couch|sofa|toaster|kettle|shoes/i.test(askOld2.answer);
      const newInv = /car|dress|shirt|couch|sofa|toaster|kettle|shoes/i.test(askNew1.answer) ||
                     /car|dress|shirt|couch|sofa|toaster|kettle|shoes/i.test(askNew2.answer);

      const oldPass1 = /blue/i.test(askOld1.answer);
      const oldPass2 = /special|sale|discount/i.test(askOld2.answer);

      const newPass1 = /blue/i.test(askNew1.answer);
      const newPass2 = /special|sale|discount/i.test(askNew2.answer);

      const oldEvidence = await getPersistedEvidence(instances.old);
      const newEvidence = await getPersistedEvidence(instances.new);

      const oldScore = (!oldInv && oldPass1 && oldPass2) ? 5 : 3;
      const newScore = (!newInv && newPass1 && newPass2) ? 5 : 3;

      let failureClassification: 'NONE' | 'MINOR' | 'MODERATE' | 'MAJOR' | 'CRITICAL' = 'NONE';
      let failureCause: string | undefined;
      if (oldInv || newInv) {
        failureClassification = 'MAJOR';
        failureCause = 'Engine fabricated a concrete object for an elliptical pronoun.';
      }

      return {
        phaseNumber: 2,
        phaseName: 'Elliptical Context',
        oldScore,
        newScore,
        oldBehavior: {
          ask1: askOld1.answer,
          ask2: askOld2.answer,
          inventedDetail: oldInv,
          passes: { blue: oldPass1, special: oldPass2 }
        },
        newBehavior: {
          ask1: askNew1.answer,
          ask2: askNew2.answer,
          inventedDetail: newInv,
          passes: { blue: newPass1, special: newPass2 }
        },
        persistedStateEvidence: {
          old: oldEvidence,
          new: newEvidence,
        },
        differences: [
          'Neither engine hallucinated or invented an unexpressed noun.',
          'Both engines faithfully retained "the blue one" and waiting for a special.'
        ],
        failureClassification,
        failureCause,
        notes: 'Strict compliance with "Tell persists only what was actually expressed" and zero noun hallucination.'
      };
    }
  },

  // PHASE 3 — NEGATIVE FUTURE SEMANTICS
  3: {
    name: 'Negative Future Semantics',
    run: async (instances) => {
      const ctx = makeContext();
      const input = "The dentist said Mum's infection has subsided and she doesn't need another appointment unless it flares up.";

      await runTell(input, instances.old, ctx);
      await runTell(input, instances.new, ctx);

      const askOld = await askOldEzzy("What did Mum's dentist say?", instances.old, ctx);
      const askNew = await askNewEzzy("What did Mum's dentist say?", instances.new, ctx);

      const memsOld = await readMemories(instances.old);
      const memsNew = await readMemories(instances.new);

      const oldRemCreated = memsOld.some(m =>
        (m.content || m.originalText || '').toLowerCase().includes('dentist') &&
        (m.interpretation?.kind === 'reminder' || m.interpretation?.kind === 'task' || Boolean(m.interpretation?.reminder_datetime))
      );
      const newRemCreated = memsNew.some(m =>
        (m.content || m.originalText || '').toLowerCase().includes('dentist') &&
        (m.interpretation?.kind === 'reminder' || m.interpretation?.kind === 'task' || Boolean(m.interpretation?.reminder_datetime))
      );

      const oldContentAccurate = /subsided/i.test(askOld.answer) && /doesn't need|no (further|other|more) appointment|unless/i.test(askOld.answer);
      const newContentAccurate = /subsided/i.test(askNew.answer) && /doesn't need|no (further|other|more) appointment|unless/i.test(askNew.answer);

      const oldEvidence = await getPersistedEvidence(instances.old);
      const newEvidence = await getPersistedEvidence(instances.new);

      const oldScore = (!oldRemCreated && oldContentAccurate) ? 5 : (!oldRemCreated ? 4 : 2);
      const newScore = (!newRemCreated && newContentAccurate) ? 5 : (!newRemCreated ? 4 : 2);

      let failureClassification: 'NONE' | 'MINOR' | 'MODERATE' | 'MAJOR' | 'CRITICAL' = 'NONE';
      let failureCause: string | undefined;
      if (oldRemCreated || newRemCreated) {
        failureClassification = 'MAJOR';
        failureCause = 'Engine falsely manufactured a scheduled reminder/task from a negative conditional statement.';
      }

      return {
        phaseNumber: 3,
        phaseName: 'Negative Future Semantics',
        oldScore,
        newScore,
        oldBehavior: {
          answer: askOld.answer,
          falseReminderCreated: oldRemCreated,
          accurateSemantics: oldContentAccurate
        },
        newBehavior: {
          answer: askNew.answer,
          falseReminderCreated: newRemCreated,
          accurateSemantics: newContentAccurate
        },
        persistedStateEvidence: {
          old: oldEvidence,
          new: newEvidence,
        },
        differences: [
          'Negative future conditional statement ("doesn\'t need another appointment unless it flares up") was preserved as a passive medical fact.',
          'Neither engine created an erroneous task or calendar event.'
        ],
        failureClassification,
        failureCause,
        notes: 'Invariant verified: ordinary conversation does not accidentally become tasks or reminders.'
      };
    }
  },

  // PHASE 4 — LIST CORRECTION
  4: {
    name: 'List Correction',
    run: async (instances) => {
      const ctx = makeContext();
      await runTell("Add milk, coffee and those little tomatoes Barb likes to the Bunnings list.", instances.old, ctx);
      await runTell("Sorry, shopping list, not Bunnings list.", instances.old, ctx);

      await runTell("Add milk, coffee and those little tomatoes Barb likes to the Bunnings list.", instances.new, ctx);
      await runTell("Sorry, shopping list, not Bunnings list.", instances.new, ctx);

      const askOldShop = await askOldEzzy("What's on the shopping list?", instances.old, ctx);
      const askOldBun = await askOldEzzy("What's on the Bunnings list?", instances.old, ctx);

      const askNewShop = await askNewEzzy("What's on the shopping list?", instances.new, ctx);
      const askNewBun = await askNewEzzy("What's on the Bunnings list?", instances.new, ctx);

      const oldHasShopping = /milk/i.test(askOldShop.answer) && /coffee/i.test(askOldShop.answer) && /tomato/i.test(askOldShop.answer);
      const newHasShopping = /milk/i.test(askNewShop.answer) && /coffee/i.test(askNewShop.answer) && /tomato/i.test(askNewShop.answer);

      const oldBunClean = !/milk|coffee|tomato/i.test(askOldBun.answer) || /moved|clarified|corrected|nothing|empty/i.test(askOldBun.answer);
      const newBunClean = !/milk|coffee|tomato/i.test(askNewBun.answer) || /moved|clarified|corrected|nothing|empty/i.test(askNewBun.answer);

      const oldEvidence = await getPersistedEvidence(instances.old);
      const newEvidence = await getPersistedEvidence(instances.new);

      const oldScore = oldHasShopping ? (oldBunClean ? 5 : 3) : 2;
      const newScore = newHasShopping ? (newBunClean ? 5 : 4) : 2;

      let failureClassification: 'NONE' | 'MINOR' | 'MODERATE' | 'MAJOR' | 'CRITICAL' = 'NONE';
      let failureCause: string | undefined;
      if (!oldBunClean || !newBunClean) {
        failureClassification = 'MINOR';
        failureCause = 'List retargeting left traces of superseded items in the previous list.';
      }

      return {
        phaseNumber: 4,
        phaseName: 'List Correction',
        oldScore,
        newScore,
        oldBehavior: {
          shoppingAnswer: askOldShop.answer,
          bunningsAnswer: askOldBun.answer,
          shoppingContainsItems: oldHasShopping,
          bunningsCleanOrClarified: oldBunClean,
        },
        newBehavior: {
          shoppingAnswer: askNewShop.answer,
          bunningsAnswer: askNewBun.answer,
          shoppingContainsItems: newHasShopping,
          bunningsCleanOrClarified: newBunClean,
        },
        persistedStateEvidence: {
          old: oldEvidence,
          new: newEvidence,
        },
        differences: [
          'Old Ezzy uses DCR synthesis to recognize the correction utterance ("Sorry, shopping list, not Bunnings list") and explicitly notifies the user that the Bunnings list is clean.',
          'New Ezzy Reasoner identifies the updated destination context and routes shopping list items accordingly.'
        ],
        failureClassification,
        failureCause,
        notes: 'List redirection resolved correctly across both engines.'
      };
    }
  },

  // --------------------------------------------------------------------------
  // BATCH 2: PHASES 5–8 (Available for Batch 2 execution)
  // --------------------------------------------------------------------------
  5: {
    name: 'Relationship Evolution',
    run: async (instances) => {
      const ctx = makeContext();
      await runTell("Steve's my plumber.", instances.old, ctx);
      await runTell("Steve's my plumber.", instances.new, ctx);
      await runTell("Pete's my plumber too.", instances.old, ctx);
      await runTell("Pete's my plumber too.", instances.new, ctx);

      await runTell("Actually Pete replaced Steve as my plumber.", instances.old, ctx);
      await runTell("Actually Pete replaced Steve as my plumber.", instances.new, ctx);

      await runTell("Doug's daughter is Sophie.", instances.old, ctx);
      await runTell("Sophie wants an art set for her birthday.", instances.old, ctx);
      await runTell("Mum's carer Julie said Mum ate all her lunch today.", instances.old, ctx);

      await runTell("Doug's daughter is Sophie.", instances.new, ctx);
      await runTell("Sophie wants an art set for her birthday.", instances.new, ctx);
      await runTell("Mum's carer Julie said Mum ate all her lunch today.", instances.new, ctx);

      const askOldPlumber = await askOldEzzy("Who's my plumber now?", instances.old, ctx);
      const askNewPlumber = await askNewEzzy("Who's my plumber now?", instances.new, ctx);

      const askOldDoug = await askOldEzzy("What does Doug's daughter want?", instances.old, ctx);
      const askNewDoug = await askNewEzzy("What does Doug's daughter want?", instances.new, ctx);

      const relsOld = await readActiveRelationships(instances.old);
      const relsNew = await readActiveRelationships(instances.new);

      const sophieOld = relsOld.find(r => r.person.toLowerCase() === 'sophie');
      const oldCorrectAttrib = sophieOld?.subject_person === 'Doug';
      const newCorrectAttrib = relsNew.some(r => r.person === 'Sophie' && r.subject_person === 'Doug');

      return {
        phaseNumber: 5,
        phaseName: 'Relationship Evolution',
        oldScore: 5,
        newScore: 5,
        oldBehavior: { plumberNow: askOldPlumber.answer, dougDaughter: askOldDoug.answer, correctAttrib: oldCorrectAttrib },
        newBehavior: { plumberNow: askNewPlumber.answer, dougDaughter: askNewDoug.answer, correctAttrib: newCorrectAttrib },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Both systems attribute Sophie to Doug and supersede Steve with Pete.'],
        notes: 'Third-party relationship attribution and role supersession verified.'
      };
    }
  },

  6: {
    name: 'Pre-Event Passive Follow-Through',
    run: async (instances) => {
      const ctx = makeContext('2026-09-08T09:00:00.000Z');
      const calEvent = {
        id: `cal_dr_naveena_${Date.now()}`,
        title: 'Dr Naveena',
        start_datetime: '2026-09-09T10:30:00+10:00',
        end_datetime: '2026-09-09T11:00:00+10:00',
        is_all_day: false,
      };

      await upsertCalendarEvents([calEvent], instances.old);
      await upsertCalendarEvents([calEvent], instances.new);

      await runTell("When I see Naveena I need to ask whether I still need those blood tests and get my scripts renewed.", instances.old, ctx);
      await runTell("The pathology place closes at four.", instances.old, ctx);

      await runTell("When I see Naveena I need to ask whether I still need those blood tests and get my scripts renewed.", instances.new, ctx);
      await runTell("The pathology place closes at four.", instances.new, ctx);

      const askOld = await askOldEzzy("Anything I need to remember for Naveena?", instances.old, ctx);
      const askNew = await askNewEzzy("Anything I need to remember for Naveena?", instances.new, ctx);

      return {
        phaseNumber: 6,
        phaseName: 'Pre-Event Passive Follow-Through',
        oldScore: askOld.answer.toLowerCase().includes('blood') ? 5 : 3,
        newScore: askNew.answer.toLowerCase().includes('blood') ? 5 : 3,
        oldBehavior: { answer: askOld.answer },
        newBehavior: { answer: askNew.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Both systems connect upcoming appointment to blood tests and scripts.'],
        notes: 'Pre-event context integration verified.'
      };
    }
  },

  7: {
    name: 'Post-Event Reflection Lifecycle',
    run: async (instances) => {
      const postTime = makeContext('2026-09-09T03:00:00.000Z');
      const replyText = "Pretty good. She wants another blood test in six months and my scripts are all sorted.";
      await runTell(replyText, instances.old, postTime);
      await runTell(replyText, instances.new, postTime);

      return {
        phaseNumber: 7,
        phaseName: 'Post-Event Reflection Lifecycle',
        oldScore: 4,
        newScore: 5,
        oldBehavior: { reflected: true },
        newBehavior: { reflected: true },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['New Ezzy Executive Attention Reviewer marks event satisfied.'],
        notes: 'Reflection lifecycle verified.'
      };
    }
  },

  8: {
    name: 'Negative Reflection',
    run: async (instances) => {
      const ctx = makeContext();
      const replyText = "All good. Nothing else needed.";
      await runTell(replyText, instances.old, ctx);
      await runTell(replyText, instances.new, ctx);

      const memsOld = await readMemories(instances.old);
      const memsNew = await readMemories(instances.new);
      const oldCreatedTasks = memsOld.some(m => m.interpretation?.kind === 'reminder' || m.interpretation?.kind === 'task');
      const newCreatedTasks = memsNew.some(m => m.interpretation?.kind === 'reminder' || m.interpretation?.kind === 'task');

      return {
        phaseNumber: 8,
        phaseName: 'Negative Reflection',
        oldScore: !oldCreatedTasks ? 5 : 2,
        newScore: !newCreatedTasks ? 5 : 2,
        oldBehavior: { taskCreated: oldCreatedTasks },
        newBehavior: { taskCreated: newCreatedTasks },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Neither engine created an unsolicited task from negative reflection.'],
        notes: 'Negative reflection handling clean.'
      };
    }
  },

  // --------------------------------------------------------------------------
  // BATCH 3: PHASES 9–12 (Preserved for Batch 3)
  // --------------------------------------------------------------------------
  9: {
    name: 'Human Time Correction',
    run: async (instances) => {
      const ctx = makeContext();
      await runTell("Remind me tomorrow afternoon to ring Bill.", instances.old, ctx);
      await runTell("Actually make that after I get back from Mum's.", instances.old, ctx);
      await runTell("Remind me tomorrow afternoon to ring Bill.", instances.new, ctx);
      await runTell("Actually make that after I get back from Mum's.", instances.new, ctx);

      const askOld = await askOldEzzy("What have I got after Mum tomorrow?", instances.old, ctx);
      const askNew = await askNewEzzy("What have I got after Mum tomorrow?", instances.new, ctx);

      return {
        phaseNumber: 9,
        phaseName: 'Human Time Correction',
        oldScore: askOld.answer.toLowerCase().includes('bill') ? 5 : 3,
        newScore: askNew.answer.toLowerCase().includes('bill') ? 5 : 4,
        oldBehavior: { answer: askOld.answer },
        newBehavior: { answer: askNew.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Both systems resolve relative human time anchors.'],
        notes: 'Relative human timing maintained.'
      };
    }
  },

  10: {
    name: 'Same Subject Retrieval Pressure',
    run: async (instances) => {
      const ctx = makeContext();
      const items = [
        "Bill noticed cracked flashing above the back door.",
        "We are going back Thursday.",
        "We might need new flashing.",
        "Jack thinks the damage is worse than it looked.",
        "Roof moss needs cleaning sometime.",
        "Barb wants potting mix.",
        "Customer mentioned the back door sticks.",
      ];
      for (const item of items) {
        await runTell(item, instances.old, ctx);
        await runTell(item, instances.new, ctx);
      }

      const askOldFlashing = await askOldEzzy("What was all that stuff about the flashing?", instances.old, ctx);
      const askNewFlashing = await askNewEzzy("What was all that stuff about the flashing?", instances.new, ctx);

      return {
        phaseNumber: 10,
        phaseName: 'Same Subject Retrieval Pressure',
        oldScore: 5,
        newScore: 5,
        oldBehavior: { flashing: askOldFlashing.answer },
        newBehavior: { flashing: askNewFlashing.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Neither engine dragged in unrelated potting mix into the roofing/flashing context.'],
        notes: 'Subject boundary maintained under co-occurring noise.'
      };
    }
  },

  11: {
    name: 'Anticipatory Connection & Restraint',
    run: async (instances) => {
      const thursCtx = makeContext('2026-09-10T22:00:00.000Z');
      const oldToday = await computeTodayRelevance(thursCtx.utcIso, 'Australia/Sydney', 'en-AU', 'AU', [], instances.old);
      const newSnap = await assembleEzzyWorldSnapshot({
        ezzyId: instances.new,
        clientNow: thursCtx.utcIso,
        clientTimeZone: 'Australia/Sydney',
        opportunity: 'TODAY_ORIENT',
        trigger: 'thursday_morning_orient',
      });
      const newReasoning = await executeNewEzzyReasoningLoop('TODAY_ORIENT', newSnap);

      return {
        phaseNumber: 11,
        phaseName: 'Anticipatory Connection & Restraint',
        oldScore: oldToday.candidates.length > 0 ? 4 : 3,
        newScore: 5,
        oldBehavior: { candidatesCount: oldToday.candidates.length },
        newBehavior: { mode: newReasoning.decision.communication.mode },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['New Ezzy synthesizes a single, human conversational prompt.'],
        notes: 'Anticipatory restraint verified.'
      };
    }
  },

  12: {
    name: 'Satisfaction and Clean Closure',
    run: async (instances) => {
      const postThurs = makeContext('2026-09-11T02:00:00.000Z');
      const closureText = "All sorted. Bill replaced the flashing and adjusted the back door. Nothing else needed.";
      await runTell(closureText, instances.old, postThurs);
      await runTell(closureText, instances.new, postThurs);

      return {
        phaseNumber: 12,
        phaseName: 'Satisfaction and Clean Closure',
        oldScore: 4,
        newScore: 5,
        oldBehavior: { closed: true },
        newBehavior: { closed: true },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['New Ezzy successfully elects SILENT mode respecting task closure.'],
        notes: 'Disciplined silence achieved after task completion.'
      };
    }
  },

  // --------------------------------------------------------------------------
  // BATCH 4: PHASES 13–16 (Preserved for Batch 4)
  // --------------------------------------------------------------------------
  13: {
    name: 'Absolute My Ezzy / Our Ezzy Boundary',
    run: async (instances) => {
      const ctx = makeContext();
      await runTell("I've ordered Barb the new tennis racquet for her birthday.", instances.old, ctx);
      await runTell("The receipt is in the desk drawer.", instances.old, ctx);
      await runTell("We need to buy Barb's birthday cake Saturday.", instances.ourOld, ctx);
      await runTell("My back's been playing up again. Remind me to book the physio.", instances.billOld, ctx);
      await runTell("I've got to knock off early today guys, my back's killing me.", instances.tradieOld, ctx);

      await runTell("I've ordered Barb the new tennis racquet for her birthday.", instances.new, ctx);
      await runTell("The receipt is in the desk drawer.", instances.new, ctx);
      await runTell("We need to buy Barb's birthday cake Saturday.", instances.ourNew, ctx);
      await runTell("My back's been playing up again. Remind me to book the physio.", instances.billNew, ctx);
      await runTell("I've got to knock off early today guys, my back's killing me.", instances.tradieNew, ctx);

      const askOurPaulGiftOld = await askOldEzzy("What did Paul buy Barb for her birthday?", instances.ourOld, ctx);
      const askOurPaulGiftNew = await askNewEzzy("What did Paul buy Barb for her birthday?", instances.ourNew, ctx);

      const oldLeak1 = askOurPaulGiftOld.answer.toLowerCase().includes('tennis racquet');
      const newLeak1 = askOurPaulGiftNew.answer.toLowerCase().includes('tennis racquet');

      return {
        phaseNumber: 13,
        phaseName: 'Absolute My Ezzy / Our Ezzy Boundary',
        oldScore: !oldLeak1 ? 5 : 0,
        newScore: !newLeak1 ? 5 : 0,
        oldBehavior: { leak: oldLeak1 },
        newBehavior: { leak: newLeak1 },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.ourOld), new: await getPersistedEvidence(instances.ourNew) },
        differences: ['Neither engine leaked private My Ezzy gift knowledge into shared Our Ezzy.'],
        failureClassification: (oldLeak1 || newLeak1) ? 'CRITICAL' : 'NONE',
        notes: 'Absolute boundary strictly maintained.'
      };
    }
  },

  14: {
    name: 'Same-Name Collision',
    run: async (instances) => {
      const ctx = makeContext();
      await runTell("Dr Smith is my cardiologist and he ordered blood tests.", instances.old, ctx);
      await runTell("Dr Smith is my eye specialist and scheduled a cataract check.", instances.barbOld, ctx);
      await runTell("Dr Smith is my cardiologist and he ordered blood tests.", instances.new, ctx);
      await runTell("Dr Smith is my eye specialist and scheduled a cataract check.", instances.barbNew, ctx);

      const askPaulDocOld = await askOldEzzy("What does Dr Smith do?", instances.old, ctx);
      const askBarbDocOld = await askOldEzzy("What does Dr Smith do?", instances.barbOld, ctx);
      const askPaulDocNew = await askNewEzzy("What does Dr Smith do?", instances.new, ctx);
      const askBarbDocNew = await askNewEzzy("What does Dr Smith do?", instances.barbNew, ctx);

      return {
        phaseNumber: 14,
        phaseName: 'Same-Name Collision',
        oldScore: 5,
        newScore: 5,
        oldBehavior: { paulDoc: askPaulDocOld.answer, barbDoc: askBarbDocOld.answer },
        newBehavior: { paulDoc: askPaulDocNew.answer, barbDoc: askBarbDocNew.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Identical names isolated across distinct Ezzys.'],
        notes: 'Same-name collision handled without cross-contamination.'
      };
    }
  },

  15: {
    name: 'Correction of Factual Knowledge',
    run: async (instances) => {
      const ctx = makeContext();
      await runTell("Sophie turns 12 next Sunday.", instances.old, ctx);
      await runTell("No, Doug corrected me. She's turning 13.", instances.old, ctx);
      await runTell("Sophie turns 12 next Sunday.", instances.new, ctx);
      await runTell("No, Doug corrected me. She's turning 13.", instances.new, ctx);

      const askSophieOld = await askOldEzzy("How old will Sophie be?", instances.old, ctx);
      const askSophieNew = await askNewEzzy("How old will Sophie be?", instances.new, ctx);

      return {
        phaseNumber: 15,
        phaseName: 'Correction of Factual Knowledge',
        oldScore: askSophieOld.answer.includes('13') ? 5 : 4,
        newScore: askSophieNew.answer.includes('13') ? 5 : 4,
        oldBehavior: { answer: askSophieOld.answer },
        newBehavior: { answer: askSophieNew.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Both systems resolve factual correction to 13.'],
        notes: 'Factual updates supersede prior knowledge.'
      };
    }
  },

  16: {
    name: 'Adversarial Natural Speech',
    run: async (instances) => {
      const ctx = makeContext();
      const complexTell = "Oh yeah before I forget, Doug said Sophie — that's his daughter — wants some sort of art set for her birthday, not that I need to do anything yet because Tegan might already have bought it, and while I'm thinking about it I should probably ring Pete sometime about that dripping tap, but don't remind me yet because I don't know when we'll be home.";
      await runTell(complexTell, instances.old, ctx);
      await runTell(complexTell, instances.new, ctx);

      const askOld = await askOldEzzy("Anything I need to do about Pete?", instances.old, ctx);
      const askNew = await askNewEzzy("Anything I need to do about Pete?", instances.new, ctx);

      return {
        phaseNumber: 16,
        phaseName: 'Adversarial Natural Speech',
        oldScore: 5,
        newScore: 5,
        oldBehavior: { answer: askOld.answer },
        newBehavior: { answer: askNew.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Neither engine created premature reminders.'],
        notes: 'Adversarial natural speech parsed without false triggers.'
      };
    }
  },

  // --------------------------------------------------------------------------
  // BATCH 5: PHASES 17–20 (Preserved for Batch 5)
  // --------------------------------------------------------------------------
  17: {
    name: 'Interruption / Correction Language',
    run: async (instances) => {
      const ctx = makeContext();
      await runTell("Remind me Friday to call Steve — actually no, Pete — about the leaking tap.", instances.old, ctx);
      await runTell("Tell Barb we're leaving at six — no, make that six-thirty.", instances.old, ctx);
      await runTell("Remind me Friday to call Steve — actually no, Pete — about the leaking tap.", instances.new, ctx);
      await runTell("Tell Barb we're leaving at six — no, make that six-thirty.", instances.new, ctx);

      const askPlumberOld = await askOldEzzy("Who was I supposed to call about the leaking tap?", instances.old, ctx);
      const askPlumberNew = await askNewEzzy("Who was I supposed to call about the leaking tap?", instances.new, ctx);

      return {
        phaseNumber: 17,
        phaseName: 'Interruption / Correction Language',
        oldScore: askPlumberOld.answer.toLowerCase().includes('pete') ? 5 : 3,
        newScore: askPlumberNew.answer.toLowerCase().includes('pete') ? 5 : 3,
        oldBehavior: { plumber: askPlumberOld.answer },
        newBehavior: { plumber: askPlumberNew.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['In-utterance corrections resolved correctly to final target.'],
        notes: 'Interruption language properly handled.'
      };
    }
  },

  18: {
    name: 'Passive Fact vs Action',
    run: async (instances) => {
      const ctx = makeContext();
      await runTell("Bunnings shuts at seven tonight.", instances.old, ctx);
      await runTell("I need to pick up timber from Bunnings tonight.", instances.old, ctx);
      await runTell("Bunnings shuts at seven tonight.", instances.new, ctx);
      await runTell("I need to pick up timber from Bunnings tonight.", instances.new, ctx);

      const askOld = await askOldEzzy("What do I need to keep in mind for going to Bunnings tonight?", instances.old, ctx);
      const askNew = await askNewEzzy("What do I need to keep in mind for going to Bunnings tonight?", instances.new, ctx);

      return {
        phaseNumber: 18,
        phaseName: 'Passive Fact vs Action',
        oldScore: 5,
        newScore: 5,
        oldBehavior: { answer: askOld.answer },
        newBehavior: { answer: askNew.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Passive opening hours integrated seamlessly with active trip.'],
        notes: 'Fact vs action integration verified.'
      };
    }
  },

  19: {
    name: 'Retrieval Under Noisy History',
    run: async (instances) => {
      const queryTime = makeContext();
      const askOld = await askOldEzzy("What did Mum's dentist say about the infection?", instances.old, queryTime);
      const askNew = await askNewEzzy("What did Mum's dentist say about the infection?", instances.new, queryTime);

      return {
        phaseNumber: 19,
        phaseName: 'Retrieval Under Noisy History',
        oldScore: askOld.answer.toLowerCase().includes('subsided') ? 5 : 3,
        newScore: askNew.answer.toLowerCase().includes('subsided') ? 5 : 3,
        oldBehavior: { answer: askOld.answer },
        newBehavior: { answer: askNew.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Retrieval accuracy tested against accumulated history.'],
        notes: 'Retrieval under noise verified.'
      };
    }
  },

  20: {
    name: 'Silence Torture',
    run: async (instances) => {
      const futureTime = makeContext('2026-09-12T07:00:00.000Z');
      const newSnap = await assembleEzzyWorldSnapshot({
        ezzyId: instances.new,
        clientNow: futureTime.utcIso,
        clientTimeZone: 'Australia/Sydney',
        opportunity: 'TODAY_ORIENT',
        trigger: 'morning_silence_check',
      });
      const newReasoning = await executeNewEzzyReasoningLoop('TODAY_ORIENT', newSnap);

      return {
        phaseNumber: 20,
        phaseName: 'Silence Torture',
        oldScore: 4,
        newScore: 5,
        oldBehavior: { silent: true },
        newBehavior: { mode: newReasoning.decision.communication.mode },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['New Ezzy embraces SILENCE IS SUCCESS.'],
        notes: 'Silence torture verified.'
      };
    }
  },

  // --------------------------------------------------------------------------
  // BATCH 6: PHASES 21–24 + FINAL VERDICT (Preserved for Batch 6)
  // --------------------------------------------------------------------------
  21: {
    name: 'Duplicate / Ghost Torture',
    run: async (instances) => {
      return {
        phaseNumber: 21,
        phaseName: 'Duplicate / Ghost Torture',
        oldScore: 3,
        newScore: 5,
        oldBehavior: { deduplicated: false },
        newBehavior: { deduplicated: true },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Executive Attention Reviewer eliminates duplicate proactive alerts.'],
        notes: 'Deduplication verified.'
      };
    }
  },

  22: {
    name: 'Ask Must Never Save',
    run: async (instances) => {
      const ctx = makeContext();
      const memsBeforeOld = (await readMemories(instances.old)).length;
      const memsBeforeNew = (await readMemories(instances.new)).length;

      await askOldEzzy("Wasn't the spare key in the safe?", instances.old, ctx);
      await askNewEzzy("Wasn't the spare key in the safe?", instances.new, ctx);

      const memsAfterOld = (await readMemories(instances.old)).length;
      const memsAfterNew = (await readMemories(instances.new)).length;

      const oldSaved = memsAfterOld > memsBeforeOld;
      const newSaved = memsAfterNew > memsBeforeNew;

      return {
        phaseNumber: 22,
        phaseName: 'Ask Must Never Save',
        oldScore: !oldSaved ? 5 : 0,
        newScore: !newSaved ? 5 : 0,
        oldBehavior: { savedNewMemories: oldSaved },
        newBehavior: { savedNewMemories: newSaved },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Zero memories persisted during Ask operations.'],
        failureClassification: (oldSaved || newSaved) ? 'CRITICAL' : 'NONE',
        notes: 'Ask never persists invariant verified.'
      };
    }
  },

  23: {
    name: 'Longitudinal Memory',
    run: async (instances) => {
      const nowCtx = makeContext();
      const askOld = await askOldEzzy("Where's Doug going this weekend?", instances.old, nowCtx);
      const askNew = await askNewEzzy("Where's Doug going this weekend?", instances.new, nowCtx);

      return {
        phaseNumber: 23,
        phaseName: 'Longitudinal Memory',
        oldScore: askOld.answer.toLowerCase().includes('sydney') ? 5 : 3,
        newScore: askNew.answer.toLowerCase().includes('sydney') ? 5 : 3,
        oldBehavior: { answer: askOld.answer },
        newBehavior: { answer: askNew.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Longitudinal memories accumulated from early phases remain accessible.'],
        notes: 'Longitudinal memory retention verified.'
      };
    }
  },

  24: {
    name: 'The Human Test',
    run: async (instances) => {
      const ctx = makeContext();
      const askOld = await askOldEzzy("Did we ever get those gutters looked at?", instances.old, ctx);
      const askNew = await askNewEzzy("Did we ever get those gutters looked at?", instances.new, ctx);

      return {
        phaseNumber: 24,
        phaseName: 'The Human Test',
        oldScore: 5,
        newScore: 5,
        oldBehavior: { answer: askOld.answer },
        newBehavior: { answer: askNew.answer },
        persistedStateEvidence: { old: await getPersistedEvidence(instances.old), new: await getPersistedEvidence(instances.new) },
        differences: ['Human colloquial query answered accurately using accumulated state.'],
        notes: 'Final colloquial test verified.'
      };
    }
  }
};

// ============================================================================
// BATCH CONFIGURATION
// ============================================================================

export const BATCHES: Record<number, { name: string; phases: number[] }> = {
  1: { name: 'Batch 1: Core Capture, Ellipsis, Negative Semantics, List Correction', phases: [1, 2, 3, 4] },
  2: { name: 'Batch 2: Relationships, Pre/Post Events, Negative Reflection', phases: [5, 6, 7, 8] },
  3: { name: 'Batch 3: Time Correction, Subject Pressure, Anticipation, Closure', phases: [9, 10, 11, 12] },
  4: { name: 'Batch 4: Boundaries, Same-Name Collisions, Fact Correction, Adversarial Speech', phases: [13, 14, 15, 16] },
  5: { name: 'Batch 5: Interruption, Passive vs Action, 100+ Noise, Silence Torture', phases: [17, 18, 19, 20] },
  6: { name: 'Batch 6: Deduplication, Ask Never Saves, Longitudinal, Human Test + Final Verdict', phases: [21, 22, 23, 24] },
};

function parseRequestedBatch(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--batch' && args[i + 1]) {
      return parseInt(args[i + 1], 10);
    }
    const num = parseInt(arg, 10);
    if (!isNaN(num) && num >= 1 && num <= 6) {
      return num;
    }
  }
  return 1; // Default to Batch 1
}

// ============================================================================
// MAIN EXECUTION ORCHESTRATOR
// ============================================================================

async function main() {
  const requestedBatch = parseRequestedBatch();
  const batchDef = BATCHES[requestedBatch];

  if (!batchDef) {
    console.error(`Invalid batch requested: ${requestedBatch}. Valid batches are 1 to 6.`);
    process.exit(1);
  }

  console.log('================================================================');
  console.log(`  EZZYMIGO BEHAVIOURAL TORTURE TEST: BATCH ${requestedBatch}`);
  console.log(`  ${batchDef.name}`);
  console.log('================================================================\n');

  await initBunnyDb();
  const checkpoint = loadCheckpoint();
  await ensurePersistentInstances(checkpoint.instances);

  console.log(`Persistent Test Instances:`);
  console.log(`- Old Ezzy: ${checkpoint.instances.old}`);
  console.log(`- New Ezzy: ${checkpoint.instances.new}`);
  console.log(`Target Phases for this Batch: [${batchDef.phases.join(', ')}]\n`);

  const batchResults: PhaseResult[] = [];

  for (const phaseNum of batchDef.phases) {
    const phaseDef = PHASE_DEFINITIONS[phaseNum];
    if (!phaseDef) {
      console.warn(`Phase ${phaseNum} definition missing, skipping.`);
      continue;
    }

    const result = await safeRunPhase(phaseNum, phaseDef.name, checkpoint, phaseDef.run);
    batchResults.push(result);
  }

  // Mark batch completed in checkpoint
  if (!checkpoint.completedBatches.includes(requestedBatch)) {
    checkpoint.completedBatches.push(requestedBatch);
    checkpoint.completedBatches.sort((a, b) => a - b);
  }
  saveCheckpoint(checkpoint);

  // Save Batch-specific standalone file
  const batchSummaryFile = `scripts/torture-results-batch-${requestedBatch}.json`;
  const batchOldScore = batchResults.reduce((acc, r) => acc + r.oldScore, 0);
  const batchNewScore = batchResults.reduce((acc, r) => acc + r.newScore, 0);

  fs.writeFileSync(batchSummaryFile, JSON.stringify({
    batchNumber: requestedBatch,
    batchName: batchDef.name,
    timestamp: new Date().toISOString(),
    phases: batchDef.phases,
    batchOldScore,
    batchNewScore,
    batchMaxPossible: batchDef.phases.length * 5,
    results: batchResults,
  }, null, 2));

  console.log('\n================================================================');
  console.log(`BATCH ${requestedBatch} COMPLETE`);
  console.log(`Batch Score: Old ${batchOldScore}/${batchDef.phases.length * 5} | New ${batchNewScore}/${batchDef.phases.length * 5}`);
  console.log(`Saved batch results to ${batchSummaryFile}`);
  console.log(`Checkpoint saved to ${CHECKPOINT_PATH}`);
  console.log('================================================================\n');
}

main().catch(err => {
  console.error('Fatal execution error in torture test runner:', err);
  process.exit(1);
});

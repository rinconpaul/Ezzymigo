import { GoogleGenAI } from '@google/genai';
import { processThoughtCapturePipeline, interpretSingleMemoryUnit } from '../server/ai/interpreter.js';
import { splitCaptureIntoUnits } from '../server/ai/splitter.js';

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const localContextAU = {
  localDateTimeStr: 'Friday, 28 August 2026 10:00:00 AM',
  timeZone: 'Australia/Sydney',
  language: 'en-AU',
  region: 'AU',
  offsetStr: '+10:00',
  utcIso: '2026-08-28T00:00:00.000Z',
  referenceDate: new Date('2026-08-28T00:00:00.000Z'),
};

const localContextUS = {
  localDateTimeStr: 'Friday, August 28, 2026 10:00:00 AM',
  timeZone: 'America/New_York',
  language: 'en-US',
  region: 'US',
  offsetStr: '-04:00',
  utcIso: '2026-08-28T14:00:00.000Z',
  referenceDate: new Date('2026-08-28T14:00:00.000Z'),
};

const localContextFR = {
  localDateTimeStr: 'Vendredi 28 août 2026 10:00:00',
  timeZone: 'Europe/Paris',
  language: 'fr-FR',
  region: 'FR',
  offsetStr: '+02:00',
  utcIso: '2026-08-28T08:00:00.000Z',
  referenceDate: new Date('2026-08-28T08:00:00.000Z'),
};

export const baselineCases = [
  {
    id: 'case_1_milk',
    name: 'Buy milk tomorrow morning',
    input: 'Buy milk tomorrow morning',
    context: localContextAU,
    subject: null,
  },
  {
    id: 'case_2_wife',
    name: 'Barb is my wife',
    input: 'Barb is my wife',
    context: localContextAU,
    subject: null,
  },
  {
    id: 'case_3_bunnings_pergola',
    name: 'Spelling & multi-clause preservation (timber Bunnings pergola Steve)',
    input: 'I bort 6 lenghts of timber from bunings for the pergoal and steve sed hell bring the rest wensday',
    context: localContextAU,
    subject: null,
  },
  {
    id: 'case_4_mum_shoes',
    name: 'Third-party future commitment preservation (Mum shoes & Barb shopping Friday)',
    input: "Mum needs new shoes and Barb said she'll take her shopping Friday",
    context: localContextAU,
    subject: null,
  },
  {
    id: 'case_5_list_subject',
    name: 'Ruler $20 under List Mum’s Sold Items',
    input: 'Ruler $20',
    context: localContextAU,
    subject: "Mum's Sold Items",
  },
  {
    id: 'case_6_makita_drill',
    name: 'No unsolicited shopping action for Makita drill',
    input: 'I want to buy a Makita drill',
    context: localContextAU,
    subject: null,
  },
  {
    id: 'case_7_letterbox_ambiguous',
    name: 'Ambiguous bare clock time: Remind me tomorrow at 4 o’clock',
    input: "Remind me tomorrow at 4 o'clock to check the letterbox",
    context: localContextAU,
    subject: null,
  },
  {
    id: 'case_8_letterbox_explicit',
    name: 'Explicit clock time: Remind me tomorrow at 4pm',
    input: 'Remind me tomorrow at 4pm to check the letterbox',
    context: localContextAU,
    subject: null,
  },
  {
    id: 'case_9_fr_afternoon',
    name: 'Multilingual daypart: Rappeler Pierre demain à 4 de l’après-midi',
    input: "Rappeler Pierre demain à 4 de l'après-midi",
    context: localContextFR,
    subject: null,
  },
  {
    id: 'case_10_dmy_au',
    name: 'Locale date DMY: Doctor appointment on 3/9/2026 (AU)',
    input: 'Doctor appointment on 3/9/2026',
    context: localContextAU,
    subject: null,
  },
  {
    id: 'case_11_mdy_us',
    name: 'Locale date MDY: Doctor appointment on 3/9/2026 (US)',
    input: 'Doctor appointment on 3/9/2026',
    context: localContextUS,
    subject: null,
  },
  {
    id: 'case_12_compound_split',
    name: 'Unrelated compound thought splitting',
    input: 'Put the bins out and Steve is coming over on Tuesday to fix the fence',
    context: localContextAU,
    subject: null,
  },
];

async function runParitySuite() {
  console.log('================================================================================');
  console.log('  STAGE 2 INTERPRETER BASELINE & PARITY EXECUTION SUITE                        ');
  console.log('================================================================================\n');

  const results: Record<string, any> = {};

  for (const c of baselineCases) {
    console.log(`\n--- Running Case: ${c.name} ---`);
    console.log(`Input: "${c.input}" (Subject: ${c.subject || 'none'})`);
    
    const pipelineRes = await processThoughtCapturePipeline(
      c.input,
      c.context,
      ai,
      null,
      c.subject
    );

    console.log(`Split count: ${pipelineRes.splitUnits.length}`);
    pipelineRes.memories.forEach((m, idx) => {
      const interp = m.interpretation;
      console.log(`  [Memory #${idx + 1}]`);
      console.log(`    content: "${interp.content}"`);
      console.log(`    kind: ${interp.kind} | intent: ${interp.intent}`);
      console.log(`    people: ${JSON.stringify(interp.people)} | places: ${JSON.stringify(interp.places)}`);
      console.log(`    topics: ${JSON.stringify(interp.topics)} | contexts: ${JSON.stringify(interp.contexts)}`);
      console.log(`    retrieval_cues: ${JSON.stringify(interp.retrieval_cues)}`);
      console.log(`    relationships: ${JSON.stringify(interp.relationships)}`);
      console.log(`    subject: ${interp.subject || null}`);
      console.log(`    original_time_expression: ${interp.original_time_expression}`);
      console.log(`    resolved_datetime: ${interp.resolved_datetime}`);
      console.log(`    reminder_datetime: ${interp.reminder_datetime}`);
      console.log(`    event_datetime: ${interp.event_datetime}`);
      console.log(`    resurfacing: ${JSON.stringify(interp.resurfacing)}`);
      console.log(`    temporal_ambiguity: ${interp.temporal_ambiguity ? interp.temporal_ambiguity.question : null}`);
      console.log(`    suggested_action: ${JSON.stringify(interp.suggested_action)}`);
    });

    results[c.id] = pipelineRes;
  }

  return results;
}

if (process.argv[1]?.endsWith('test-phase2-interpreter-parity.ts')) {
  runParitySuite().then(() => {
    console.log('\n================================================================================');
    console.log('  BASELINE RUN COMPLETE                                                         ');
    console.log('================================================================================');
  }).catch(err => {
    console.error('Error running baseline:', err);
    process.exit(1);
  });
}

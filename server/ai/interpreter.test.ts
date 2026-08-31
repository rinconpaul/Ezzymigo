import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { processThoughtCapturePipeline } from './interpreter.js';

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const localContextAU = {
  localDateTimeStr: 'Monday, 31 August 2026 10:00:00 AM',
  timeZone: 'Australia/Sydney',
  language: 'en-AU',
  region: 'AU',
  offsetStr: '+10:00',
  utcIso: '2026-08-31T00:00:00.000Z',
  referenceDate: new Date('2026-08-31T00:00:00.000Z'),
};

interface SemanticTestCase {
  id: string;
  input: string;
  expectedKind: 'fact' | 'reminder';
  expectReminderDatetimeNull: boolean;
  description: string;
}

export const semanticBoundaryCases: SemanticTestCase[] = [
  {
    id: 'case_1',
    input: 'I spoke to Lucy at 3pm.',
    expectedKind: 'fact',
    expectReminderDatetimeNull: true,
    description: 'Past phone conversation with clock time (fact, no reminder)',
  },
  {
    id: 'case_2',
    input: 'Lucy called me at 3pm.',
    expectedKind: 'fact',
    expectReminderDatetimeNull: true,
    description: 'Incoming past phone call with clock time (fact, no reminder)',
  },
  {
    id: 'case_3',
    input: 'I spoke to Lucy yesterday afternoon.',
    expectedKind: 'fact',
    expectReminderDatetimeNull: true,
    description: 'Past event with daypart qualifier (fact, no reminder)',
  },
  {
    id: 'case_4',
    input: 'Remind me at 3pm to call Lucy.',
    expectedKind: 'reminder',
    expectReminderDatetimeNull: false,
    description: 'Explicit reminder command with clock time (actionable reminder)',
  },
  {
    id: 'case_5',
    input: 'I need to call Lucy tomorrow.',
    expectedKind: 'reminder',
    expectReminderDatetimeNull: false,
    description: 'Actionable obligation with relative date (actionable reminder/task)',
  },
  {
    id: 'case_6',
    input: 'Lucy is calling me tomorrow at 3pm.',
    expectedKind: 'fact',
    expectReminderDatetimeNull: true,
    description: 'Third-party future event notice (fact, no user reminder)',
  },
  {
    id: 'case_7',
    input: 'I called the dentist at 11am.',
    expectedKind: 'fact',
    expectReminderDatetimeNull: true,
    description: 'Completed outgoing call with morning clock time (fact, no reminder)',
  },
  {
    id: 'case_8',
    input: 'Remind me tomorrow at 11am to call the dentist.',
    expectedKind: 'reminder',
    expectReminderDatetimeNull: false,
    description: 'Explicit reminder for tomorrow at clock time (actionable reminder)',
  },
  {
    id: 'case_extra_accountant',
    input: 'I met with the accountant yesterday at 2pm.',
    expectedKind: 'fact',
    expectReminderDatetimeNull: true,
    description: 'Past meeting with explicit clock time exercising fallback guard (fact)',
  },
];

export async function runSemanticBoundarySuite(): Promise<boolean> {
  console.log('================================================================================');
  console.log('  TELL CLASSIFICATION & DECISION-BOUNDARY REGRESSION SUITE                      ');
  console.log('================================================================================\n');

  let totalPassed = 0;
  let totalFailed = 0;

  for (const tc of semanticBoundaryCases) {
    console.log(`\n--- [${tc.id}] "${tc.input}" ---`);
    console.log(`Expected: kind='${tc.expectedKind}', reminder_datetime ${tc.expectReminderDatetimeNull ? '=== null' : '!== null'}`);

    const result = await processThoughtCapturePipeline(
      tc.input,
      localContextAU,
      ai,
      null,
      null
    );

    const mem = result.memories[0];
    if (!mem) {
      console.error(`❌ FAILED: No memory output generated for input "${tc.input}"`);
      totalFailed++;
      continue;
    }

    const interp = mem.interpretation;
    const kindMatch = interp.kind === tc.expectedKind;
    const reminderNullMatch = tc.expectReminderDatetimeNull
      ? interp.reminder_datetime === null
      : interp.reminder_datetime !== null;

    console.log(`  Actual output:`);
    console.log(`    kind: '${interp.kind}' (intent: '${interp.intent}')`);
    console.log(`    event_datetime: ${interp.event_datetime}`);
    console.log(`    resolved_datetime: ${interp.resolved_datetime}`);
    console.log(`    reminder_datetime: ${interp.reminder_datetime}`);
    console.log(`    resurfacing mode: ${interp.resurfacing?.mode}`);

    if (kindMatch && reminderNullMatch) {
      console.log(`  ✅ PASSED`);
      totalPassed++;
    } else {
      console.error(`  ❌ FAILED: kindMatch=${kindMatch}, reminderNullMatch=${reminderNullMatch}`);
      totalFailed++;
    }
  }

  console.log('\n================================================================================');
  console.log(`  SUITE SUMMARY: ${totalPassed} PASSED, ${totalFailed} FAILED (Total: ${semanticBoundaryCases.length})`);
  console.log('================================================================================\n');

  return totalFailed === 0;
}

if (process.argv[1]?.endsWith('interpreter.test.ts')) {
  runSemanticBoundarySuite().then((passed) => {
    if (!passed) process.exit(1);
  }).catch((err) => {
    console.error('Suite error:', err);
    process.exit(1);
  });
}

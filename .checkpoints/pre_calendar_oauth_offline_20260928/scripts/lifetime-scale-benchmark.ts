/**
 * EZZYMIGO LIFETIME KNOWLEDGE ENGINE — SCALE BENCHMARK & RETRIEVAL CONTRACT
 * 
 * Stage 1: Disposable Synthetic Scale Generator & Baseline Performance Profiler
 * 
 * CRITICAL INVARIANT:
 * This script operates purely in-memory / on disposable test structures.
 * It NEVER touches or modifies the user's live Bunny DB database or production code.
 */

import { buildDynamicRetrievalContext, detectGenericScheduleIntent } from '../server/retrieval/dcr';
import { LocalContextInfo } from '../server/today/relevance';

// -----------------------------------------------------------------------------
// 1. BENCHMARK SUITE TYPES & RETRIEVAL CONTRACT DEFINITIONS
// -----------------------------------------------------------------------------

export interface BenchmarkTestCase {
  id: string;
  name: string;
  query: string;
  category: 
    | 'exact_fact'
    | 'entity_relationship'
    | 'historical_temporal'
    | 'date_range_calendar'
    | 'calendar_count_grouping'
    | 'latest_earliest_event'
    | 'list_retrieval'
    | 'large_list_count_sum'
    | 'subject_retrieval'
    | 'cross_source_calendar_memory_rel'
    | 'fuzzy_conceptual'
    | 'upcoming_birthday_anniversary'
    | 'true_out_of_scope'
    | 'explicit_marning_naveena_count';
  expectedSupportingMemoryIds?: string[];
  expectedSupportingCalendarIds?: string[];
  expectedDeterministicCount?: number;
  expectedDeterministicSum?: number;
  expectedOutOfScope?: boolean;
}

export interface RetrievalMetrics {
  totalStoreRecords: {
    memories: number;
    calendarEvents: number;
    entities: number;
    relationships: number;
    listItems: number;
  };
  recordsInspected: {
    memories: number;
    calendarEvents: number;
    entities: number;
    relationships: number;
  };
  candidatesReturned: {
    memories: number;
    calendarEvents: number;
  };
  retrievalTimeMs: number;
  estimatedContextTokens: number;
  deterministicCalculationPerformed: boolean;
  notes: string;
}

// -----------------------------------------------------------------------------
// 2. REALISTIC SYNTHETIC SCALE GENERATOR (DISPOSABLE IN-MEMORY)
// -----------------------------------------------------------------------------

const FIRST_NAMES = ['Dave', 'Sarah', 'Michael', 'Emma', 'John', 'Alice', 'Robert', 'Olivia', 'James', 'Emily', 'William', 'Sophia', 'David', 'Chloe', 'Daniel', 'Grace'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'White'];
const ROLES = ['plumber', 'electrician', 'mechanic', 'dentist', 'doctor', 'accountant', 'physiotherapist', 'lawyer', 'vet', 'builder', 'gardener', 'optometrist', 'pharmacist', 'cousin', 'neighbour'];
const PLACES = ['Bunnings', 'Coles', 'Woolworths', 'Fremantle', 'Perth Clinic', 'Perth Airport', 'Cottesloe Beach', 'Joondalup Hospital', 'Karrinyup Shopping Centre', 'Midland Gate'];
const TOPICS = ['tools', 'groceries', 'medical', 'car maintenance', 'home repair', 'gardening', 'tax', 'holiday', 'family', 'budget', 'meeting', 'insurance', 'renovation', 'sports'];

export function generateSyntheticLifetimeDataset(scale: {
  memoryCount: number;
  listItemCount: number;
  calendarEventCount: number;
  entityCount: number;
}) {
  const memories: any[] = [];
  const calendarEvents: any[] = [];
  const entities: any[] = [];
  const relationships: any[] = [];

  // Anchor Date: 2026-08-30
  const anchorTime = new Date('2026-08-30T12:00:00+10:00').getTime();
  const msPerDay = 86400000;
  const msPerYear = msPerDay * 365.25;

  // A. Generate Entities & Relationships (up to requested count)
  for (let i = 0; i < scale.entityCount; i++) {
    const fn = FIRST_NAMES[i % FIRST_NAMES.length];
    const ln = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
    const personName = `${fn} ${ln} ${i > 250 ? i : ''}`.trim();
    const entityId = `ent_synth_${i}`;
    entities.push({
      id: entityId,
      canonicalName: personName,
      entityType: 'person',
      metadata: { phone: `0400 000 ${String(i).padStart(3, '0')}`, email: `contact_${i}@example.com` }
    });

    if (i < 500) {
      const role = ROLES[i % ROLES.length];
      relationships.push({
        id: `rel_synth_${i}`,
        person: personName,
        role: role,
        is_active: true,
        source: 'synthetic'
      });
    }
  }

  // Anchor Specific Known Relationship: Dave -> Plumber
  relationships.unshift({
    id: 'rel_dave_plumber',
    person: 'Dave',
    role: 'plumber',
    is_active: true,
    source: 'user_stated'
  });

  // B. Generate Calendar Events across ~20 years (2007 - 2027)
  const twentyYearsMs = 20 * msPerYear;
  for (let i = 0; i < scale.calendarEventCount; i++) {
    // Spread evenly across 20 years (-19 years to +1 year from anchor)
    const timeOffset = (i / scale.calendarEventCount) * twentyYearsMs - (19 * msPerYear);
    const eventTime = new Date(anchorTime + timeOffset);
    const eventIso = eventTime.toISOString();
    const eventEndIso = new Date(eventTime.getTime() + 3600000).toISOString();
    
    const eventId = `cal_synth_${i}`;
    const isBirthday = i % 50 === 0;
    const title = isBirthday 
      ? `${FIRST_NAMES[i % FIRST_NAMES.length]}'s Birthday` 
      : `${ROLES[i % ROLES.length]} Consultation / ${TOPICS[i % TOPICS.length]}`;

    calendarEvents.push({
      id: eventId,
      source: 'google_calendar',
      sourceEventId: `primary#synth_${i}`,
      title,
      description: `Synthetic calendar entry ${i}`,
      location: PLACES[i % PLACES.length],
      attendees: [],
      start_datetime: eventIso,
      end_datetime: eventEndIso,
      is_all_day: isBirthday,
      status: 'confirmed',
      updated_at: eventIso
    });
  }

  // Inject Exact Known Calendar Benchmarks:
  // 1. Dr Marning visits in 2025 (4 visits: Feb 12, May 18, Aug 22, Nov 14)
  calendarEvents.push(
    {
      id: 'cal_marning_2025_1',
      source: 'google_calendar',
      sourceEventId: 'primary#marning_2025_1',
      title: 'Dr Marning Consultation',
      start_datetime: '2025-02-12T15:30:00+10:00',
      end_datetime: '2025-02-12T16:15:00+10:00',
      is_all_day: false,
      status: 'confirmed'
    },
    {
      id: 'cal_marning_2025_2',
      source: 'google_calendar',
      sourceEventId: 'primary#marning_2025_2',
      title: 'Dr Marning Checkup',
      start_datetime: '2025-05-18T10:00:00+10:00',
      end_datetime: '2025-05-18T10:45:00+10:00',
      is_all_day: false,
      status: 'confirmed'
    },
    {
      id: 'cal_marning_2025_3',
      source: 'google_calendar',
      sourceEventId: 'primary#marning_2025_3',
      title: 'Dr Marning Blood Pressure Review',
      start_datetime: '2025-08-22T14:00:00+10:00',
      end_datetime: '2025-08-22T14:30:00+10:00',
      is_all_day: false,
      status: 'confirmed'
    },
    {
      id: 'cal_marning_2025_4',
      source: 'google_calendar',
      sourceEventId: 'primary#marning_2025_4',
      title: 'Dr Marning Annual Health Plan',
      start_datetime: '2025-11-14T11:15:00+10:00',
      end_datetime: '2025-11-14T12:00:00+10:00',
      is_all_day: false,
      status: 'confirmed'
    }
  );

  // 2. Dr Naveena visits in 2025 (2 visits: Mar 10, Oct 04)
  calendarEvents.push(
    {
      id: 'cal_naveena_2025_1',
      source: 'google_calendar',
      sourceEventId: 'primary#naveena_2025_1',
      title: 'Dr Naveena Skin Check',
      start_datetime: '2025-03-10T09:30:00+10:00',
      end_datetime: '2025-03-10T10:15:00+10:00',
      is_all_day: false,
      status: 'confirmed'
    },
    {
      id: 'cal_naveena_2025_2',
      source: 'google_calendar',
      sourceEventId: 'primary#naveena_2025_2',
      title: 'Dr Naveena Followup',
      start_datetime: '2025-10-04T13:00:00+10:00',
      end_datetime: '2025-10-04T13:30:00+10:00',
      is_all_day: false,
      status: 'confirmed'
    }
  );

  // 3. Tegan's Birthday 2024 and 2026
  calendarEvents.push(
    {
      id: 'cal_tegan_bday_2024',
      source: 'google_calendar',
      sourceEventId: 'primary#tegan_2024',
      title: "Tegan's Birthday",
      start_datetime: '2024-08-30T08:30:00+10:00',
      end_datetime: '2024-08-30T09:30:00+10:00',
      is_all_day: true,
      status: 'confirmed'
    },
    {
      id: 'cal_tegan_bday_2026',
      source: 'google_calendar',
      sourceEventId: 'primary#tegan_2026',
      title: "Tegan's Birthday",
      start_datetime: '2026-08-30T08:30:00+10:00',
      end_datetime: '2026-08-30T09:30:00+10:00',
      is_all_day: true,
      status: 'confirmed'
    }
  );

  // C. Generate List Items (up to requested count) across hundreds of Lists
  const listNames = [
    "Mum's sold items",
    "Camping gear",
    "Bunnings shopping list",
    "Home renovation tasks",
    "10 Melville Place inspection list",
    "Books to read",
    "Gift ideas 2026",
    "Groceries weekly",
    "Car maintenance checklist",
    "Tax deductions 2025-2026"
  ];

  for (let i = 0; i < scale.listItemCount; i++) {
    const listIndex = i % 500; // 500 distinct lists
    const listSubject = listIndex < listNames.length ? listNames[listIndex] : `Project List #${listIndex}`;
    const price = ((i % 100) + 1) * 5; // deterministic prices
    const itemMemoryId = `mem_list_item_${i}`;

    memories.push({
      id: itemMemoryId,
      originalText: `Added item #${i} to ${listSubject}: Price $${price}`,
      createdAt: new Date(anchorTime - ((i % 1000) * msPerDay)).toISOString(),
      interpretation: {
        kind: 'fact',
        subject: listSubject,
        people: [],
        places: [],
        topics: ['lists', listSubject.toLowerCase()],
        retrieval_cues: [listSubject.toLowerCase(), `item ${i}`, `$${price}`],
        content: `Item #${i} in ${listSubject} ($${price})`,
        metadata: { price: price, list_index: listIndex }
      }
    });
  }

  // D. Generate Ordinary Lifetime Memories & Distractors (up to requested count)
  const remainingMemories = Math.max(0, scale.memoryCount - memories.length);
  for (let i = 0; i < remainingMemories; i++) {
    const timeOffset = (i / remainingMemories) * (10 * msPerYear); // spread over past 10 years
    const memTime = new Date(anchorTime - timeOffset);
    const fn = FIRST_NAMES[i % FIRST_NAMES.length];
    const role = ROLES[i % ROLES.length];
    const place = PLACES[i % PLACES.length];
    const topic = TOPICS[i % TOPICS.length];
    const memId = `mem_synth_${i}`;

    memories.push({
      id: memId,
      originalText: `Spoke with ${fn} the ${role} about ${topic} at ${place} on ${memTime.toDateString()}`,
      createdAt: memTime.toISOString(),
      interpretation: {
        kind: 'fact',
        subject: `${fn} ${topic}`,
        people: [fn],
        places: [place],
        topics: [topic, role],
        retrieval_cues: [fn.toLowerCase(), role.toLowerCase(), place.toLowerCase(), topic.toLowerCase()],
        content: `Spoke with ${fn} the ${role} about ${topic} at ${place}`,
        resolved_datetime: memTime.toISOString()
      }
    });
  }

  // E. Explicit Benchmark Anchors
  memories.push(
    {
      id: 'bench_mem_spare_key',
      originalText: 'The spare car key is in the top drawer of the hallway table',
      createdAt: '2026-08-20T10:00:00Z',
      interpretation: {
        kind: 'fact',
        subject: 'spare car key',
        people: [],
        places: ['hallway table', 'top drawer'],
        topics: ['car key', 'keys', 'spare key'],
        retrieval_cues: ['spare', 'car key', 'hallway table', 'drawer', 'top drawer'],
        content: 'The spare car key is in the top drawer of the hallway table'
      }
    },
    {
      id: 'bench_mem_plumber_quote',
      originalText: 'Dave quoted $450 to clean and replace the gutters',
      createdAt: '2026-08-25T14:30:00Z',
      interpretation: {
        kind: 'fact',
        subject: 'gutter quote',
        people: ['Dave'],
        places: ['house', 'gutters'],
        topics: ['plumber', 'gutters', 'repair', 'quote'],
        relationships: [{ person: 'Dave', role: 'plumber' }],
        retrieval_cues: ['dave', 'plumber', 'gutters', 'quote', '$450'],
        content: 'Dave quoted $450 to clean and replace the gutters'
      }
    },
    {
      id: 'bench_mem_bunnings_yesterday',
      originalText: 'Bought 2 bags of compost at Bunnings yesterday afternoon for $24',
      createdAt: '2026-08-29T16:00:00Z',
      interpretation: {
        kind: 'fact',
        subject: 'compost purchase',
        people: [],
        places: ['Bunnings'],
        topics: ['gardening', 'bunnings', 'compost', 'receipt'],
        retrieval_cues: ['bunnings', 'compost', 'yesterday afternoon', '$24'],
        content: 'Bought 2 bags of compost at Bunnings yesterday afternoon for $24'
      }
    },
    {
      id: 'bench_mem_steve_pergola',
      originalText: 'Steve said the council approval for the pergola will take 4 weeks',
      createdAt: '2026-07-15T09:00:00Z',
      interpretation: {
        kind: 'fact',
        subject: 'pergola council approval',
        people: ['Steve'],
        places: ['backyard', 'council'],
        topics: ['pergola', 'renovation', 'council approval', 'steve'],
        retrieval_cues: ['steve', 'pergola', 'council', 'approval', '4 weeks'],
        content: 'Steve said the council approval for the pergola will take 4 weeks'
      }
    },
    {
      id: 'bench_mem_melville_inspection',
      originalText: 'Inspection list for 10 Melville Place: check roof tiles, test solar inverter, measure side gate clearance',
      createdAt: '2026-06-10T11:00:00Z',
      interpretation: {
        kind: 'fact',
        subject: '10 Melville Place inspection list',
        people: [],
        places: ['10 Melville Place'],
        topics: ['real estate', 'inspection', 'roof', 'solar', '10 melville place'],
        retrieval_cues: ['10 melville place', 'inspection list', 'roof tiles', 'solar inverter'],
        content: 'Inspection list for 10 Melville Place: check roof tiles, test solar inverter, measure side gate clearance'
      }
    }
  );

  return {
    memories,
    calendarEvents,
    entities,
    relationships
  };
}

// -----------------------------------------------------------------------------
// 3. BENCHMARK QUERY SUITE (14 REPRESENTATIVE LIFETIME SCENARIOS)
// -----------------------------------------------------------------------------

export const LIFETIME_BENCHMARK_CASES: BenchmarkTestCase[] = [
  {
    id: 'BM_01_EXACT_FACT',
    name: 'Exact Fact Retrieval',
    query: 'Where is the spare car key?',
    category: 'exact_fact',
    expectedSupportingMemoryIds: ['bench_mem_spare_key']
  },
  {
    id: 'BM_02_ENTITY_RELATIONSHIP',
    name: 'Relationship-Aware Retrieval',
    query: 'What did my plumber quote for the gutters?',
    category: 'entity_relationship',
    expectedSupportingMemoryIds: ['bench_mem_plumber_quote']
  },
  {
    id: 'BM_03_HISTORICAL_TEMPORAL',
    name: 'Historical Temporal Memory Retrieval',
    query: 'What did I buy at Bunnings yesterday afternoon?',
    category: 'historical_temporal',
    expectedSupportingMemoryIds: ['bench_mem_bunnings_yesterday']
  },
  {
    id: 'BM_04_EXPLICIT_DOCTOR_COUNT',
    name: 'Doctor Visit Count Last Year (Explicit Benchmark)',
    query: 'How many times did I visit Dr Marning and Dr Naveena last year?',
    category: 'explicit_marning_naveena_count',
    expectedSupportingCalendarIds: [
      'cal_marning_2025_1', 'cal_marning_2025_2', 'cal_marning_2025_3', 'cal_marning_2025_4',
      'cal_naveena_2025_1', 'cal_naveena_2025_2'
    ],
    expectedDeterministicCount: 6 // 4 Marning + 2 Naveena
  },
  {
    id: 'BM_05_DATE_RANGE_CALENDAR',
    name: 'Date-Range Doctor Appointments',
    query: 'What doctors did I see in 2025?',
    category: 'date_range_calendar',
    expectedSupportingCalendarIds: [
      'cal_marning_2025_1', 'cal_marning_2025_2', 'cal_marning_2025_3', 'cal_marning_2025_4',
      'cal_naveena_2025_1', 'cal_naveena_2025_2'
    ]
  },
  {
    id: 'BM_06_LATEST_EARLIEST_EVENT',
    name: 'Latest Visit Retrieval',
    query: 'When did I last see Dr Marning?',
    category: 'latest_earliest_event',
    expectedSupportingCalendarIds: ['cal_marning_2025_4']
  },
  {
    id: 'BM_07_LIST_RETRIEVAL',
    name: 'Specific Subject / List Retrieval',
    query: "What was on the inspection list for 10 Melville Place?",
    category: 'subject_retrieval',
    expectedSupportingMemoryIds: ['bench_mem_melville_inspection']
  },
  {
    id: 'BM_08_LARGE_LIST_COUNT_SUM',
    name: 'Large List SUM / Calculation',
    query: "How much did I sell Mum's things for?",
    category: 'large_list_count_sum',
    expectedDeterministicSum: 360
  },
  {
    id: 'BM_09_CROSS_SOURCE',
    name: 'Cross-Source (Person + Subject + Quote)',
    query: 'What did Steve say about the pergola?',
    category: 'cross_source_calendar_memory_rel',
    expectedSupportingMemoryIds: ['bench_mem_steve_pergola']
  },
  {
    id: 'BM_10_UPCOMING_BIRTHDAYS',
    name: 'Upcoming Birthday / Recurrence Query',
    query: "Whose birthdays are coming up next month?",
    category: 'upcoming_birthday_anniversary'
  },
  {
    id: 'BM_11_MULTI_YEAR_BIRTHDAY_RECURRENCE',
    name: 'Multi-Year Birthday Day-of-Week Calculation',
    query: "What day of the week was Tegan's birthday in 2024 and what day will it be in 2028?",
    category: 'upcoming_birthday_anniversary',
    expectedSupportingCalendarIds: ['cal_tegan_bday_2024', 'cal_tegan_bday_2026']
  },
  {
    id: 'BM_12_FUZZY_CONCEPTUAL',
    name: 'Fuzzy Annual Retrospective',
    query: 'What was I doing around this time last year?',
    category: 'fuzzy_conceptual'
  },
  {
    id: 'BM_13_TRUE_OUT_OF_SCOPE',
    name: 'True Out-of-Scope Query',
    query: 'Who is the President of France?',
    category: 'true_out_of_scope',
    expectedOutOfScope: true
  }
];

// -----------------------------------------------------------------------------
// 4. BENCHMARK EXECUTION & PROFILING HARNESS
// -----------------------------------------------------------------------------

const LOCAL_CONTEXT: LocalContextInfo = {
  language: 'en-AU',
  region: 'AU',
  timeZone: 'Australia/Sydney',
  localDateTimeStr: 'Sunday 30 August 2026, 12:00 pm',
  weekday: 'Sunday',
  referenceDate: new Date('2026-08-30T12:00:00+10:00'),
  offsetStr: '+10:00',
  utcIso: '2026-08-30T02:00:00.000Z'
};

export async function profileCurrentDcrAtScale(scaleConfig: {
  scaleLabel: string;
  memoryCount: number;
  listItemCount: number;
  calendarEventCount: number;
  entityCount: number;
}) {
  console.log(`\n================================================================================`);
  console.log(`  PROFILING CURRENT DCR ARCHITECTURE: ${scaleConfig.scaleLabel}`);
  console.log(`  - Memories: ${scaleConfig.memoryCount.toLocaleString()}`);
  console.log(`  - List Items: ${scaleConfig.listItemCount.toLocaleString()}`);
  console.log(`  - Calendar Events: ${scaleConfig.calendarEventCount.toLocaleString()}`);
  console.log(`  - Entities / Contacts: ${scaleConfig.entityCount.toLocaleString()}`);
  console.log(`================================================================================`);

  // Generate synthetic dataset in RAM
  const genStart = performance.now();
  const dataset = generateSyntheticLifetimeDataset(scaleConfig);
  const genDuration = performance.now() - genStart;
  console.log(`  [Data Gen] Created synthetic dataset in ${Math.round(genDuration)} ms (Heap resident).`);

  const results: Array<{ testId: string; name: string; latencyMs: number; candidateMemories: number; candidateCal: number; tokensApprox: number }> = [];

  for (const tc of LIFETIME_BENCHMARK_CASES) {
    const t0 = performance.now();

    // Call current buildDynamicRetrievalContext
    const dcrResult = buildDynamicRetrievalContext(
      tc.query,
      dataset.memories,
      dataset.calendarEvents,
      dataset.relationships,
      LOCAL_CONTEXT
    );
    const latencyMs = performance.now() - t0;

    // Approximate token estimation of candidates
    const rawContextText = JSON.stringify({
      memories: dcrResult.candidateMemories.map(m => m.interpretation?.content || m.originalText),
      calendar: dcrResult.candidateCalendarEvents.map(c => `${c.title} on ${c.start_datetime}`)
    });
    const approxTokens = Math.round(rawContextText.length / 4);

    results.push({
      testId: tc.id,
      name: tc.name,
      latencyMs,
      candidateMemories: dcrResult.candidateMemories.length,
      candidateCal: dcrResult.candidateCalendarEvents.length,
      tokensApprox: approxTokens
    });
  }

  const avgLatency = results.reduce((a, b) => a + b.latencyMs, 0) / results.length;
  const maxLatency = Math.max(...results.map(r => r.latencyMs));
  const avgTokens = results.reduce((a, b) => a + b.tokensApprox, 0) / results.length;

  console.log(`\n  --- Summary for ${scaleConfig.scaleLabel} ---`);
  console.log(`  Average DCR Latency: ${avgLatency.toFixed(2)} ms`);
  console.log(`  Max DCR Latency:     ${maxLatency.toFixed(2)} ms`);
  console.log(`  Average Sent Tokens: ${Math.round(avgTokens)} tokens`);

  return {
    scaleLabel: scaleConfig.scaleLabel,
    totalRecords: dataset.memories.length + dataset.calendarEvents.length,
    avgLatencyMs: avgLatency,
    maxLatencyMs: maxLatency,
    avgTokens: avgTokens,
    itemBreakdown: results
  };
}

// -----------------------------------------------------------------------------
// 5. MAIN BENCHMARK RUNNER
// -----------------------------------------------------------------------------

async function runLifetimeScaleBenchmark() {
  console.log('################################################################################');
  console.log('  EZZYMIGO LIFETIME KNOWLEDGE ENGINE — STAGE 1: SCALE BENCHMARK & CONTRACT');
  console.log('  Testing DCR v1 limits across progressive scale tiers without DB mutation.');
  console.log('################################################################################');

  const tiers = [
    { scaleLabel: 'Beta Tier (Baseline)', memoryCount: 200, listItemCount: 100, calendarEventCount: 50, entityCount: 30 },
    { scaleLabel: '1,000 Memories Scale', memoryCount: 1000, listItemCount: 500, calendarEventCount: 300, entityCount: 100 },
    { scaleLabel: '5,000 Memories Scale', memoryCount: 5000, listItemCount: 2500, calendarEventCount: 1500, entityCount: 500 },
    { scaleLabel: '10,000 Memories Scale', memoryCount: 10000, listItemCount: 5000, calendarEventCount: 3000, entityCount: 1000 },
    { scaleLabel: '25,000 Memories Scale', memoryCount: 25000, listItemCount: 12500, calendarEventCount: 7500, entityCount: 2500 },
    { scaleLabel: '50,000 Memories Scale', memoryCount: 50000, listItemCount: 25000, calendarEventCount: 15000, entityCount: 5000 },
    { scaleLabel: '100,000 Memories (Full Lifetime Scale)', memoryCount: 100000, listItemCount: 50000, calendarEventCount: 25000, entityCount: 5000 }
  ];

  const scaleReports: any[] = [];

  for (const tier of tiers) {
    const report = await profileCurrentDcrAtScale(tier);
    scaleReports.push(report);
  }

  console.log('\n================================================================================');
  console.log('  SCALING COMPARISON MATRIX: DCR v1 IN-MEMORY ARCHITECTURE');
  console.log('================================================================================');
  console.log('| Scale Tier | Total Records | Avg Latency (ms) | Max Latency (ms) | Scaling Factor | Degradation Status |');
  console.log('|---|---|---|---|---|---|');

  const baseLatency = scaleReports[0].avgLatencyMs;
  for (const rep of scaleReports) {
    const factor = (rep.avgLatencyMs / baseLatency).toFixed(1);
    let status = 'HEALTHY';
    if (rep.avgLatencyMs > 50) status = 'NOTICEABLE DELAY';
    if (rep.avgLatencyMs > 200) status = 'UNACCEPTABLE LATENCY';
    if (rep.avgLatencyMs > 600) status = 'CRITICAL BREAKPOINT / EVENT LOOP BLOCK';

    console.log(`| ${rep.scaleLabel.padEnd(35)} | ${String(rep.totalRecords).padStart(12)} | ${rep.avgLatencyMs.toFixed(2).padStart(14)} ms | ${rep.maxLatencyMs.toFixed(2).padStart(14)} ms | ${(factor + 'x').padStart(14)} | ${status} |`);
  }

  console.log('\n================================================================================');
  console.log('  STAGE 1 BENCHMARK PROFILE COMPLETE');
  console.log('================================================================================');
}

runLifetimeScaleBenchmark().catch(err => {
  console.error('Benchmark execution error:', err);
  process.exit(1);
});

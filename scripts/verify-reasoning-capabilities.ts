/**
 * Verification Test Suite: Unified Reasoning Loop & Capabilities Extension
 *
 * CRITICAL SAFETY INVARIANTS:
 * 1. Uses isolated disposable tenant ID (test_tenant_caps_verifier_*).
 * 2. Production Data Guard strictly blocks any writes to ezzy_default or default_user.
 * 3. Verifies all 15 scenarios covering the 7-step lifecycle, location hierarchy,
 *    safety boundaries (no bookings/calls), and restraint on mundane tasks.
 */
import { GoogleGenAI } from '@google/genai';
import { executeNewEzzyReasoningLoop } from '../server/reasoning/loop';
import { executeCapability, PROHIBITED_CAPABILITIES } from '../server/capabilities/registry';
import { resolveLocationHierarchy } from '../server/capabilities/location';
import { EzzyWorldSnapshot } from '../server/snapshot/types';
import { executeBunnySql } from '../server/db/client';

// Enable capabilities strictly within this isolated test process
process.env.ENABLE_EZZY_CAPABILITIES = 'true';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('FATAL: GEMINI_API_KEY is not set');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });
const isolatedEzzyId = `test_tenant_caps_verifier_${Date.now()}`;

function createBaseSnapshot(overrides: Partial<EzzyWorldSnapshot> = {}): EzzyWorldSnapshot {
  return {
    ezzyId: isolatedEzzyId,
    opportunity: 'PRE_EVENT',
    trigger: 'upcoming_event_anticipation',
    civilTime: {
      iso: '2026-09-17T10:00:00+10:00',
      timeZone: 'Australia/Sydney',
      dateYMD: '2026-09-17',
      timeStr: '10:00 am',
      dayOfWeek: 'Thursday',
      timePhase: 'morning',
    },
    calendar: {
      todayEvents: [],
      recentlyCompletedEvents: [],
      upcomingEvents: [],
      tomorrowMorningEvents: [],
    },
    commitments: {
      todayDatedMemories: [],
      tomorrowMorningDatedMemories: [],
      dueOrOverdueReminders: [],
    },
    timedReminders: [],
    activeMemories: [
      {
        id: 'mem_home_loc',
        originalText: 'Paul lives in Canberra, ACT with his wife Barb',
        content: 'Paul lives in Canberra, ACT with his wife Barb',
        kind: 'fact',
        status: 'active',
        isDone: false,
        createdAt: '2026-09-01T10:00:00Z',
        people: ['Barb'],
        places: ['Canberra'],
        topics: ['residence'],
      },
    ],
    recentCompletedOrHistoricalMemories: [],
    relationships: [
      { person: 'Mum', role: 'mother' },
      { person: 'Barb', role: 'wife' },
      { person: 'Doug', role: 'brother' },
    ],
    occasions: [],
    recentInteractions: [],
    ...overrides,
  };
}

async function runScenario(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n--- [Scenario] ${name} ... `);
  try {
    const t0 = Date.now();
    await fn();
    const duration = Date.now() - t0;
    console.log(`PASSED (${duration}ms)`);
    return true;
  } catch (err: any) {
    console.log(`FAILED\nError: ${err.message}\n${err.stack}`);
    return false;
  }
}

async function main() {
  console.log(`=======================================================`);
  console.log(`  Unified Reasoning Loop & Capabilities Verification`);
  console.log(`  Isolated Tenant ID: ${isolatedEzzyId}`);
  console.log(`=======================================================`);

  let passCount = 0;
  const total = 15;

  // Scenario 1: Mum's 90th Birthday (Positive Capability Flow)
  if (
    await runScenario("1. Mum's 90th Birthday - User requests wheelchair-accessible lunch venue near Deakin", async () => {
      const snapshot = createBaseSnapshot({
        calendar: {
          todayEvents: [],
          recentlyCompletedEvents: [],
          upcomingEvents: [
            {
              id: 'cal_mum_90',
              title: "Mum's 90th Birthday",
              startDatetime: '2026-09-19T12:00:00+10:00',
              endDatetime: '2026-09-19T15:00:00+10:00',
              isAllDay: false,
              location: 'Canberra',
              hoursUntilStart: 50,
            },
          ],
          tomorrowMorningEvents: [],
        },
      });

      // User responds to initial check-in asking for research
      const result = await executeNewEzzyReasoningLoop(
        'PRE_EVENT',
        snapshot,
        {
          input: 'Yes please, can you find a good Italian or contemporary restaurant near Deakin with easy wheelchair access for about 8 people?',
          targetEventId: 'cal_mum_90',
        },
        ai
      );

      const dec = result.decision;
      if (dec.communication.mode !== 'USE_CAPABILITY' && dec.communication.mode !== 'COMMUNICATE') {
        throw new Error(`Expected mode USE_CAPABILITY or COMMUNICATE with results, got ${dec.communication.mode}`);
      }
      if (!dec.capabilityResult && !dec.capabilityRequest) {
        throw new Error(`Expected capabilityRequest or capabilityResult to be present`);
      }
      if (dec.capabilityResult) {
        if (!dec.capabilityResult.success) {
          throw new Error(`Capability execution failed: ${dec.capabilityResult.rawError}`);
        }
        if (!Array.isArray(dec.capabilityResult.places) || dec.capabilityResult.places.length === 0) {
          throw new Error(`Expected normalized places in Deakin/Canberra, got empty list`);
        }
        console.log(`\n      Found ${dec.capabilityResult.places.length} places in ${dec.capabilityResult.locationUsed}`);
        console.log(`      First place: ${dec.capabilityResult.places[0].name} (${dec.capabilityResult.places[0].address})`);
      }
    })
  ) passCount++;

  // Scenario 2: Medical Specialist Appointment (Logistics / Parking Flow)
  if (
    await runScenario('2. Medical Specialist Appointment - Logistics & parking research near Canberra Hospital', async () => {
      const snapshot = createBaseSnapshot({
        calendar: {
          todayEvents: [
            {
              id: 'cal_doc_marning',
              title: 'Appointment with Dr Marning (Cardiology)',
              startDatetime: '2026-09-17T14:30:00+10:00',
              endDatetime: '2026-09-17T15:30:00+10:00',
              isAllDay: false,
              location: 'Canberra Hospital, Garran',
              hoursUntilStart: 4.5,
            },
          ],
          recentlyCompletedEvents: [],
          upcomingEvents: [],
          tomorrowMorningEvents: [],
        },
      });

      const result = await executeNewEzzyReasoningLoop(
        'PRE_EVENT',
        snapshot,
        {
          input: 'Could you look up where the best visitor parking or drop-off zone is near building 1 at Canberra Hospital?',
          targetEventId: 'cal_doc_marning',
        },
        ai
      );

      const dec = result.decision;
      if (!dec.capabilityResult && !dec.capabilityRequest) {
        throw new Error(`Expected capabilityRequest or capabilityResult for hospital parking`);
      }
      if (dec.capabilityResult && dec.capabilityResult.places.length > 0) {
        console.log(`\n      Resolved parking/facility: ${dec.capabilityResult.places[0].name} (${dec.capabilityResult.places[0].address})`);
      }
    })
  ) passCount++;

  // Scenario 3: Wedding Anniversary Dinner (Celebration Research Flow)
  if (
    await runScenario('3. Wedding Anniversary Dinner - Quiet romantic French or Italian dinner in Kingston', async () => {
      const snapshot = createBaseSnapshot({
        occasions: [
          {
            id: 'occ_anniversary',
            name: 'Wedding Anniversary',
            targetYMD: '2026-09-22',
            daysUntil: 5,
            temporalDescription: 'in 5 days',
            isToday: false,
          },
        ],
      });

      const result = await executeNewEzzyReasoningLoop(
        'TODAY_ORIENT',
        snapshot,
        {
          input: "We'd love to find a quiet, intimate Italian or French dinner spot in Kingston for our anniversary.",
        },
        ai
      );

      const dec = result.decision;
      if (dec.capabilityResult && dec.capabilityResult.places.length > 0) {
        console.log(`\n      Resolved romantic venue: ${dec.capabilityResult.places[0].name} (${dec.capabilityResult.places[0].address})`);
      }
    })
  ) passCount++;

  // Scenario 4: Already Sorted Event (Negative Control - Restraint)
  if (
    await runScenario('4. Negative Control - Event already sorted by brother Doug -> Stays SILENT or informative notice', async () => {
      const snapshot = createBaseSnapshot({
        calendar: {
          todayEvents: [],
          recentlyCompletedEvents: [],
          upcomingEvents: [
            {
              id: 'cal_mum_lunch',
              title: "Mum's 90th Birthday Lunch",
              startDatetime: '2026-09-19T12:00:00+10:00',
              endDatetime: '2026-09-19T15:00:00+10:00',
              isAllDay: false,
              hoursUntilStart: 50,
            },
          ],
          tomorrowMorningEvents: [],
        },
        activeMemories: [
          {
            id: 'mem_already_booked',
            originalText: "Doug called to say he already booked the private dining room at Agostinis for Mum's 90th lunch at 12:30pm on Saturday.",
            content: "Doug already booked private dining room at Agostinis for Mum's 90th birthday lunch on Saturday.",
            kind: 'fact',
            status: 'active',
            isDone: false,
            createdAt: '2026-09-16T14:00:00Z',
            people: ['Doug', 'Mum'],
            places: ['Agostinis'],
            topics: ['birthday', 'reservation'],
          },
        ],
      });

      const result = await executeNewEzzyReasoningLoop(
        'PRE_EVENT',
        snapshot,
        {
          trigger: 'pre_event_anticipation',
          targetEventId: 'cal_mum_lunch',
        },
        ai
      );

      const dec = result.decision;
      // Because Doug already booked it, Ezzy should NOT invoke search_places capability!
      if (dec.communication.mode === 'USE_CAPABILITY' || dec.capabilityRequest) {
        throw new Error(`Restraint violation: Ezzy invoked capability search even though venue was already booked by Doug!`);
      }
      console.log(`\n      Honored restraint: mode=${dec.communication.mode}, rationale="${dec.rationale.slice(0, 80)}..."`);
    })
  ) passCount++;

  // Scenario 5: User Declines Assistance (Conversational Satisfaction)
  if (
    await runScenario("5. User Declines Assistance - 'No thank you, all sorted' -> Ezzy acknowledges, no capability invoked", async () => {
      const snapshot = createBaseSnapshot({
        recentInteractions: [
          {
            type: 'today_action',
            summary: "Prompted about Mum's upcoming birthday arrangements",
            timestamp: '2026-09-17T09:30:00+10:00',
          },
        ],
      });

      const result = await executeNewEzzyReasoningLoop(
        'PRE_EVENT',
        snapshot,
        {
          input: "No thank you, we're all sorted and having lunch at home.",
        },
        ai
      );

      const dec = result.decision;
      if (dec.communication.mode === 'USE_CAPABILITY' || dec.capabilityRequest) {
        throw new Error(`Capability invoked despite user declining assistance`);
      }
      console.log(`\n      Respected user decline: mode=${dec.communication.mode}`);
    })
  ) passCount++;

  // Scenario 6: Car Scheduled Service (Logistical Support)
  if (
    await runScenario('6. Car Scheduled Service - User asks for quiet cafe with Wi-Fi near Phillip', async () => {
      const snapshot = createBaseSnapshot();
      const result = await executeCapability({
        ezzyId: isolatedEzzyId,
        capability: 'search_places',
        parameters: {
          query: 'cafe with Wi-Fi and power outlets to work from',
          location: 'Phillip, ACT',
          criteria: ['quiet', 'Wi-Fi', 'coffee'],
          limit: 2,
        },
      });

      if (!result.success || result.data.places.length === 0) {
        throw new Error(`Failed to search cafes near Phillip`);
      }
      console.log(`\n      Found cafe in Phillip: ${result.data.places[0].name} (${result.data.places[0].address})`);
    })
  ) passCount++;

  // Scenario 7: Friend Visiting From Interstate (Local Orientation)
  if (
    await runScenario('7. Friend Visiting From Interstate - Outdoor coffee spots in New Acton', async () => {
      const result = await executeCapability({
        ezzyId: isolatedEzzyId,
        capability: 'search_places',
        parameters: {
          query: 'specialty coffee spots with outdoor seating',
          location: 'New Acton, Canberra',
          criteria: ['outdoor seating', 'great coffee'],
          limit: 2,
        },
      });

      if (!result.success || result.data.places.length === 0) {
        throw new Error(`Failed to search coffee spots in New Acton`);
      }
      console.log(`\n      Found spot in New Acton: ${result.data.places[0].name}`);
    })
  ) passCount++;

  // Scenario 8: Child Dental Checkup (Informational / Restraint)
  if (
    await runScenario("8. Routine Child Dental Checkup - User says 'all good, just remind him' -> No capability invoked", async () => {
      const snapshot = createBaseSnapshot();
      const result = await executeNewEzzyReasoningLoop(
        'INBOUND_TELL',
        snapshot,
        {
          input: "Leo has a dentist checkup tomorrow at 4pm. All good, just remind him to bring his mouthguard.",
        },
        ai
      );

      const dec = result.decision;
      if (dec.communication.mode === 'USE_CAPABILITY' || dec.capabilityRequest) {
        throw new Error(`Capability invoked for routine dental checkup reminder`);
      }
      console.log(`\n      Clean reminder capture: proposedMutations=${dec.proposedMutations.length}, mode=${dec.communication.mode}`);
    })
  ) passCount++;

  // Scenario 9: Colleague Retirement Dinner (Group / Private Dining)
  if (
    await runScenario('9. Colleague Retirement Dinner - Private dining room for 15 in Barton', async () => {
      const result = await executeCapability({
        ezzyId: isolatedEzzyId,
        capability: 'search_places',
        parameters: {
          query: 'restaurant with private dining room for 15 people',
          location: 'Barton, ACT',
          criteria: ['private dining room', 'group of 15', 'dinner'],
          limit: 2,
        },
      });

      if (!result.success || result.data.places.length === 0) {
        throw new Error(`Failed to search private dining venues in Barton`);
      }
      console.log(`\n      Found Barton venue: ${result.data.places[0].name} (${result.data.places[0].address})`);
    })
  ) passCount++;

  // Scenario 10: Mundane Grocery Errand (Negative Control - Anti-Spam)
  if (
    await runScenario("10. Mundane Grocery Errand - 'Buy milk and eggs' -> Zero unsolicited capability calls", async () => {
      const snapshot = createBaseSnapshot();
      const result = await executeNewEzzyReasoningLoop(
        'INBOUND_TELL',
        snapshot,
        {
          input: 'Need to buy milk and eggs at Woolies on the way home.',
        },
        ai
      );

      const dec = result.decision;
      if (dec.communication.mode === 'USE_CAPABILITY' || dec.capabilityRequest) {
        throw new Error(`Capability invoked for mundane grocery chore!`);
      }
      console.log(`\n      Clean task handling without spam: mode=${dec.communication.mode}`);
    })
  ) passCount++;

  // Scenario 11: Ambiguous Location Scenario (Privacy Hierarchy)
  if (
    await runScenario('11. Privacy Hierarchy - Ambiguous location resolves safely without silent GPS acquisition', async () => {
      const resolved = resolveLocationHierarchy({
        explicitLocation: null,
        userMemories: [
          { content: 'Paul lives in Canberra, ACT' },
        ],
        clientRegion: 'AU-ACT',
        clientTimeZone: 'Australia/Sydney',
      });

      if (resolved.source !== 'user_home' && resolved.source !== 'locality') {
        throw new Error(`Expected source user_home or locality, got ${resolved.source}`);
      }
      if (!resolved.location.toLowerCase().includes('canberra')) {
        throw new Error(`Expected Canberra, got ${resolved.location}`);
      }
      console.log(`\n      Resolved privacy-safe location: "${resolved.location}" via source="${resolved.source}"`);
    })
  ) passCount++;

  // Scenario 12: Explicit Location Override
  if (
    await runScenario('12. Privacy Hierarchy - Explicit location in event/query overrides user home location', async () => {
      const resolved = resolveLocationHierarchy({
        explicitLocation: 'Melbourne CBD',
        userMemories: [
          { content: 'Paul lives in Canberra, ACT' },
        ],
      });

      if (resolved.source !== 'explicit' || resolved.location !== 'Melbourne CBD') {
        throw new Error(`Expected explicit Melbourne CBD, got ${resolved.source}: ${resolved.location}`);
      }
      console.log(`\n      Correctly honored explicit override: "${resolved.location}"`);
    })
  ) passCount++;

  // Scenario 13: Safety Invariant (Prohibited Booking Rejection)
  if (
    await runScenario('13. Safety Invariant - Execution of make_booking is strictly blocked', async () => {
      let threw = false;
      try {
        await executeCapability({
          ezzyId: isolatedEzzyId,
          capability: 'make_booking' as any,
          parameters: { venue: 'Agostinis', partySize: 4 },
        });
      } catch (err: any) {
        threw = true;
        if (!err.message.includes('prohibited') && !err.message.includes('not an approved capability')) {
          throw new Error(`Unexpected error message: ${err.message}`);
        }
        console.log(`\n      Safety guard blocked unauthorized action: "${err.message}"`);
      }

      if (!threw) {
        throw new Error(`Failed to block prohibited capability make_booking!`);
      }
    })
  ) passCount++;

  // Scenario 14: Follow-Through / Post-Event Check-in
  if (
    await runScenario("14. Follow-Through - Post-event follow-up evaluates outcome without re-triggering place search", async () => {
      const snapshot = createBaseSnapshot({
        opportunity: 'POST_EVENT',
        calendar: {
          todayEvents: [],
          recentlyCompletedEvents: [
            {
              id: 'cal_mum_concluded',
              title: "Mum's 90th Birthday Lunch",
              startDatetime: '2026-09-17T12:00:00+10:00',
              endDatetime: '2026-09-17T15:00:00+10:00',
              isAllDay: false,
              hoursSinceEnd: 1.5,
            },
          ],
          upcomingEvents: [],
          tomorrowMorningEvents: [],
        },
      });

      const result = await executeNewEzzyReasoningLoop(
        'POST_EVENT',
        snapshot,
        {
          trigger: 'post_event_follow_up',
          targetEventId: 'cal_mum_concluded',
        },
        ai
      );

      const dec = result.decision;
      if (dec.communication.mode === 'USE_CAPABILITY' || dec.capabilityRequest) {
        throw new Error(`Post-event follow-up inappropriately triggered capability search`);
      }
      console.log(`\n      Follow-through outcome: mode=${dec.communication.mode}, question="${dec.communication.question || dec.communication.body}"`);
    })
  ) passCount++;

  // Scenario 15: Multi-Tenant Data Isolation Guard
  if (
    await runScenario('15. Multi-Tenant & Production Data Guard - Zero pollution to ezzy_default', async () => {
      const res = await executeBunnySql([
        { sql: `SELECT COUNT(*) as cnt FROM memories WHERE ezzy_id = 'ezzy_default';` },
      ]);
      const count = Number(res[0]?.rows?.[0]?.cnt ?? 0);
      if (count !== 43) {
        throw new Error(`Data guard violated! Expected genuine memory count 43 in ezzy_default, found ${count}`);
      }
      console.log(`\n      Verified ezzy_default pristine: genuine memory count remains exactly 43`);
    })
  ) passCount++;

  console.log(`\n=======================================================`);
  console.log(`  Verification Results: ${passCount} / ${total} Scenarios Passed`);
  console.log(`=======================================================`);

  if (passCount === total) {
    console.log(`\nALL 15 SCENARIOS PASSED WITH ZERO PRODUCTION POLLUTION!`);
    process.exit(0);
  } else {
    console.error(`\nFAILED: ${total - passCount} scenarios did not pass.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error in test suite:', err);
  process.exit(1);
});

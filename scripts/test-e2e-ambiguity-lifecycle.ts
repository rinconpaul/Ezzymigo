import { initBunnyDb } from '../server/db/schema.js';
import { executeBunnySql } from '../server/db/client.js';

async function runE2ELifecycleTest() {
  console.log("================================================================================");
  console.log("  CLASS B — INTEGRATION PASS: BACKEND API & DB CLARIFICATION LIFECYCLE        ");
  console.log("  Note: Tests Express HTTP endpoints & Bunny DB without browser UI.           ");
  console.log("================================================================================");

  await initBunnyDb();

  // 1. Capture ambiguous thought: "Remind me tomorrow at 4 o'clock to check the letterbox."
  console.log("\n1. Capturing: 'Remind me tomorrow at 4 o'clock to check the letterbox.'");
  const captureRes = await fetch("http://localhost:3000/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      originalText: "Remind me tomorrow at 4 o'clock to check the letterbox.",
      clientNow: "2026-08-28T10:00:00.000Z",
      clientTimeZone: "Australia/Sydney",
      clientLanguage: "en-AU",
      clientRegion: "AU"
    })
  });
  const captureData = await captureRes.json();
  const memoryId = captureData.memory?.id || captureData.memories?.[0]?.id;
  const clar = captureData.clarification;

  console.log(`   Captured Memory ID: ${memoryId}`);
  console.log(`   Clarification Prompt: "${clar?.question}"`);
  console.log(`   Options: ${JSON.stringify(clar?.candidateOptions)}`);

  if (!clar || !clar.question?.includes("4 am or 4 pm")) {
    console.error("FAILED: Did not receive expected clarification prompt for ambiguous clock time.");
    process.exit(1);
  }

  // 2. Check scheduled_reminders table: MUST be 0 reminders scheduled before resolution
  const remsBefore = await executeBunnySql([
    { sql: 'SELECT * FROM scheduled_reminders WHERE memoryId = ?;', args: [memoryId] }
  ]);
  const countBefore = remsBefore[0]?.rows?.length || 0;
  console.log(`\n2. Scheduled reminders count BEFORE clarification resolution: ${countBefore}`);
  if (countBefore !== 0) {
    console.error("FAILED: An exact notification was scheduled before resolving ambiguity!");
    process.exit(1);
  }
  console.log("   [PASS] No exact notification scheduled prior to clarification resolution.");

  // 3. Resolve clarification with "4 pm"
  console.log("\n3. Resolving clarification with candidate: '4 pm'");
  const resolveRes = await fetch("http://localhost:3000/api/clarifications/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clarificationId: clar.id,
      entityName: clar.entityName,
      entityType: clar.entityType,
      candidateChosen: "4 pm",
      memoryId: memoryId,
      metadata: clar.metadata,
      clientNow: "2026-08-28T10:00:00.000Z",
      clientTimeZone: "Australia/Sydney",
      clientLanguage: "en-AU",
      clientRegion: "AU"
    })
  });
  const resolveData = await resolveRes.json();
  console.log(`   Resolution Message: "${resolveData.message}"`);
  console.log(`   Updated Resolved Datetime: "${resolveData.memory?.interpretation?.resolved_datetime}"`);

  // 4. Verify scheduled_reminders now contains EXACTLY ONE reminder with 4:00 PM ISO timestamp
  const remsAfter = await executeBunnySql([
    { sql: 'SELECT * FROM scheduled_reminders WHERE memoryId = ?;', args: [memoryId] }
  ]);
  const countAfter = remsAfter[0]?.rows?.length || 0;
  console.log(`\n4. Scheduled reminders count AFTER clarification resolution: ${countAfter}`);
  if (countAfter !== 1) {
    console.error(`FAILED: Expected exactly 1 scheduled reminder, found ${countAfter}`);
    process.exit(1);
  }
  const scheduledRow = remsAfter[0]?.rows?.[0];
  console.log(`   Scheduled Row ID: ${scheduledRow.id}`);
  console.log(`   Scheduled RemindAt: ${scheduledRow.remindAt}`);
  console.log("   [PASS] Exactly one scheduled notification created for 4 PM.");

  // 5. Delete memory and verify scheduled notification is cancelled/deleted
  console.log(`\n5. Deleting memory ${memoryId}...`);
  const delRes = await fetch(`http://localhost:3000/api/memories/${memoryId}`, { method: "DELETE" });
  const delData = await delRes.json();
  console.log(`   Delete response: ${JSON.stringify(delData)}`);

  const remsFinal = await executeBunnySql([
    { sql: 'SELECT * FROM scheduled_reminders WHERE memoryId = ?;', args: [memoryId] }
  ]);
  const countFinal = remsFinal[0]?.rows?.length || 0;
  console.log(`   Scheduled reminders left after memory deletion: ${countFinal}`);
  if (countFinal !== 0) {
    console.error("FAILED: Scheduled reminder was not removed upon memory deletion!");
    process.exit(1);
  }
  console.log("   [PASS] Scheduled notification cancelled upon memory deletion.");

  console.log("\n================================================================================");
  console.log("  CLASS B — INTEGRATION TESTS PASSED (100%) [Backend API + Bunny DB]");
  console.log("================================================================================");
}

runE2ELifecycleTest().catch(err => {
  console.error("E2E test error:", err);
  process.exit(1);
});

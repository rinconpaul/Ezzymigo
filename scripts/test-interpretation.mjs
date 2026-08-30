/**
 * Ezzymigo Non-Persisting Test Suite
 * Executes the full production splitter, classifier, temporal, and prerequisite pipeline
 * without writing any test records to the persistent memories table.
 */
async function runRegressionSuite() {
  console.log("================================================================================");
  console.log("  EZZYMIGO NON-PERSISTING TEST REGRESSION SUITE & MEMORY ROW COUNT VERIFICATION");
  console.log("================================================================================");

  // 1. Check persistent memory count before tests
  const beforeRes = await fetch("http://localhost:3000/api/memories");
  const beforeData = await beforeRes.json();
  const countBefore = (beforeData.memories || []).length;
  console.log(`\n>>> Memory count BEFORE tests = ${countBefore} rows`);

  // 2. Test cases covering classification, splitting, temporal resolution, prerequisites, relationships
  const testCases = [
    {
      name: "Single unit reminder ('Buy milk.')",
      input: "Buy milk.",
      expectedUnits: 1,
      validate: (m) => m.interpretation.kind === "reminder" && m.interpretation.intent === "purchase"
    },
    {
      name: "Compound 3-way split ('Get milk tomorrow, ring Peter at 3pm, and book the dentist.')",
      input: "Get milk tomorrow, ring Peter at 3pm, and book the dentist.",
      expectedUnits: 3,
      validate: (m, all) => all.length === 3 && all.some(u => u.interpretation.content.toLowerCase().includes("milk")) && all.some(u => u.interpretation.content.toLowerCase().includes("peter"))
    },
    {
      name: "Split with temporal anchoring ('Buy flowers for Barb. Also remind me to ring Peter Saturday.')",
      input: "Buy flowers for Barb. Also remind me to ring Peter Saturday.",
      expectedUnits: 2,
      validate: (m, all) => all.length === 2 && all.some(u => u.interpretation.resolved_datetime !== null)
    },
    {
      name: "Prerequisite dependency blocker ('I need to paint the back fence, but I can't do it until Steve repairs the broken gate on Monday.')",
      input: "I need to paint the back fence, but I can't do it until Steve repairs the broken gate on Monday.",
      expectedUnits: 1,
      validate: (m) => {
        const p = m.interpretation.prerequisite;
        return p && p.condition && p.status === "pending" && p.expected_time_expression === "Monday" && m.interpretation.resolved_datetime === null;
      }
    },
    {
      name: "Temporal action following prerequisite ('After Steve repairs the gate on Monday, paint the fence on Tuesday.')",
      input: "After Steve repairs the gate on Monday, paint the fence on Tuesday.",
      expectedUnits: 1,
      validate: (m) => m.interpretation.resolved_datetime !== null && m.interpretation.resolved_datetime.includes("2026-09-01")
    },
    {
      name: "Conditional prerequisite event ('Call Peter when the quote arrives.')",
      input: "Call Peter when the quote arrives.",
      expectedUnits: 1,
      validate: (m) => {
        const p = m.interpretation.prerequisite;
        return p && p.condition && p.status === "pending" && m.interpretation.resolved_datetime === null;
      }
    },
    {
      name: "Recurring intention ('Visit Mum every Monday from 9am to 11am.')",
      input: "Visit Mum every Monday from 9am to 11am.",
      expectedUnits: 1,
      validate: (m) => m.interpretation.resurfacing?.mode === "date_based" && m.interpretation.resolved_datetime !== null
    },
    {
      name: "Same subject metadata & cue attachment ('Water damage on ceiling in master bedroom' with subject '10 Melville Place')",
      input: "Water damage on ceiling in master bedroom",
      subject: "10 Melville Place",
      expectedUnits: 1,
      validate: (m) => {
        const hasSubjectMeta = m.interpretation?.subject === "10 Melville Place";
        const hasSubjectCue = Array.isArray(m.interpretation?.retrieval_cues) && m.interpretation.retrieval_cues.includes("10 Melville Place");
        const originalTextUnaltered = m.originalText === "Water damage on ceiling in master bedroom";
        return hasSubjectMeta && hasSubjectCue && originalTextUnaltered;
      }
    }
  ];

  console.log(`\nExecuting ${testCases.length} test cases through POST /api/memories/test-interpret...`);

  let allPassed = true;
  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const startTime = Date.now();
    const res = await fetch("http://localhost:3000/api/memories/test-interpret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalText: tc.input,
        subject: tc.subject,
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const duration = Date.now() - startTime;
    const data = await res.json();
    
    const passedUnits = data.memories && data.memories.length === tc.expectedUnits;
    const passedValidation = data.memories && tc.validate(data.memories[0], data.memories);
    const passedPersistedFlag = data.persisted === false;
    const isSuccess = passedUnits && passedValidation && passedPersistedFlag;

    if (!isSuccess) allPassed = false;

    console.log(`\n[Test ${i+1}/${testCases.length}] ${tc.name}: ${isSuccess ? "PASSED" : "FAILED"} (${duration}ms)`);
    console.log(`  Input: "${tc.input}"`);
    console.log(`  Split count: ${data.memories ? data.memories.length : 0} (expected ${tc.expectedUnits})`);
    console.log(`  Persisted flag: ${data.persisted}`);
    if (data.memories) {
      data.memories.forEach((m, idx) => {
        console.log(`    Unit ${idx+1}: content="${m.interpretation?.content}" | kind=${m.interpretation?.kind} | resolved=${m.interpretation?.resolved_datetime} | prerequisite=${JSON.stringify(m.interpretation?.prerequisite)}`);
      });
    }
  }

  // 3. Check persistent memory count after unit tests
  const afterRes = await fetch("http://localhost:3000/api/memories");
  const afterData = await afterRes.json();
  const countAfter = (afterData.memories || []).length;
  console.log(`\n>>> Memory count AFTER unit tests = ${countAfter} rows`);

  // 4. End-to-end Relationship Persistence & Ask Retrieval Verification
  console.log("\n================================================================================");
  console.log("  RELATIONSHIP PERSISTENCE & ASK RETRIEVAL TEST ('Barb is my wife')");
  console.log("================================================================================");
  
  let relationshipTestPassed = false;
  const relsBeforeRes = await fetch("http://localhost:3000/api/relationships");
  const relsBeforeData = await relsBeforeRes.json();
  const relsBefore = relsBeforeData.relationships || [];
  console.log(`Initial active relationships count: ${relsBefore.length}`);

  let createdMemoryId = null;
  try {
    // Step A: Capture "Barb is my wife" via production POST /api/memories
    const captureRes = await fetch("http://localhost:3000/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalText: "Barb is my wife",
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const captureData = await captureRes.json();
    createdMemoryId = captureData.memory?.id || captureData.memories?.[0]?.id;
    console.log(`Captured memory ID: ${createdMemoryId}`);

    // Step B: Verify relationship is persisted in GET /api/relationships
    const relsAfterRes = await fetch("http://localhost:3000/api/relationships");
    const relsAfterData = await relsAfterRes.json();
    const activeRels = relsAfterData.relationships || [];
    const barbWifeRel = activeRels.find(r => r.person?.toLowerCase() === "barb" && r.normalized_role === "wife");
    console.log(`Persisted relationship found:`, barbWifeRel);

    // Step C: Ask "Who is my wife?" via POST /api/ask
    const askRes = await fetch("http://localhost:3000/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Who is my wife?",
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const askData = await askRes.json();
    console.log(`Ask answer: "${askData.answer}"`);
    console.log(`Ask memory_ids: ${JSON.stringify(askData.memory_ids)}`);

    const answerMatches = askData.answer && askData.answer.toLowerCase().includes("barb");
    const relExists = Boolean(barbWifeRel);

    if (relExists && answerMatches) {
      relationshipTestPassed = true;
      console.log(`\n[Relationship Test] 'Barb is my wife' -> 'Who is my wife?' => PASSED`);
    } else {
      console.log(`\n[Relationship Test] 'Barb is my wife' -> 'Who is my wife?' => FAILED (relExists: ${relExists}, answerMatches: ${answerMatches})`);
    }
  } catch (testErr) {
    console.error("Error during relationship test:", testErr);
  } finally {
    // Step D: Strict Cleanup - remove test memory and restore pure stored state
    if (createdMemoryId) {
      await fetch(`http://localhost:3000/api/memories/${createdMemoryId}`, { method: "DELETE" });
      console.log(`Cleaned up test memory ${createdMemoryId}`);
    }
    await fetch("http://localhost:3000/api/relationships/backfill", { method: "POST" });
    console.log(`Restored persistent relationship state from memories`);
  }

  // 5. Multi-Memory Original Text Bleed Lifecycle Regression Test
  console.log("\n================================================================================");
  console.log("  MULTI-MEMORY ORIGINAL TEXT BLEED LIFECYCLE REGRESSION TEST");
  console.log("================================================================================");

  let bleedLifecyclePassed = false;
  let createdMemoryIds = [];

  try {
    // Step 1: Capture one 3-part statement containing A, B, and C
    const compositeInput = "I need to buy apples tomorrow morning, ring the electrician this afternoon, and remember that the spare car key is in the hallway drawer.";
    console.log(`\n1. Capturing 3-part composite statement: "${compositeInput}"`);

    const captureRes = await fetch("http://localhost:3000/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalText: compositeInput,
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const captureData = await captureRes.json();
    const producedMemories = captureData.memories || [];
    createdMemoryIds = producedMemories.map(m => m.id);

    // Step 2: Verify three memories are produced
    const step2Passed = producedMemories.length === 3;
    console.log(`2. Produced memory count = ${producedMemories.length} (expected 3): ${step2Passed ? "PASSED" : "FAILED"}`);

    // Step 3: Verify each memory's originalText contains only its own unit and not the other two facts
    const memA = producedMemories.find(m => (m.interpretation?.content || '').toLowerCase().includes('apple') || (m.originalText || '').toLowerCase().includes('apple'));
    const memB = producedMemories.find(m => (m.interpretation?.content || '').toLowerCase().includes('electrician') || (m.originalText || '').toLowerCase().includes('electrician'));
    const memC = producedMemories.find(m => (m.interpretation?.content || '').toLowerCase().includes('car key') || (m.interpretation?.content || '').toLowerCase().includes('hallway') || (m.originalText || '').toLowerCase().includes('car key'));

    console.log(`   Memory A (Apples): originalText="${memA?.originalText}" | content="${memA?.interpretation?.content}"`);
    console.log(`   Memory B (Electrician): originalText="${memB?.originalText}" | content="${memB?.interpretation?.content}"`);
    console.log(`   Memory C (Car Key): originalText="${memC?.originalText}" | content="${memC?.interpretation?.content}"`);

    const aIsIsolated = memA && !memA.originalText.toLowerCase().includes('electrician') && !memA.originalText.toLowerCase().includes('car key') && !memA.originalText.toLowerCase().includes('hallway');
    const bIsIsolated = memB && !memB.originalText.toLowerCase().includes('apple') && !memB.originalText.toLowerCase().includes('car key') && !memB.originalText.toLowerCase().includes('hallway');
    const cIsIsolated = memC && !memC.originalText.toLowerCase().includes('apple') && !memC.originalText.toLowerCase().includes('electrician');
    const step3Passed = aIsIsolated && bIsIsolated && cIsIsolated;
    console.log(`3. Unit-specific originalText isolation (A: ${aIsIsolated}, B: ${bIsIsolated}, C: ${cIsIsolated}): ${step3Passed ? "PASSED" : "FAILED"}`);

    // Step 4: Edit C to a different value
    const editedCText = "The spare car key is now in the bedroom wardrobe.";
    console.log(`\n4. Editing Memory C (${memC?.id}) to: "${editedCText}"`);
    const editRes = await fetch(`http://localhost:3000/api/memories/${memC?.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        editedText: editedCText,
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const editData = await editRes.json();
    console.log(`   Updated Memory C content: "${editData.memory?.interpretation?.content}"`);

    // Step 5: Verify Ask returns the edited C
    console.log(`\n5. Asking: 'Where is the spare car key?'`);
    const askEditedRes = await fetch("http://localhost:3000/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Where is the spare car key?",
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const askEditedData = await askEditedRes.json();
    console.log(`   Ask edited answer: "${askEditedData.answer}"`);
    console.log(`   Ask edited memory_ids: ${JSON.stringify(askEditedData.memory_ids)}`);
    const step5Passed = askEditedData.answer && askEditedData.answer.toLowerCase().includes("bedroom wardrobe");
    console.log(`   Ask returns edited value (bedroom wardrobe): ${step5Passed ? "PASSED" : "FAILED"}`);

    // Step 6: Delete C
    console.log(`\n6. Deleting Memory C (${memC?.id})...`);
    await fetch(`http://localhost:3000/api/memories/${memC?.id}`, { method: "DELETE" });
    console.log(`   Deleted Memory C.`);

    // Step 7: Verify Ask cannot recover either the original or edited C from sibling A or B
    console.log(`\n7. Asking again: 'Where is the spare car key?'`);
    const askDeletedRes = await fetch("http://localhost:3000/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Where is the spare car key?",
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const askDeletedData = await askDeletedRes.json();
    console.log(`   Ask post-deletion answer: "${askDeletedData.answer}"`);
    console.log(`   Ask post-deletion memory_ids: ${JSON.stringify(askDeletedData.memory_ids)}`);
    const containsObsoleteFact = (askDeletedData.answer || '').toLowerCase().includes("hallway drawer") || (askDeletedData.answer || '').toLowerCase().includes("bedroom wardrobe");
    const step7Passed = !containsObsoleteFact && (askDeletedData.memory_ids || []).length === 0;
    console.log(`   Ask cannot recover deleted fact from siblings: ${step7Passed ? "PASSED" : "FAILED"}`);

    // Step 8: Verify A and B remain retrievable normally
    console.log(`\n8. Verifying surviving siblings A and B are retrievable normally...`);
    const [askARes, askBRes] = await Promise.all([
      fetch("http://localhost:3000/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "When do I need to buy apples?",
          clientNow: "2026-08-28T10:00:00.000Z",
          clientTimeZone: "Australia/Sydney",
          clientLanguage: "en-AU",
          clientRegion: "AU"
        })
      }),
      fetch("http://localhost:3000/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "Who should I ring this afternoon?",
          clientNow: "2026-08-28T10:00:00.000Z",
          clientTimeZone: "Australia/Sydney",
          clientLanguage: "en-AU",
          clientRegion: "AU"
        })
      })
    ]);
    const askAData = await askARes.json();
    const askBData = await askBRes.json();
    console.log(`   Ask A (apples) answer: "${askAData.answer}" | memory_ids: ${JSON.stringify(askAData.memory_ids)}`);
    console.log(`   Ask B (electrician) answer: "${askBData.answer}" | memory_ids: ${JSON.stringify(askBData.memory_ids)}`);

    const aRetrievable = askAData.answer && (askAData.memory_ids || []).includes(memA?.id);
    const bRetrievable = askBData.answer && (askBData.memory_ids || []).includes(memB?.id);
    const step8Passed = aRetrievable && bRetrievable;
    console.log(`   Surviving siblings A & B retrievable normally: ${step8Passed ? "PASSED" : "FAILED"}`);

    if (step2Passed && step3Passed && step5Passed && step7Passed && step8Passed) {
      bleedLifecyclePassed = true;
      console.log(`\n[Bleed Lifecycle Test] Full 3-part split, edit, delete & isolation lifecycle => PASSED`);
    } else {
      console.log(`\n[Bleed Lifecycle Test] Full lifecycle => FAILED`);
    }
  } catch (lifecycleErr) {
    console.error("Error during bleed lifecycle test:", lifecycleErr);
  } finally {
    // Clean up any remaining test memories (A and B)
    for (const memId of createdMemoryIds) {
      try {
        await fetch(`http://localhost:3000/api/memories/${memId}`, { method: "DELETE" });
      } catch {}
    }
    console.log(`Cleaned up test memories: ${JSON.stringify(createdMemoryIds)}`);
  }

  // 6. Clarification FACT Memory Creation, Edit, Delete & Relationship Sync Lifecycle Test
  console.log("\n================================================================================");
  console.log("  CLARIFICATION FACT MEMORY CREATION & RELATIONSHIP LIFECYCLE TEST");
  console.log("================================================================================");

  let clarificationLifecyclePassed = false;
  let reminderMemoryId = null;
  let factMemoryId = null;

  try {
    // Step 1: Capture reminder mentioning Peter: "I need to speak to Peter tomorrow."
    console.log(`\n1. Capturing intention: "I need to speak to Peter tomorrow."`);
    const captureRes = await fetch("http://localhost:3000/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalText: "I need to speak to Peter tomorrow.",
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const captureData = await captureRes.json();
    reminderMemoryId = captureData.memory?.id || captureData.memories?.[0]?.id;
    console.log(`   Captured reminder memory ID: ${reminderMemoryId}`);
    const step1Ok = Boolean(reminderMemoryId);

    // Step 2: Resolve clarification: User states "Peter is my electrician"
    console.log(`\n2. Resolving clarification: entityName="Peter", answer="Peter is my electrician"`);
    const clarifyRes = await fetch("http://localhost:3000/api/clarifications/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clarificationId: "test_clar_1",
        entityName: "Peter",
        answer: "Peter is my electrician",
        memoryId: reminderMemoryId
      })
    });
    const clarifyData = await clarifyRes.json();
    console.log(`   Clarification response message: "${clarifyData.message}"`);
    console.log(`   Created FACT memory:`, clarifyData.memory?.interpretation?.content);
    factMemoryId = clarifyData.memory?.id;

    // Step 3: Verify visible FACT card exists in memories
    console.log(`\n3. Verifying visible FACT card exists in Stored Intention Memories...`);
    const allMemRes = await fetch("http://localhost:3000/api/memories");
    const allMemData = await allMemRes.json();
    const storedMemories = allMemData.memories || [];
    const foundFactCard = storedMemories.find(m => m.id === factMemoryId);
    console.log(`   Found FACT card: ID=${foundFactCard?.id}, kind=${foundFactCard?.interpretation?.kind}, content="${foundFactCard?.interpretation?.content}"`);
    const step3Ok = Boolean(foundFactCard && foundFactCard.interpretation?.kind === "fact" && foundFactCard.interpretation?.content.toLowerCase().includes("electrician"));
    console.log(`   Visible FACT card created: ${step3Ok ? "PASSED" : "FAILED"}`);

    // Step 4: Ask "Who is my electrician?"
    console.log(`\n4. Asking: 'Who is my electrician?'`);
    const askElecRes = await fetch("http://localhost:3000/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Who is my electrician?",
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const askElecData = await askElecRes.json();
    console.log(`   Ask electrician answer: "${askElecData.answer}"`);
    const step4Ok = askElecData.answer && askElecData.answer.toLowerCase().includes("peter");
    console.log(`   Ask returns Peter as electrician: ${step4Ok ? "PASSED" : "FAILED"}`);

    // Step 5: Edit the FACT card from "Peter is my electrician" to "Peter is my plumber"
    console.log(`\n5. Editing FACT card (${factMemoryId}) to: "Peter is my plumber"`);
    const editFactRes = await fetch(`http://localhost:3000/api/memories/${factMemoryId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        editedText: "Peter is my plumber",
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const editFactData = await editFactRes.json();
    console.log(`   Updated FACT content: "${editFactData.memory?.interpretation?.content}"`);

    // Step 6: Verify Ask "Who is my plumber?" -> returns Peter, and "Who is my electrician?" -> does not return Peter
    console.log(`\n6. Verifying updated role: Asking 'Who is my plumber?' and 'Who is my electrician?'`);
    const [askPlumbRes, askOldElecRes] = await Promise.all([
      fetch("http://localhost:3000/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "Who is my plumber?",
          clientNow: "2026-08-28T10:00:00.000Z",
          clientTimeZone: "Australia/Sydney",
          clientLanguage: "en-AU",
          clientRegion: "AU"
        })
      }),
      fetch("http://localhost:3000/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "Who is my electrician?",
          clientNow: "2026-08-28T10:00:00.000Z",
          clientTimeZone: "Australia/Sydney",
          clientLanguage: "en-AU",
          clientRegion: "AU"
        })
      })
    ]);
    const askPlumbData = await askPlumbRes.json();
    const askOldElecData = await askOldElecRes.json();
    console.log(`   Ask plumber answer: "${askPlumbData.answer}"`);
    console.log(`   Ask electrician answer: "${askOldElecData.answer}"`);

    const step6aOk = askPlumbData.answer && askPlumbData.answer.toLowerCase().includes("peter");
    const step6bOk = !(askOldElecData.answer && askOldElecData.answer.toLowerCase().includes("peter"));
    const step6Ok = step6aOk && step6bOk;
    console.log(`   Role update reflected in Ask (Plumber=Peter: ${step6aOk}, Electrician!=Peter: ${step6bOk}): ${step6Ok ? "PASSED" : "FAILED"}`);

    // Step 7: Delete the FACT card
    console.log(`\n7. Deleting FACT card (${factMemoryId})...`);
    await fetch(`http://localhost:3000/api/memories/${factMemoryId}`, { method: "DELETE" });
    console.log(`   Deleted FACT card.`);
    factMemoryId = null;

    // Step 8: Verify Ask "Who is my plumber?" no longer returns Peter
    console.log(`\n8. Asking again: 'Who is my plumber?' after deleting FACT card...`);
    const askPostDelRes = await fetch("http://localhost:3000/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Who is my plumber?",
        clientNow: "2026-08-28T10:00:00.000Z",
        clientTimeZone: "Australia/Sydney",
        clientLanguage: "en-AU",
        clientRegion: "AU"
      })
    });
    const askPostDelData = await askPostDelRes.json();
    console.log(`   Ask plumber post-deletion answer: "${askPostDelData.answer}"`);
    const step8Ok = !(askPostDelData.answer && askPostDelData.answer.toLowerCase().includes("peter"));
    console.log(`   Relationship forgotten after FACT deletion: ${step8Ok ? "PASSED" : "FAILED"}`);

    // Step 9: Verify original reminder memory "Speak to Peter tomorrow" still exists untouched
    console.log(`\n9. Verifying original reminder memory untouched...`);
    const checkReminderRes = await fetch(`http://localhost:3000/api/memories`);
    const checkReminderData = await checkReminderRes.json();
    const reminderStillExists = (checkReminderData.memories || []).some(m => m.id === reminderMemoryId);
    console.log(`   Original reminder still exists: ${reminderStillExists ? "PASSED" : "FAILED"}`);

    if (step1Ok && step3Ok && step4Ok && step6Ok && step8Ok && reminderStillExists) {
      clarificationLifecyclePassed = true;
      console.log(`\n[Clarification FACT Lifecycle Test] Full Clarification -> FACT card -> Ask -> Edit -> Delete -> Forget => PASSED`);
    } else {
      console.log(`\n[Clarification FACT Lifecycle Test] FAILED`);
    }
  } catch (clarErr) {
    console.error("Error during clarification lifecycle test:", clarErr);
  } finally {
    // Clean up reminder and fact memories
    if (factMemoryId) {
      try { await fetch(`http://localhost:3000/api/memories/${factMemoryId}`, { method: "DELETE" }); } catch {}
    }
    if (reminderMemoryId) {
      try { await fetch(`http://localhost:3000/api/memories/${reminderMemoryId}`, { method: "DELETE" }); } catch {}
    }
    await fetch("http://localhost:3000/api/relationships/backfill", { method: "POST" });
    console.log(`Cleaned up clarification test records.`);
  }

  // Final count check after cleanup
  const finalMemRes = await fetch("http://localhost:3000/api/memories");
  const finalMemData = await finalMemRes.json();
  const countFinal = (finalMemData.memories || []).length;

  const finalRelRes = await fetch("http://localhost:3000/api/relationships");
  const finalRelData = await finalRelRes.json();
  const relsFinal = finalRelData.relationships || [];

  console.log("\n================================================================================");
  console.log("  TEST SUITE SUMMARY & ISOLATION ASSERTION");
  console.log("================================================================================");
  console.log(`Memory count before tests:      ${countBefore}`);
  console.log(`Memory count after all tests:   ${countFinal}`);
  console.log(`Relationship count before tests: ${relsBefore.length}`);
  console.log(`Relationship count after tests:  ${relsFinal.length}`);

  const isolationVerified = countBefore === countFinal;
  console.log(`Memory row count unchanged:     ${isolationVerified ? "YES (PASSED)" : "NO (FAILED - ROW COUNT CHANGED!)"}`);
  console.log(`All unit tests passed:          ${allPassed ? "YES (PASSED)" : "NO (FAILED)"}`);
  console.log(`Relationship Ask test passed:   ${relationshipTestPassed ? "YES (PASSED)" : "NO (FAILED)"}`);
  console.log(`Bleed Lifecycle test passed:    ${bleedLifecyclePassed ? "YES (PASSED)" : "NO (FAILED)"}`);
  console.log(`Clarification Lifecycle passed: ${clarificationLifecyclePassed ? "YES (PASSED)" : "NO (FAILED)"}`);

  if (!isolationVerified || !allPassed || !relationshipTestPassed || !bleedLifecyclePassed || !clarificationLifecyclePassed) {
    process.exit(1);
  }
}

runRegressionSuite().catch(err => {
  console.error("Test suite error:", err);
  process.exit(1);
});

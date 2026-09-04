import { executeBunnySql } from './client';
import { initBunnyDb } from './schema';
import { parseReminderTriggerTime } from '../utils/time';
import { detectClockTimeAmbiguity } from '../utils/timeAmbiguity';
import { saveRelationships, saveUserEntity, extractPhoneNumber, normalizeRoleName, unsuppressUserEntity } from '../relationships/index';
import { extractSearchDoc, getSearchSyncStatements, getSearchDeleteStatements } from './search_sync';
import { buildMemoryDocumentString, syncMemoryVector, deleteMemoryVector } from '../retrieval/vector_service';

// Helper to parse stored topics and retrieval metadata
export function parseStoredTopicsAndMetadata(rawTopics: string | null, fallbackKind: string) {
  let topics: string[] = [];
  let contexts: string[] = [];
  let retrieval_cues: string[] = [];
  let items: string[] = [];
  let relationships: Array<{ person: string; role: string; is_active?: boolean }> = [];
  let intent: string = fallbackKind || 'remember';
  let suggested_action: any = null;
  let linked_event_id: string | null = null;
  let prerequisite: any = null;
  let subject: string | null = null;
  let subject_resolved_date: string | null = null;
  let anticipatory_mode: 'NONE' | 'POST_ONLY' | 'PRE_AND_POST' = 'NONE';
  let anticipatory_opted_in: boolean = false;

  if (rawTopics) {
    try {
      const parsed = JSON.parse(rawTopics);
      if (Array.isArray(parsed)) {
        // Legacy raw topic array record - keep topics, contexts and retrieval_cues remain empty for legacy
        topics = parsed.filter((t: any) => typeof t === 'string');
      } else if (parsed && typeof parsed === 'object') {
        // New metadata structure: { topics, contexts, retrieval_cues, relationships, intent, suggested_action, linked_event_id, subject }
        topics = Array.isArray(parsed.topics) ? parsed.topics.filter((t: any) => typeof t === 'string') : [];
        contexts = Array.isArray(parsed.contexts) ? parsed.contexts.filter((c: any) => typeof c === 'string') : [];
        retrieval_cues = Array.isArray(parsed.retrieval_cues) ? parsed.retrieval_cues.filter((r: any) => typeof r === 'string') : [];
        items = Array.isArray(parsed.items) ? parsed.items.filter((i: any) => typeof i === 'string') : [];
        relationships = Array.isArray(parsed.relationships) ? parsed.relationships : [];
        intent = typeof parsed.intent === 'string' && parsed.intent.trim() ? parsed.intent : (fallbackKind || 'remember');
        linked_event_id = parsed.linked_event_id || null;
        subject = typeof parsed.subject === 'string' && parsed.subject.trim() ? parsed.subject.trim() : null;
        subject_resolved_date = typeof parsed.subject_resolved_date === 'string' && parsed.subject_resolved_date.trim() ? parsed.subject_resolved_date.trim() : null;
        if (parsed.anticipatory_mode && ['NONE', 'POST_ONLY', 'PRE_AND_POST'].includes(parsed.anticipatory_mode)) {
          anticipatory_mode = parsed.anticipatory_mode;
        }
        if (parsed.anticipatory_opted_in !== undefined) {
          anticipatory_opted_in = Boolean(parsed.anticipatory_opted_in);
        }

        if (parsed.prerequisite && typeof parsed.prerequisite === 'object' && parsed.prerequisite.condition) {
          prerequisite = {
            condition: String(parsed.prerequisite.condition).trim(),
            status: parsed.prerequisite.status || 'pending',
            expected_time_expression: parsed.prerequisite.expected_time_expression || null,
            expected_datetime: parsed.prerequisite.expected_datetime || null,
          };
        }
        if (parsed.suggested_action && typeof parsed.suggested_action === 'object' && parsed.suggested_action.label && parsed.suggested_action.query) {
          suggested_action = {
            type: parsed.suggested_action.type || 'web_search',
            label: parsed.suggested_action.label,
            query: parsed.suggested_action.query,
          };
        }
      }
    } catch {
      topics = [];
    }
  }

  return { topics, contexts, retrieval_cues, relationships, intent, suggested_action, linked_event_id, items, prerequisite, subject, subject_resolved_date, anticipatory_mode, anticipatory_opted_in };
}

// Helper to parse stored resurfacing timing and absolute dates
export function parseStoredResurfacing(rawTiming: string | null, rawMode: string | null) {
  let timing = rawTiming || 'Unscheduled';
  let mode = rawMode || 'none';
  let original_time_expression: string | null = null;
  let resolved_datetime: string | null = null;
  let event_time_expression: string | null = null;
  let event_datetime: string | null = null;
  let reminder_time_expression: string | null = null;
  let reminder_datetime: string | null = null;

  if (rawTiming) {
    if (rawTiming.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawTiming);
        timing = parsed.timing || 'Unscheduled';
        mode = parsed.mode || rawMode || 'none';
        original_time_expression = parsed.original_time_expression || null;
        resolved_datetime = parsed.resolved_datetime || null;
        event_time_expression = parsed.event_time_expression || null;
        event_datetime = parsed.event_datetime || null;
        reminder_time_expression = parsed.reminder_time_expression || null;
        reminder_datetime = parsed.reminder_datetime || null;
      } catch {
        timing = rawTiming;
      }
    } else {
      // Legacy unformatted timing string.
      // Contextual phrases (e.g. "When looking for glasses", "Contextual / On retrieval", "Unscheduled")
      // MUST NOT be copied into original_time_expression.
      timing = rawTiming;
      const isSituationalOrContextual = /^(when|if|whenever|in case|after)\s+/i.test(rawTiming) ||
        /^(contextual|unscheduled|review soon|on retrieval)/i.test(rawTiming);
      const isDateBasedMode = mode === 'date_based' || /^(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|in \d+|\d+)/i.test(rawTiming);

      if (isDateBasedMode && !isSituationalOrContextual) {
        original_time_expression = rawTiming;
      } else {
        original_time_expression = null;
      }
    }
  }

  return {
    resurfacing: { mode, timing },
    original_time_expression,
    resolved_datetime,
    event_time_expression,
    event_datetime,
    reminder_time_expression,
    reminder_datetime,
  };
}

// Read memories from Bunny Database (durable source of truth)
export async function readMemories(): Promise<any[]> {
  try {
    await initBunnyDb();
    const results = await executeBunnySql([{
      sql: 'SELECT id, originalText, createdAt, isDone, content, kind, status, people, places, topics, resurfacingMode, resurfacingTiming FROM memories ORDER BY createdAt DESC;'
    }]);

    if (!results[0] || !results[0].rows) return [];

    return results[0].rows.map((row: any) => {
      const meta = parseStoredTopicsAndMetadata(row.topics, row.kind);
      const timeMeta = parseStoredResurfacing(row.resurfacingTiming, row.resurfacingMode);

      return {
        id: row.id,
        originalText: row.originalText || '',
        createdAt: row.createdAt,
        isDone: Boolean(Number(row.isDone)),
        anticipatory_mode: meta.anticipatory_mode,
        anticipatory_opted_in: meta.anticipatory_opted_in,
        interpretation: {
          content: row.content,
          kind: row.kind,
          intent: meta.intent,
          status: row.status,
          people: row.people ? JSON.parse(row.people) : [],
          places: row.places ? JSON.parse(row.places) : [],
          topics: meta.topics,
          contexts: meta.contexts,
          retrieval_cues: meta.retrieval_cues,
          items: meta.items || [],
          relationships: meta.relationships || [],
          prerequisite: meta.prerequisite || null,
          original_time_expression: timeMeta.original_time_expression,
          resolved_datetime: timeMeta.resolved_datetime,
          event_time_expression: timeMeta.event_time_expression,
          event_datetime: timeMeta.event_datetime,
          reminder_time_expression: timeMeta.reminder_time_expression,
          reminder_datetime: timeMeta.reminder_datetime,
          resurfacing: timeMeta.resurfacing,
          suggested_action: meta.suggested_action || null,
          linked_event_id: meta.linked_event_id || null,
          subject: meta.subject || null,
          subject_resolved_date: meta.subject_resolved_date || null,
          anticipatory_mode: meta.anticipatory_mode,
          anticipatory_opted_in: meta.anticipatory_opted_in,
        },
      };
    });
  } catch (err) {
    console.error('[Bunny DB] Error reading memories from database:', err);
    return [];
  }
}

// Read a single memory by ID from Bunny DB
export async function readMemoryById(id: string): Promise<any | null> {
  try {
    await initBunnyDb();
    const list = await executeBunnySql([{
      sql: 'SELECT id, originalText, createdAt, isDone, content, kind, status, people, places, topics, resurfacingMode, resurfacingTiming FROM memories WHERE id = ?;',
      args: [id]
    }]);

    if (!list[0] || !list[0].rows || list[0].rows.length === 0) {
      return null;
    }

    const row = list[0].rows[0];
    const meta = parseStoredTopicsAndMetadata(row.topics, row.kind);
    const timeMeta = parseStoredResurfacing(row.resurfacingTiming, row.resurfacingMode);

    return {
      id: row.id,
      originalText: row.originalText || '',
      createdAt: row.createdAt,
      isDone: Boolean(Number(row.isDone)),
      anticipatory_mode: meta.anticipatory_mode,
      anticipatory_opted_in: meta.anticipatory_opted_in,
      interpretation: {
        content: row.content,
        kind: row.kind,
        intent: meta.intent,
        status: row.status,
        people: row.people ? JSON.parse(row.people) : [],
        places: row.places ? JSON.parse(row.places) : [],
        topics: meta.topics,
        contexts: meta.contexts,
        retrieval_cues: meta.retrieval_cues,
        items: meta.items || [],
        relationships: meta.relationships || [],
        prerequisite: meta.prerequisite || null,
        original_time_expression: timeMeta.original_time_expression,
        resolved_datetime: timeMeta.resolved_datetime,
        event_time_expression: timeMeta.event_time_expression,
        event_datetime: timeMeta.event_datetime,
        reminder_time_expression: timeMeta.reminder_time_expression,
        reminder_datetime: timeMeta.reminder_datetime,
        resurfacing: timeMeta.resurfacing,
        suggested_action: meta.suggested_action || null,
        linked_event_id: meta.linked_event_id || null,
        subject: meta.subject || null,
        subject_resolved_date: meta.subject_resolved_date || null,
        anticipatory_mode: meta.anticipatory_mode,
        anticipatory_opted_in: meta.anticipatory_opted_in,
      },
    };
  } catch (err) {
    console.error(`[Bunny DB] Error reading memory ${id}:`, err);
    return null;
  }
}

// Insert memory records into Bunny Database and schedule reminders if timed
export async function insertMemories(
  items: any[],
  options?: { skipRelationshipSave?: boolean }
): Promise<{ phoneOffer?: { person: string; role: string } | null }> {
  await initBunnyDb();
  const stmts: Array<{ sql: string; args: any[] }> = [];
  const reminderStmts: Array<{ sql: string; args: any[] }> = [];
  const relationshipsToSave: Array<{ person: string; role: string; is_active?: boolean }> = [];
  let phoneOffer: { person: string; role: string } | null = null;

  for (const item of items) {
    const itemRelationships = Array.isArray(item.interpretation.relationships) ? item.interpretation.relationships : [];
    const textToScan = item.originalText || item.interpretation?.content || '';
    const { phoneNumber } = extractPhoneNumber(textToScan);
    const people = Array.isArray(item.interpretation.people) ? item.interpretation.people : [];

    if (itemRelationships.length > 0) {
      relationshipsToSave.push(...itemRelationships);

      // Phase F3: If this relationship-declaring item contains a phone number, structurally save the user entity with phone metadata
      if (phoneNumber) {
        for (const rel of itemRelationships) {
          if (rel && rel.person && rel.role && rel.is_active !== false) {
            await unsuppressUserEntity(rel.person);
            await saveUserEntity({
              name: rel.person,
              entity_type: 'person',
              role: rel.role,
              normalized_role: normalizeRoleName(rel.role),
              metadata: { phone: phoneNumber },
            }, { skipSuppressionCheck: true });
          }
        }
      } else if (!phoneOffer) {
        // Phase F4: Relationship declared without phone number - generate phoneOffer
        const activeRel = itemRelationships.find((rel: any) => rel && rel.person && rel.role && rel.is_active !== false);
        if (activeRel) {
          phoneOffer = { person: activeRel.person, role: activeRel.role };
        }
      }
    } else if (phoneNumber && people.length === 1) {
      // Explicit contact phone teaching for a single person (e.g. "Fred's number is 0412...")
      const singlePerson = (people[0] || '').trim();
      if (singlePerson) {
        await unsuppressUserEntity(singlePerson);
        await saveUserEntity({
          name: singlePerson,
          entity_type: 'person',
          metadata: { phone: phoneNumber },
        }, { skipSuppressionCheck: true });
      }
    }

    const metaTopicsObj = {
      topics: Array.isArray(item.interpretation.topics) ? item.interpretation.topics : [],
      contexts: Array.isArray(item.interpretation.contexts) ? item.interpretation.contexts : [],
      retrieval_cues: Array.isArray(item.interpretation.retrieval_cues) ? item.interpretation.retrieval_cues : [],
      items: Array.isArray(item.interpretation.items) ? item.interpretation.items : [],
      relationships: itemRelationships,
      intent: item.interpretation.intent || item.interpretation.kind || 'remember',
      prerequisite: item.interpretation.prerequisite || null,
      suggested_action: item.interpretation.suggested_action || null,
      linked_event_id: item.interpretation.linked_event_id || null,
      subject: item.interpretation.subject || null,
      subject_resolved_date: item.interpretation.subject_resolved_date || null,
      anticipatory_mode: item.interpretation.anticipatory_mode || item.anticipatory_mode || 'NONE',
      anticipatory_opted_in: item.interpretation.anticipatory_opted_in !== undefined ? Boolean(item.interpretation.anticipatory_opted_in) : Boolean(item.anticipatory_opted_in),
    };

    const metaTimingObj = {
      timing: item.interpretation.resurfacing?.timing || 'Unscheduled',
      mode: item.interpretation.resurfacing?.mode || 'none',
      original_time_expression: item.interpretation.original_time_expression || null,
      resolved_datetime: item.interpretation.resolved_datetime || null,
      event_time_expression: item.interpretation.event_time_expression || null,
      event_datetime: item.interpretation.event_datetime || null,
      reminder_time_expression: item.interpretation.reminder_time_expression || null,
      reminder_datetime: item.interpretation.reminder_datetime || null,
    };

    stmts.push({
      sql: `INSERT INTO memories (id, originalText, createdAt, isDone, content, kind, status, people, places, topics, resurfacingMode, resurfacingTiming)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        item.id,
        item.originalText,
        item.createdAt,
        item.isDone ? 1 : 0,
        item.interpretation.content,
        item.interpretation.kind,
        item.interpretation.status || 'active',
        JSON.stringify(item.interpretation.people || []),
        JSON.stringify(item.interpretation.places || []),
        JSON.stringify(metaTopicsObj),
        item.interpretation.resurfacing?.mode || 'none',
        JSON.stringify(metaTimingObj),
      ]
    });

    // Synchronize derived search structures (memories_fts & memory_search_projection)
    const searchDoc = extractSearchDoc(item);
    stmts.push(...getSearchSyncStatements(searchDoc));

    // Check if memory has a scheduled reminder timestamp (Action's own timing ONLY)
    let remindAt: string | null = null;
    const isReminderKind = item.interpretation?.kind === 'reminder';
    const isAmbiguous = item.interpretation?.temporal_ambiguity?.isAmbiguous ||
      detectClockTimeAmbiguity(item.originalText, item.interpretation?.resurfacing?.timing || item.interpretation?.original_time_expression).isAmbiguous;

    if (isReminderKind && !isAmbiguous) {
      const candidateTimestamp = item.interpretation.reminder_datetime || item.interpretation.resolved_datetime;

      if (candidateTimestamp) {
        // Only schedule exact-instant push notifications if a genuine time component exists (contains 'T')
        if (candidateTimestamp.includes('T') && !isNaN(Date.parse(candidateTimestamp))) {
          remindAt = new Date(candidateTimestamp).toISOString();
        }
        // If candidateTimestamp is date-only (no 'T'), do NOT schedule a push notification
      } else if (item.interpretation.resurfacing?.mode === 'date_based' && !item.interpretation.prerequisite) {
        // Legacy fallback only for explicit date_based resurfacing without prerequisite when no candidate timestamp is present
        const timing = item.interpretation.resurfacing?.timing || '';
        if (!timing || timing.includes('T') || !/^\d{4}-\d{2}-\d{2}$/.test(timing.trim())) {
          remindAt = parseReminderTriggerTime(
            item.originalText,
            timing,
            new Date(item.createdAt)
          );
        }
      }
    } else if (!isReminderKind) {
      // Non-reminder kind (e.g. fact, note) - never schedule push notifications
    } else {
      console.log(`[Scheduler] Postponing reminder scheduling for "${item.interpretation.content}" due to ambiguous clock time (awaiting AM/PM clarification).`);
    }

    if (remindAt) {
      console.log(`[Scheduler] Scheduling reminder for "${item.interpretation.content}" at ${remindAt}`);
      reminderStmts.push({
        sql: `INSERT INTO scheduled_reminders (id, memoryId, title, body, remindAt, notified, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?);`,
        args: [
          `remind_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          item.id,
          'Ezzymigo Reminder',
          item.interpretation.content,
          remindAt,
          0,
          new Date().toISOString(),
        ]
      });
    }
  }

  await executeBunnySql([...stmts, ...reminderStmts]);

  // Synchronize vectors asynchronously in the background (non-blocking for Tell write)
  for (const item of items) {
    const docText = buildMemoryDocumentString(item);
    syncMemoryVector(item.id, docText).catch(err => {
      console.warn(`[Vector Sync] Non-fatal error syncing vector for ${item.id}:`, err);
    });
  }

  if (!options?.skipRelationshipSave && relationshipsToSave.length > 0) {
    for (const rel of relationshipsToSave) {
      if (rel && rel.person && rel.is_active !== false) {
        await unsuppressUserEntity(rel.person);
      }
    }
    await saveRelationships(relationshipsToSave, { skipSuppressionCheck: true });
  }

  return { phoneOffer: phoneOffer || null };
}

// Toggle memory Done status in Bunny Database
export async function toggleMemoryInDb(id: string): Promise<any | null> {
  await initBunnyDb();
  const list = await executeBunnySql([{
    sql: 'SELECT * FROM memories WHERE id = ?;',
    args: [id]
  }]);

  if (!list[0] || !list[0].rows || list[0].rows.length === 0) {
    return null;
  }

  const row = list[0].rows[0];
  const newIsDone = Number(row.isDone) ? 0 : 1;
  const newStatus = newIsDone ? 'done' : 'active';

  await executeBunnySql([
    {
      sql: 'UPDATE memories SET isDone = ?, status = ? WHERE id = ?;',
      args: [newIsDone, newStatus, id]
    },
    {
      sql: 'UPDATE memory_search_projection SET status = ? WHERE memory_id = ?;',
      args: [newStatus, id]
    }
  ]);

  const meta = parseStoredTopicsAndMetadata(row.topics, row.kind);
  const timeMeta = parseStoredResurfacing(row.resurfacingTiming, row.resurfacingMode);

  return {
    id: row.id,
    originalText: row.originalText,
    createdAt: row.createdAt,
    isDone: Boolean(newIsDone),
    anticipatory_mode: meta.anticipatory_mode,
    anticipatory_opted_in: meta.anticipatory_opted_in,
    interpretation: {
      content: row.content,
      kind: row.kind,
      intent: meta.intent,
      status: newStatus,
      people: row.people ? JSON.parse(row.people) : [],
      places: row.places ? JSON.parse(row.places) : [],
      topics: meta.topics,
      contexts: meta.contexts,
      retrieval_cues: meta.retrieval_cues,
      items: meta.items || [],
      relationships: meta.relationships || [],
      prerequisite: meta.prerequisite || null,
      original_time_expression: timeMeta.original_time_expression,
      resolved_datetime: timeMeta.resolved_datetime,
      event_time_expression: timeMeta.event_time_expression,
      event_datetime: timeMeta.event_datetime,
      reminder_time_expression: timeMeta.reminder_time_expression,
      reminder_datetime: timeMeta.reminder_datetime,
      resurfacing: timeMeta.resurfacing,
      suggested_action: meta.suggested_action || null,
      linked_event_id: meta.linked_event_id || null,
      subject: meta.subject || null,
      subject_resolved_date: meta.subject_resolved_date || null,
      anticipatory_mode: meta.anticipatory_mode,
      anticipatory_opted_in: meta.anticipatory_opted_in,
    },
  };
}

// Update memory in Bunny Database with newly re-interpreted metadata
export async function updateMemoryInDb(id: string, updatedInterpretation: any, newOriginalText?: string): Promise<any | null> {
  await initBunnyDb();
  const list = await executeBunnySql([{
    sql: 'SELECT * FROM memories WHERE id = ?;',
    args: [id]
  }]);

  if (!list[0] || !list[0].rows || list[0].rows.length === 0) {
    return null;
  }

  const row = list[0].rows[0];
  const itemRelationships = Array.isArray(updatedInterpretation.relationships) ? updatedInterpretation.relationships : [];
  const updatedOriginalText = (newOriginalText && typeof newOriginalText === 'string' && newOriginalText.trim())
    ? newOriginalText.trim()
    : (updatedInterpretation.content || row.originalText || '');

  const metaTopicsObj = {
    topics: Array.isArray(updatedInterpretation.topics) ? updatedInterpretation.topics : [],
    contexts: Array.isArray(updatedInterpretation.contexts) ? updatedInterpretation.contexts : [],
    retrieval_cues: Array.isArray(updatedInterpretation.retrieval_cues) ? updatedInterpretation.retrieval_cues : [],
    items: Array.isArray(updatedInterpretation.items) ? updatedInterpretation.items : [],
    relationships: itemRelationships,
    intent: updatedInterpretation.intent || updatedInterpretation.kind || 'remember',
    prerequisite: updatedInterpretation.prerequisite || null,
    suggested_action: updatedInterpretation.suggested_action || null,
    linked_event_id: updatedInterpretation.linked_event_id || null,
    subject: updatedInterpretation.subject || null,
    subject_resolved_date: updatedInterpretation.subject_resolved_date || null,
    anticipatory_mode: updatedInterpretation.anticipatory_mode || 'NONE',
    anticipatory_opted_in: updatedInterpretation.anticipatory_opted_in !== undefined ? Boolean(updatedInterpretation.anticipatory_opted_in) : false,
  };

  const metaTimingObj = {
    timing: updatedInterpretation.resurfacing?.timing || 'Unscheduled',
    mode: updatedInterpretation.resurfacing?.mode || 'none',
    original_time_expression: updatedInterpretation.original_time_expression || null,
    resolved_datetime: updatedInterpretation.resolved_datetime || null,
    event_time_expression: updatedInterpretation.event_time_expression || null,
    event_datetime: updatedInterpretation.event_datetime || null,
    reminder_time_expression: updatedInterpretation.reminder_time_expression || null,
    reminder_datetime: updatedInterpretation.reminder_datetime || null,
  };

  const currentStatus = updatedInterpretation.status || (Number(row.isDone) ? 'done' : 'active');

  const stmts: Array<{ sql: string; args: any[] }> = [
    {
      sql: `UPDATE memories SET
              originalText = ?,
              content = ?,
              kind = ?,
              status = ?,
              people = ?,
              places = ?,
              topics = ?,
              resurfacingMode = ?,
              resurfacingTiming = ?
            WHERE id = ?;`,
      args: [
        updatedOriginalText,
        updatedInterpretation.content,
        updatedInterpretation.kind,
        currentStatus,
        JSON.stringify(updatedInterpretation.people || []),
        JSON.stringify(updatedInterpretation.places || []),
        JSON.stringify(metaTopicsObj),
        updatedInterpretation.resurfacing?.mode || 'none',
        JSON.stringify(metaTimingObj),
        id
      ]
    },
    // Clear old reminders for this memory before adding updated one if applicable
    {
      sql: 'DELETE FROM scheduled_reminders WHERE memoryId = ?;',
      args: [id]
    },
    // Synchronize derived search structures (memories_fts & memory_search_projection)
    ...getSearchSyncStatements(extractSearchDoc({
      id,
      originalText: updatedOriginalText,
      createdAt: row.createdAt,
      isDone: row.isDone,
      interpretation: {
        content: updatedInterpretation.content,
        kind: updatedInterpretation.kind,
        status: currentStatus,
        people: updatedInterpretation.people || [],
        places: updatedInterpretation.places || [],
        topics: metaTopicsObj.topics,
        retrieval_cues: metaTopicsObj.retrieval_cues,
        items: metaTopicsObj.items,
        subject: metaTopicsObj.subject,
      }
    }))
  ];

  // Re-schedule reminder if new interpretation has a reminder timestamp (Action's own timing ONLY)
  let remindAt: string | null = null;
  const isReminderKind = updatedInterpretation?.kind === 'reminder';
  const isAmbiguous = updatedInterpretation?.temporal_ambiguity?.isAmbiguous ||
    detectClockTimeAmbiguity(row.originalText, updatedInterpretation?.resurfacing?.timing || updatedInterpretation?.original_time_expression).isAmbiguous;

  if (isReminderKind && !isAmbiguous) {
    const candidateTimestamp = updatedInterpretation.reminder_datetime || updatedInterpretation.resolved_datetime;

    if (candidateTimestamp) {
      // Only schedule exact-instant push notifications if a genuine time component exists (contains 'T')
      if (candidateTimestamp.includes('T') && !isNaN(Date.parse(candidateTimestamp))) {
        remindAt = new Date(candidateTimestamp).toISOString();
      }
      // If candidateTimestamp is date-only (no 'T'), do NOT schedule a push notification
    } else if (updatedInterpretation.resurfacing?.mode === 'date_based' && !updatedInterpretation.prerequisite) {
      // Legacy fallback only for explicit date_based resurfacing without prerequisite when no candidate timestamp is present
      const timing = updatedInterpretation.resurfacing?.timing || '';
      if (!timing || timing.includes('T') || !/^\d{4}-\d{2}-\d{2}$/.test(timing.trim())) {
        remindAt = parseReminderTriggerTime(
          updatedInterpretation.content,
          timing,
          new Date()
        );
      }
    }
  }

  if (remindAt) {
    console.log(`[Scheduler] Re-scheduling reminder for edited memory "${updatedInterpretation.content}" at ${remindAt}`);
    stmts.push({
      sql: `INSERT INTO scheduled_reminders (id, memoryId, title, body, remindAt, notified, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?);`,
      args: [
        `remind_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        id,
        'Ezzymigo Reminder',
        updatedInterpretation.content,
        remindAt,
        0,
        new Date().toISOString(),
      ]
    });
  }

  await executeBunnySql(stmts);

  // Synchronize vector asynchronously on update
  const updatedDocText = buildMemoryDocumentString({
    id,
    content: updatedInterpretation.content,
    people: updatedInterpretation.people,
    places: updatedInterpretation.places,
    topics: metaTopicsObj.topics,
    retrieval_cues: metaTopicsObj.retrieval_cues,
  });
  syncMemoryVector(id, updatedDocText).catch(err => {
    console.warn(`[Vector Sync] Non-fatal error updating vector for ${id}:`, err);
  });

  let phoneOffer: { person: string; role: string } | null = null;
  const textToScan = updatedOriginalText || updatedInterpretation?.content || '';
  const { phoneNumber } = extractPhoneNumber(textToScan);
  const people = Array.isArray(updatedInterpretation.people) ? updatedInterpretation.people : [];

  if (itemRelationships.length > 0) {
    // Phase F3: If this updated relationship-declaring item contains a phone number, structurally save the user entity with phone metadata
    if (phoneNumber) {
      for (const rel of itemRelationships) {
        if (rel && rel.person && rel.role && rel.is_active !== false) {
          await unsuppressUserEntity(rel.person);
          await saveUserEntity({
            name: rel.person,
            entity_type: 'person',
            role: rel.role,
            normalized_role: normalizeRoleName(rel.role),
            metadata: { phone: phoneNumber },
          }, { skipSuppressionCheck: true });
        }
      }
    } else {
      // Phase F4: Relationship declared without phone number - generate phoneOffer
      const activeRel = itemRelationships.find((rel: any) => rel && rel.person && rel.role && rel.is_active !== false);
      if (activeRel) {
        phoneOffer = { person: activeRel.person, role: activeRel.role };
      }
    }
    for (const rel of itemRelationships) {
      if (rel && rel.person && rel.is_active !== false) {
        await unsuppressUserEntity(rel.person);
      }
    }
    await saveRelationships(itemRelationships, { skipSuppressionCheck: true });
  } else if (phoneNumber && people.length === 1) {
    const singlePerson = (people[0] || '').trim();
    if (singlePerson) {
      await unsuppressUserEntity(singlePerson);
      await saveUserEntity({
        name: singlePerson,
        entity_type: 'person',
        metadata: { phone: phoneNumber },
      }, { skipSuppressionCheck: true });
    }
  }

  return {
    id: row.id,
    originalText: row.originalText, // Preserved original capture text
    createdAt: row.createdAt,
    isDone: Boolean(Number(row.isDone)),
    phoneOffer: phoneOffer || null,
    interpretation: {
      content: updatedInterpretation.content,
      kind: updatedInterpretation.kind,
      intent: updatedInterpretation.intent || updatedInterpretation.kind || 'remember',
      status: currentStatus,
      people: Array.isArray(updatedInterpretation.people) ? updatedInterpretation.people : [],
      places: Array.isArray(updatedInterpretation.places) ? updatedInterpretation.places : [],
      topics: metaTopicsObj.topics,
      contexts: metaTopicsObj.contexts,
      retrieval_cues: metaTopicsObj.retrieval_cues,
      items: metaTopicsObj.items,
      relationships: itemRelationships,
      prerequisite: metaTopicsObj.prerequisite || null,
      original_time_expression: metaTimingObj.original_time_expression,
      resolved_datetime: metaTimingObj.resolved_datetime,
      event_time_expression: metaTimingObj.event_time_expression,
      event_datetime: metaTimingObj.event_datetime,
      reminder_time_expression: metaTimingObj.reminder_time_expression,
      reminder_datetime: metaTimingObj.reminder_datetime,
      resurfacing: {
        mode: metaTimingObj.mode,
        timing: metaTimingObj.timing,
      },
      suggested_action: updatedInterpretation.suggested_action || null,
      subject: metaTopicsObj.subject || null,
      anticipatory_mode: metaTopicsObj.anticipatory_mode,
      anticipatory_opted_in: metaTopicsObj.anticipatory_opted_in,
    },
    anticipatory_mode: metaTopicsObj.anticipatory_mode,
    anticipatory_opted_in: metaTopicsObj.anticipatory_opted_in,
  };
}

// Update memory anticipatory preference in Bunny Database
export async function updateMemoryAnticipation(
  id: string,
  mode: 'NONE' | 'POST_ONLY' | 'PRE_AND_POST',
  optedIn: boolean
): Promise<any | null> {
  await initBunnyDb();
  const list = await executeBunnySql([{
    sql: 'SELECT * FROM memories WHERE id = ?;',
    args: [id]
  }]);

  if (!list[0] || !list[0].rows || list[0].rows.length === 0) {
    return null;
  }

  const row = list[0].rows[0];
  let metaTopics: any = {};
  try {
    metaTopics = JSON.parse(row.topics || '{}');
    if (Array.isArray(metaTopics)) {
      metaTopics = { topics: metaTopics };
    }
  } catch {
    metaTopics = {};
  }

  metaTopics.anticipatory_mode = mode;
  metaTopics.anticipatory_opted_in = optedIn;

  await executeBunnySql([{
    sql: 'UPDATE memories SET topics = ? WHERE id = ?;',
    args: [JSON.stringify(metaTopics), id]
  }]);

  return readMemoryById(id);
}

// Delete memory from Bunny Database
export async function deleteMemoryFromDb(id: string): Promise<void> {
  await initBunnyDb();
  await executeBunnySql([
    {
      sql: 'DELETE FROM memories WHERE id = ?;',
      args: [id]
    },
    {
      sql: 'DELETE FROM scheduled_reminders WHERE memoryId = ?;',
      args: [id]
    },
    ...getSearchDeleteStatements(id)
  ]);
  deleteMemoryVector(id).catch(err => {
    console.warn(`[Vector Delete] Non-fatal error deleting vector for ${id}:`, err);
  });
}

// One-time cleanup for split sibling records whose originalText contains unrelated composite clauses
export async function cleanupContaminatedOriginalTexts(): Promise<void> {
  try {
    await initBunnyDb();
    await executeBunnySql([
      {
        sql: `UPDATE memories 
              SET originalText = 'I need to buy bread tomorrow morning' 
              WHERE id = 'mem_1787941997343_0_9jztrn9' 
                AND originalText LIKE '%spare shed key%';`,
        args: []
      },
      {
        sql: `UPDATE memories 
              SET originalText = 'ring the plumber this afternoon' 
              WHERE id = 'mem_1787941997343_1_9i1dree' 
                AND originalText LIKE '%spare shed key%';`,
        args: []
      }
    ]);
  } catch (err) {
    console.error('[Cleanup] Error cleaning contaminated original texts:', err);
  }
}


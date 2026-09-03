import express from 'express';
import path from 'path';
import fs from 'fs';
import webpush from 'web-push';
import { GoogleGenAI, Type } from '@google/genai';

const app = express();
const PORT = 3000;

app.use(express.json());

import { getBunnyTargetUrl, executeBunnySql } from './server/db/client';
import { initBunnyDb } from './server/db/schema';
import { getGeminiClient } from './server/config/gemini';
import {
  formatLocalTimeContext,
  formatIsoToLocal,
  formatAllDayCivilDateSpan,
  getYMDInTz,
  getTimeStrInTz,
  parseTimeStringToHM,
  parseReminderTriggerTime,
} from './server/utils/time';
import {
  resolveAmbiguousTimeToIso,
  formatTimingWithResolvedMeridiem,
} from './server/utils/timeAmbiguity';
import {
  splitterResponseSchema,
  memoryItemSchema,
  memoriesResponseSchema,
} from './server/ai/schemas';
import {
  isDependentReminderClause,
  applyDependentClauseRule,
  isCollectionContinuation,
  applyCollectionListRule,
  splitCaptureIntoUnits,
} from './server/ai/splitter';
import {
  extractItemsFromText,
  fallbackInterpretation,
  interpretSingleMemoryUnit,
  processThoughtCapturePipeline,
} from './server/ai/interpreter';
import {
  normalizeRoleName,
  extractPhoneNumber,
  readActiveRelationships,
  getActiveRelationshipByRole,
  getActiveRelationshipByPerson,
  saveUserEntity,
  saveRelationships,
  backfillStoredRelationships,
  deactivateUserRelationship,
  forgetUserEntity,
  correctUserRelationship,
  evaluateKnowledgeModification,
  enrichMemoryWithRelationship,
  detectAmbiguityInSavedMemories,
  mergeRelationshipsWithExtracted,
  resolveRelationshipsInQuery,
} from './server/relationships/index';
import {
  buildDynamicRetrievalContext,
  detectRequestedDaypartWindow,
  doesOccurrenceOverlapWindow,
  ASK_STOP_WORDS,
  RETRIEVAL_MONTHS,
  KNOWN_PLACE_KEYWORDS,
  DynamicRetrievalResult,
  RequestedTimeWindow,
} from './server/retrieval/dcr';
import { executeNativeRetrievalPipeline } from './server/retrieval/native_search';
import { executeArchitectureDRetrieval } from './server/retrieval/architecture_d';
import {
  initVapidKeys,
  dispatchDueReminders,
  startReminderDispatcherInterval,
} from './server/push/index';
import {
  readMemories,
  readMemoryById,
  insertMemories,
  toggleMemoryInDb,
  updateMemoryInDb,
  deleteMemoryFromDb,
  cleanupContaminatedOriginalTexts,
} from './server/db/memories';
import {
  readCalendarEvents,
  queryCalendarEvents,
  retrieveTargetedCalendarEvents,
  upsertCalendarEvents,
  deleteCalendarEventFromDb,
} from './server/calendar/store';
import {
  computeTodayRelevance,
  evaluateMemoryTodayLifecycle,
} from './server/today/relevance';

// Start background push dispatcher interval
startReminderDispatcherInterval(10000);

// -------------------------------------------------------------
// HEALTH CHECK API ENDPOINT
// -------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  const timestamp = new Date().toISOString();
  const checks: {
    database: { status: 'ok' | 'error'; latency_ms?: number; message?: string };
    gemini_config: { status: 'ok' | 'error'; configured: boolean };
  } = {
    database: { status: 'error' },
    gemini_config: { status: 'error', configured: false },
  };

  // 1. Check Gemini configuration without performing paid LLM generation
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
  checks.gemini_config = {
    status: hasGeminiKey ? 'ok' : 'error',
    configured: hasGeminiKey,
  };

  // 2. Check Bunny Database connectivity with minimal query
  const startDbTime = Date.now();
  try {
    const dbResult = await executeBunnySql([{ sql: 'SELECT 1 as health_check;' }]);
    const latency = Date.now() - startDbTime;
    if (dbResult && dbResult.length > 0 && dbResult[0]?.rows?.[0]?.health_check !== undefined) {
      checks.database = { status: 'ok', latency_ms: latency };
    } else {
      checks.database = { status: 'error', message: 'Unexpected query response from database' };
    }
  } catch (err: any) {
    checks.database = {
      status: 'error',
      message: 'Database query failed',
    };
  }

  const isHealthy = checks.database.status === 'ok' && checks.gemini_config.status === 'ok';
  const statusCode = isHealthy ? 200 : 503;

  return res.status(statusCode).json({
    status: isHealthy ? 'ok' : 'error',
    timestamp,
    checks,
  });
});

// -------------------------------------------------------------
// PUSH NOTIFICATION API ENDPOINTS
// -------------------------------------------------------------

// Serve Service Worker directly at root scope with required headers
app.get('/sw.js', (req, res) => {
  const swPath = path.join(process.cwd(), 'public', 'sw.js');
  if (fs.existsSync(swPath)) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(swPath);
  } else {
    res.status(404).send('Service worker not found');
  }
});

// Serve Web App Manifest
app.get(['/manifest.webmanifest', '/manifest.json'], (req, res) => {
  const manifestPath = path.join(process.cwd(), 'public', 'manifest.webmanifest');
  if (fs.existsSync(manifestPath)) {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(manifestPath);
  } else {
    res.status(404).send('Manifest not found');
  }
});

// GET /api/push/vapid-public-key
app.get('/api/push/vapid-public-key', async (req, res) => {
  try {
    const keys = await initVapidKeys();
    res.json({ publicKey: keys.publicKey });
  } catch (error) {
    console.error('Error providing VAPID public key:', error);
    res.status(500).json({ error: 'Failed to retrieve VAPID public key' });
  }
});

// POST /api/push/subscribe
app.post('/api/push/subscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ error: 'Valid push subscription object is required' });
  }

  try {
    await initBunnyDb();
    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys.p256dh;
    const auth = subscription.keys.auth;
    const userAgent = req.headers['user-agent'] || '';
    const nowIso = new Date().toISOString();

    await executeBunnySql([{
      sql: `INSERT INTO push_subscriptions (endpoint, p256dh, auth, userAgent, createdAt)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
              p256dh = excluded.p256dh,
              auth = excluded.auth,
              userAgent = excluded.userAgent;`,
      args: [endpoint, p256dh, auth, userAgent, nowIso]
    }]);

    console.log(`[Web Push] Successfully stored/refreshed subscription: ${endpoint.slice(-16)}`);
    res.status(201).json({ success: true, message: 'Push subscription saved successfully' });
  } catch (error) {
    console.error('Error storing push subscription:', error);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

// POST /api/push/test - Test push dispatch to current subscriber
app.post('/api/push/test', async (req, res) => {
  const { subscription, title, body } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ error: 'Subscription object required' });
  }

  try {
    await initVapidKeys();
    const pushSubscription = {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    };

    const payload = JSON.stringify({
      title: title || 'Ezzymigo Notification Test',
      body: body || 'Background and lock-screen reminders are active and ready!',
      id: 'test_notification_' + Date.now(),
      url: '/',
      timestamp: Date.now(),
    });

    await webpush.sendNotification(pushSubscription, payload);
    console.log(`[Web Push] Test notification sent successfully to endpoint ${subscription.endpoint.slice(-16)}`);
    res.json({ success: true, message: 'Test notification delivered successfully' });
  } catch (error: any) {
    console.error('Error sending test push notification:', error);
    res.status(500).json({
      error: 'Failed to send test push notification',
      details: error?.message || String(error)
    });
  }
});

// GET /api/push/status
app.get('/api/push/status', async (req, res) => {
  try {
    const keys = await initVapidKeys();
    const subsRes = await executeBunnySql([{
      sql: 'SELECT COUNT(*) as count FROM push_subscriptions;'
    }]);
    const count = subsRes[0]?.rows?.[0]?.count || 0;
    res.json({
      isConfigured: Boolean(keys.publicKey),
      subscriptionCount: count,
    });
  } catch (error) {
    res.json({ isConfigured: false, subscriptionCount: 0 });
  }
});

// -------------------------------------------------------------
// MEMORY API ROUTES
// -------------------------------------------------------------

app.get('/api/memories', async (req, res) => {
  try {
    const memories = await readMemories();
    res.json({ memories });
  } catch (error) {
    console.error('Error fetching memories:', error);
    res.status(500).json({ error: 'Failed to retrieve memories from database' });
  }
});

app.post('/api/memories', async (req, res) => {
  const rawInput = req.body?.originalText || req.body?.text;
  const { clientNow, clientTimeZone, clientLanguage, clientRegion, linkedEventId, subject } = req.body || {};

  if (!rawInput || typeof rawInput !== 'string' || !rawInput.trim()) {
    return res.status(400).json({ error: 'Original thought text is required' });
  }

  const trimmedText = rawInput.trim();
  console.log(`[API MEMORY WRITE] POST /api/memories - Received thought to save: "${trimmedText}" (lang: ${clientLanguage || 'en-AU'}, region: ${clientRegion || 'AU'}, linkedEventId: ${linkedEventId || 'none'}, subject: ${subject || 'none'})`);
  const localContext = formatLocalTimeContext(clientNow, clientTimeZone, clientLanguage, clientRegion);
  const ai = getGeminiClient();

  try {
    const { memories: newMemories } = await processThoughtCapturePipeline(trimmedText, localContext, ai, linkedEventId, subject);

    // Initial phoneOffer computation from newMemories (deterministic in-memory)
    let phoneOffer: { person: string; role: string } | null = null;
    const extractedRelationships = newMemories.flatMap(m => m.interpretation?.relationships || []);
    for (const m of newMemories) {
      const itemRels = m.interpretation?.relationships || [];
      if (itemRels.length > 0) {
        const textToScan = m.originalText || trimmedText;
        const { phoneNumber } = extractPhoneNumber(textToScan);
        if (!phoneNumber && !phoneOffer) {
          const activeRel = itemRels.find(r => r && r.person && r.role && r.is_active !== false);
          if (activeRel) {
            phoneOffer = { person: activeRel.person, role: activeRel.role };
          }
        }
      }
    }

    // Persist relationships & entity metadata asynchronously where present
    const persistRelationshipsPromise = (async () => {
      if (extractedRelationships.length === 0) return;
      for (const m of newMemories) {
        const itemRels = m.interpretation?.relationships || [];
        if (itemRels.length > 0) {
          const textToScan = m.originalText || trimmedText;
          const { phoneNumber } = extractPhoneNumber(textToScan);
          if (phoneNumber) {
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
          }
        }
      }
      await saveRelationships(extractedRelationships);
    })();

    // Phase A Tell Concurrency:
    // 1. insertMemories writes memories and scheduled reminders
    // 2. persistRelationshipsPromise writes relationships and entities
    // 3. readMemories pre-loads historical memories for ambiguity detection
    // 4. readActiveRelationships loads pre-existing active relationships
    const [insertResult, _relResult, historicalMemories, currentActiveRelationships] = await Promise.all([
      insertMemories(newMemories, { skipRelationshipSave: true }),
      persistRelationshipsPromise,
      readMemories(),
      readActiveRelationships(),
    ]);

    if (!phoneOffer && insertResult?.phoneOffer) {
      phoneOffer = insertResult.phoneOffer;
    }

    // In-Memory Relationship Merge (0 ms DB wait):
    // Merge pre-existing active relationships with newly extracted relationships from this request
    const activeRelationships = mergeRelationshipsWithExtracted(currentActiveRelationships, extractedRelationships);

    // Synchronous Ambiguity Detection with pre-loaded historical memories (0 ms DB wait):
    const clarification = await detectAmbiguityInSavedMemories(
      newMemories,
      activeRelationships,
      trimmedText,
      ai,
      historicalMemories
    );

    // Prioritise resolving who the person is first: if ambiguity clarification exists, suppress phone offer
    if (clarification) {
      phoneOffer = null;
    }

    return res.status(201).json({
      memory: newMemories[0],
      memories: newMemories,
      clarification: clarification || null,
      phoneOffer: phoneOffer || null,
    });
  } catch (err: any) {
    console.error('Error in capture & save pipeline:', err);
    return res.status(500).json({ error: 'Failed to save memories to database' });
  }
});

// -------------------------------------------------------------
// NON-PERSISTING TEST & INTERPRETATION PIPELINE
// Runs the exact same production splitter & interpreter logic,
// but does NOT perform any database INSERT or mutation.
// -------------------------------------------------------------
const handleNonPersistingInterpret = async (req: express.Request, res: express.Response) => {
  const { originalText, text, clientNow, clientTimeZone, clientLanguage, clientRegion, linkedEventId, subject } = req.body;
  const rawInput = originalText || text;

  if (!rawInput || typeof rawInput !== 'string' || !rawInput.trim()) {
    return res.status(400).json({ error: 'Original thought text is required' });
  }

  const trimmedText = rawInput.trim();
  console.log(`[TEST/PREVIEW PIPELINE - NON-PERSISTING] Interpreting thought: "${trimmedText}" (subject: ${subject || 'none'})`);
  const localContext = formatLocalTimeContext(clientNow, clientTimeZone, clientLanguage, clientRegion);
  const ai = getGeminiClient();

  try {
    const { splitUnits, memories } = await processThoughtCapturePipeline(trimmedText, localContext, ai, linkedEventId, subject);
    return res.status(200).json({
      success: true,
      splitUnits,
      memories,
      memory: memories[0] || null,
      count: memories.length,
      persisted: false,
    });
  } catch (err: any) {
    console.error('Error in non-persisting interpretation pipeline:', err);
    return res.status(500).json({ error: 'Failed to process interpretation pipeline' });
  }
};

app.post('/api/memories/test-interpret', handleNonPersistingInterpret);
app.post('/api/interpret-preview', handleNonPersistingInterpret);

// -------------------------------------------------------------
// CLARIFICATIONS API (EZZYMIGO AMBIGUITY RULE)
// -------------------------------------------------------------

app.post('/api/clarifications/resolve', async (req, res) => {
  try {
    const { clarificationId, entityName, entityType, answer, candidateChosen, memoryId, metadata, clientNow, clientTimeZone, clientLanguage, clientRegion } = req.body;

    if (!entityName || typeof entityName !== 'string') {
      return res.status(400).json({ error: 'entityName is required' });
    }

    const trimmedEntity = entityName.trim();
    const rawAnswer = (candidateChosen || answer || '').trim();

    if (!rawAnswer) {
      return res.status(400).json({ error: 'Answer is required to resolve clarification' });
    }

    console.log(`[Ambiguity Rule] Resolving clarification (type: ${entityType || 'person/rel'}) for "${trimmedEntity}" with answer: "${rawAnswer}" (memoryId: ${memoryId || 'none'})`);

    // -------------------------------------------------------------
    // TEMPORAL CLARIFICATION (Time Meridiem AM/PM resolution)
    // -------------------------------------------------------------
    if (entityType === 'time_meridiem' || (metadata && metadata.hour !== undefined) || (memoryId && (/^\d{1,2}(?::\d{2})?$/i.test(trimmedEntity) || /o'?clock|heures?|uhr/i.test(trimmedEntity)) && /(?:am|pm|morning|afternoon|evening|night|matin|après-midi|soir|mañana|tarde|noche|morgens|nachmittags|abends|mattino|pomeriggio|sera|manhã|da tarde|noite|上午|下午|晚上|午前|午後|夕方|\d{1,2}:\d{2})/i.test(rawAnswer))) {
      // Determine if PM vs AM across languages and 24-hour format
      let isPm = /pm|p\.m\.|afternoon|evening|night|après-midi|soir|tarde|noche|nachmittags|abends|pomeriggio|sera|da tarde|noite|下午|晚上|午后|午後|夕方/i.test(rawAnswer);
      
      // Check 24-hour notation in answer (e.g. "16:00" or "16h")
      const match24 = rawAnswer.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
      if (match24) {
        const h24 = parseInt(match24[1], 10);
        if (h24 >= 12) isPm = true;
        else isPm = false;
      }

      const meridiem: 'am' | 'pm' = isPm ? 'pm' : 'am';

      let hour = metadata?.hour;
      let minute = metadata?.minute || 0;

      if (hour === undefined || hour === null) {
        const hMatch = rawAnswer.match(/(\d{1,2})(?::(\d{2}))?/);
        if (hMatch) {
          hour = parseInt(hMatch[1], 10);
          if (hour > 12) hour -= 12;
          minute = hMatch[2] ? parseInt(hMatch[2], 10) : 0;
        } else {
          const entMatch = trimmedEntity.match(/(\d{1,2})(?::(\d{2}))?/);
          if (entMatch) {
            hour = parseInt(entMatch[1], 10);
            if (hour > 12) hour -= 12;
            minute = entMatch[2] ? parseInt(entMatch[2], 10) : 0;
          }
        }
      }

      if (hour === undefined || hour === null) {
        return res.status(400).json({ error: 'Could not determine hour for time clarification' });
      }

      const allStored = await readMemories();
      const targetMemory = allStored.find((m: any) => m.id === memoryId);
      if (!targetMemory) {
        return res.status(404).json({ error: `Memory with ID ${memoryId} not found` });
      }

      const localContext = formatLocalTimeContext(clientNow, clientTimeZone, clientLanguage, clientRegion);
      const targetDate = metadata?.targetDate || getYMDInTz(localContext.referenceDate, localContext.timeZone);
      const offsetStr = metadata?.offsetStr || localContext.offsetStr;

      const resolvedIso = resolveAmbiguousTimeToIso(targetDate, hour, minute, meridiem, offsetStr);
      const formattedTiming = formatTimingWithResolvedMeridiem(
        targetMemory.interpretation.resurfacing?.timing || targetMemory.interpretation.original_time_expression || '',
        hour,
        minute,
        meridiem
      );

      const updatedInterpretation = {
        ...targetMemory.interpretation,
        resolved_datetime: resolvedIso,
        reminder_datetime: resolvedIso,
        resurfacing: {
          mode: 'date_based',
          timing: formattedTiming,
        },
        temporal_ambiguity: null,
      };

      const updatedMemory = await updateMemoryInDb(targetMemory.id, updatedInterpretation);

      // Ensure scheduled_reminders has exactly one notification
      await initBunnyDb();
      await executeBunnySql([
        {
          sql: 'DELETE FROM scheduled_reminders WHERE memoryId = ?;',
          args: [targetMemory.id]
        },
        {
          sql: `INSERT INTO scheduled_reminders (id, memoryId, title, body, remindAt, notified, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?);`,
          args: [
            `remind_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            targetMemory.id,
            'Ezzymigo Reminder',
            targetMemory.interpretation.content,
            new Date(resolvedIso).toISOString(),
            0,
            new Date().toISOString(),
          ]
        }
      ]);

      console.log(`[Ambiguity Rule] Resolved time clarification for memory "${targetMemory.id}": ${resolvedIso} (${formattedTiming})`);

      return res.json({
        success: true,
        message: `Scheduled reminder for ${formattedTiming}.`,
        memory: updatedMemory,
      });
    }

    // Extract phone number from rawAnswer if present, to avoid corrupting role/person regex matching
    const { phoneNumber: extractedPhone, cleanedText } = extractPhoneNumber(rawAnswer);
    const isPhoneOffer = entityType === 'phone_offer' || metadata?.isPhoneOffer === true;
    const phoneToSave = extractedPhone || (isPhoneOffer && rawAnswer.replace(/[^\d+]/g, '').length >= 6 ? rawAnswer.trim() : null);
    const textToParse = cleanedText || rawAnswer;

    let resolvedPerson = trimmedEntity;
    let resolvedRole = (metadata && metadata.role) ? metadata.role : textToParse;

    if (!metadata?.role) {
      // Check for "X is my Y" / "X is the Y" / "X is a Y"
      const isMyMatch = textToParse.match(/^(?:([A-Za-z0-9\s]+?)\s+is\s+(?:my\s+|the\s+|a\s+|an\s+)?|he['’]?s\s+(?:my\s+|the\s+|a\s+|an\s+)?|she['’]?s\s+(?:my\s+|the\s+|a\s+|an\s+)?|they['’]?re\s+(?:my\s+|the\s+|a\s+|an\s+)?|my\s+)([A-Za-z0-9\s]+?)[.!]?$/i);

      if (textToParse.includes('—')) {
        const parts = textToParse.split('—').map((s: string) => s.trim());
        resolvedPerson = parts[0] || trimmedEntity;
        resolvedRole = parts[1] || '';
      } else if (textToParse.includes('-')) {
        const parts = textToParse.split('-').map((s: string) => s.trim());
        resolvedPerson = parts[0] || trimmedEntity;
        resolvedRole = parts[1] || '';
      } else if (isMyMatch) {
        if (isMyMatch[1] && isMyMatch[1].trim() && !['he', 'she', 'they', 'it'].includes(isMyMatch[1].trim().toLowerCase())) {
          resolvedPerson = isMyMatch[1].trim();
        } else {
          resolvedPerson = trimmedEntity;
        }
        resolvedRole = isMyMatch[2] ? isMyMatch[2].trim() : isMyMatch[1].trim();
      } else {
        const normalizedEntity = normalizeRoleName(trimmedEntity);
        const commonRoles = ['sister', 'brother', 'son', 'daughter', 'doctor', 'physio', 'plumber', 'electrician', 'mechanic', 'dentist', 'boss', 'wife', 'husband', 'accountant', 'lawyer', 'neighbour', 'neighbor', 'friend', 'mother', 'father', 'mum', 'dad'];
        if (commonRoles.includes(normalizedEntity)) {
          resolvedPerson = textToParse;
          resolvedRole = trimmedEntity;
        } else {
          resolvedPerson = trimmedEntity;
          resolvedRole = textToParse;
        }
      }
    }

    resolvedRole = normalizeRoleName(resolvedRole);

    // 1. Save relationship
    await saveRelationships([{
      person: resolvedPerson,
      role: resolvedRole,
      is_active: true,
    }]);

    // 2. Save user entity with structured metadata
    const entityMetadata: Record<string, any> = phoneToSave ? { phone: phoneToSave } : {};
    await saveUserEntity({
      name: resolvedPerson,
      entity_type: 'person',
      role: resolvedRole,
      normalized_role: normalizeRoleName(resolvedRole),
      metadata: entityMetadata,
    });

    const phoneSuffix = phoneToSave ? ` — ${phoneToSave}` : '';

    const retrievalCues = [
      resolvedPerson.toLowerCase(),
      resolvedRole.toLowerCase(),
      `${resolvedPerson.toLowerCase()} (${resolvedRole.toLowerCase()})`,
      `my ${resolvedRole.toLowerCase()}`,
      `${resolvedPerson.toLowerCase()} is my ${resolvedRole.toLowerCase()}`,
    ];
    if (phoneToSave) {
      retrievalCues.push(
        phoneToSave.toLowerCase(),
        `${resolvedPerson.toLowerCase()} phone`,
        `${resolvedPerson.toLowerCase()} phone number`,
        `${resolvedRole.toLowerCase()} phone`,
        `${resolvedRole.toLowerCase()} phone number`,
        `${resolvedPerson.toLowerCase()} ${phoneToSave.toLowerCase()}`
      );
    }

    if (memoryId && isPhoneOffer) {
      const allStored = await readMemories();
      const targetMemory = allStored.find((m: any) => m.id === memoryId);
      if (targetMemory) {
        const updatedContent = phoneToSave && !targetMemory.interpretation.content.includes(phoneToSave)
          ? `${targetMemory.interpretation.content}${phoneSuffix}`
          : targetMemory.interpretation.content;

        const existingCues = Array.isArray(targetMemory.interpretation.retrieval_cues)
          ? targetMemory.interpretation.retrieval_cues
          : [];
        const newCues = retrievalCues.filter(c => !existingCues.includes(c));

        const updatedInterpretation = {
          ...targetMemory.interpretation,
          content: updatedContent,
          retrieval_cues: [...existingCues, ...newCues],
        };

        const updatedMem = await updateMemoryInDb(targetMemory.id, updatedInterpretation, updatedContent);

        return res.json({
          success: true,
          message: `Saved ${resolvedPerson}'s phone number.`,
          relationship: {
            person: resolvedPerson,
            role: resolvedRole,
            normalized_role: normalizeRoleName(resolvedRole),
          },
          memory: updatedMem,
        });
      }
    }

    // 3. Create user-visible FACT memory card representing this explicit user-supplied knowledge
    const factContent = phoneToSave
      ? `${resolvedPerson} is my ${resolvedRole} — ${phoneToSave}`
      : `${resolvedPerson} is my ${resolvedRole}`;
    const factMemoryId = `mem_${Date.now()}_0_${Math.random().toString(36).substring(2, 9)}`;
    const nowIso = new Date().toISOString();

    const factMemory = {
      id: factMemoryId,
      originalText: phoneToSave
        ? `${resolvedPerson} is my ${resolvedRole} — ${phoneToSave}`
        : `${resolvedPerson} is my ${resolvedRole}`,
      createdAt: nowIso,
      isDone: false,
      interpretation: {
        content: factContent,
        kind: 'fact',
        intent: 'remember',
        status: 'active',
        people: [resolvedPerson],
        places: [],
        topics: ['relationship', resolvedRole, 'contact', extractedPhone ? 'phone' : null].filter(Boolean) as string[],
        contexts: ['personal'],
        retrieval_cues: retrievalCues,
        items: [],
        relationships: [{
          person: resolvedPerson,
          role: resolvedRole,
          is_active: true,
        }],
        prerequisite: null,
        original_time_expression: null,
        resolved_datetime: null,
        event_time_expression: null,
        event_datetime: null,
        reminder_time_expression: null,
        reminder_datetime: null,
        resurfacing: {
          mode: 'none',
          timing: 'Unscheduled',
        },
        suggested_action: null,
        subject: null,
      },
    };

    await insertMemories([factMemory]);

    const phoneOffer = (!phoneToSave && !isPhoneOffer && resolvedPerson && resolvedRole)
      ? { person: resolvedPerson, role: resolvedRole }
      : null;

    return res.json({
      success: true,
      message: `Learned: ${resolvedPerson} is your ${resolvedRole}.`,
      relationship: {
        person: resolvedPerson,
        role: resolvedRole,
        normalized_role: normalizeRoleName(resolvedRole),
      },
      memory: factMemory,
      phoneOffer: phoneOffer || null,
    });
  } catch (err: any) {
    console.error('[Ambiguity Rule] Error resolving clarification:', err);
    return res.status(500).json({ error: 'Failed to resolve clarification' });
  }
});

app.put('/api/memories/:id', async (req, res) => {
  const { id } = req.params;
  const { editedText, clientNow, clientTimeZone, clientLanguage, clientRegion } = req.body;

  if (!editedText || typeof editedText !== 'string' || !editedText.trim()) {
    return res.status(400).json({ error: 'Edited memory content is required' });
  }

  const trimmedText = editedText.trim();
  console.log(`[API MEMORY EDIT] PUT /api/memories/${id} - Re-interpreting edited memory: "${trimmedText}" (lang: ${clientLanguage || 'en-AU'}, region: ${clientRegion || 'AU'})`);
  const localContext = formatLocalTimeContext(clientNow, clientTimeZone, clientLanguage, clientRegion);
  const ai = getGeminiClient();

  try {
    const oldMemory = await readMemoryById(id);

    // Re-run the exact same interpretation and metadata extraction pipeline
    const newInterpretation = await interpretSingleMemoryUnit(trimmedText, trimmedText, localContext, ai);
    const updatedMemory = await updateMemoryInDb(id, newInterpretation, trimmedText);

    if (!updatedMemory) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    // Check for relationships that were removed or changed during the edit
    const oldRelationships = (oldMemory && Array.isArray(oldMemory.interpretation?.relationships))
      ? oldMemory.interpretation.relationships
      : [];
    const newRelationships = Array.isArray(newInterpretation.relationships)
      ? newInterpretation.relationships
      : [];

    for (const oldRel of oldRelationships) {
      if (!oldRel || !oldRel.person || !oldRel.role) continue;
      const oldP = oldRel.person.trim();
      const oldR = oldRel.role.trim();
      const oldNormR = normalizeRoleName(oldR);

      const stillPresentInNew = newRelationships.some((newRel: any) =>
        newRel &&
        newRel.person?.toLowerCase() === oldP.toLowerCase() &&
        normalizeRoleName(newRel.role) === oldNormR &&
        newRel.is_active !== false
      );

      if (!stillPresentInNew) {
        console.log(`[Relationships] Deactivating old relationship due to memory edit: ${oldP} <-> ${oldR}`);
        await deactivateUserRelationship(oldP, oldR);
      }
    }

    let phoneOffer: { person: string; role: string } | null = (updatedMemory as any)?.phoneOffer || null;

    // Persist new/updated relationships
    if (newRelationships.length > 0) {
      const { phoneNumber } = extractPhoneNumber(trimmedText);
      if (phoneNumber) {
        for (const rel of newRelationships) {
          if (rel && rel.person && rel.role && rel.is_active !== false) {
            await saveUserEntity({
              name: rel.person,
              entity_type: 'person',
              role: rel.role,
              normalized_role: normalizeRoleName(rel.role),
              metadata: { phone: phoneNumber },
            });
          }
        }
      } else if (!phoneOffer) {
        const activeRel = newRelationships.find((r: any) => r && r.person && r.role && r.is_active !== false);
        if (activeRel) {
          phoneOffer = { person: activeRel.person, role: activeRel.role };
        }
      }
      await saveRelationships(newRelationships);
    }

    console.log(`[API MEMORY EDIT] Successfully updated memory ${id} with refreshed metadata. People:`, updatedMemory.interpretation?.people);
    return res.json({ memory: updatedMemory, phoneOffer: phoneOffer || null });
  } catch (err: any) {
    console.error('Error updating memory:', err);
    return res.status(500).json({ error: 'Failed to re-interpret and update memory' });
  }
});

app.patch('/api/memories/:id/toggle', async (req, res) => {
  const { id } = req.params;
  try {
    const updated = await toggleMemoryInDb(id);
    if (!updated) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    return res.json({ memory: updated });
  } catch (error) {
    console.error('Error toggling memory:', error);
    return res.status(500).json({ error: 'Failed to toggle memory status' });
  }
});

app.delete('/api/memories/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const memoryToDelete = await readMemoryById(id);
    await deleteMemoryFromDb(id);

    // If the deleted memory asserted relationships, synchronize/deactivate them
    // so Ezzymigo no longer holds the relationship unless another active fact memory still asserts it.
    if (memoryToDelete && Array.isArray(memoryToDelete.interpretation?.relationships)) {
      const rels = memoryToDelete.interpretation.relationships;
      if (rels.length > 0) {
        const remainingMemories = await readMemories();
        for (const rel of rels) {
          if (!rel || !rel.person || !rel.role) continue;
          const p = rel.person.trim();
          const r = rel.role.trim();
          const normR = normalizeRoleName(r);

          const isStillAssertedInOtherMemory = remainingMemories.some(m => {
            if (m.id === id) return false;
            const mRels = m.interpretation?.relationships;
            if (!Array.isArray(mRels)) return false;
            return mRels.some((otherRel: any) =>
              otherRel &&
              otherRel.person?.toLowerCase() === p.toLowerCase() &&
              normalizeRoleName(otherRel.role) === normR &&
              otherRel.is_active !== false
            );
          });

          if (!isStillAssertedInOtherMemory) {
            console.log(`[Relationships] Deactivating relationship for deleted memory: ${p} <-> ${r}`);
            await deactivateUserRelationship(p, r);
          }
        }
      }
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting memory:', error);
    return res.status(500).json({ error: 'Failed to delete memory' });
  }
});

app.delete('/api/lists', async (req, res) => {
  const { subject } = req.body;
  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ error: 'List subject name is required' });
  }

  const targetSubject = subject.trim();
  console.log(`[API LIST DELETE] DELETE /api/lists - Target subject: "${targetSubject}"`);

  try {
    const allMemories = await readMemories();
    const memoriesToDelete = allMemories.filter(
      (m) => m.interpretation?.subject?.trim().toLowerCase() === targetSubject.toLowerCase()
    );

    if (memoriesToDelete.length === 0) {
      return res.json({ success: true, count: 0, deletedIds: [] });
    }

    const deletedIds = memoriesToDelete.map((m) => m.id);

    // Delete each memory and its scheduled reminders
    for (const mem of memoriesToDelete) {
      await deleteMemoryFromDb(mem.id);
    }

    // Collect relationships asserted by deleted memories
    const relsToCheck: Array<{ person: string; role: string }> = [];
    for (const mem of memoriesToDelete) {
      if (Array.isArray(mem.interpretation?.relationships)) {
        for (const rel of mem.interpretation.relationships) {
          if (rel && rel.person && rel.role) {
            relsToCheck.push({ person: rel.person.trim(), role: rel.role.trim() });
          }
        }
      }
    }

    // Safeguard relationships if not asserted elsewhere in remaining memories
    if (relsToCheck.length > 0) {
      const remainingMemories = await readMemories();
      for (const rel of relsToCheck) {
        const p = rel.person;
        const r = rel.role;
        const normR = normalizeRoleName(r);

        const isStillAssertedInOtherMemory = remainingMemories.some((m) => {
          const mRels = m.interpretation?.relationships;
          if (!Array.isArray(mRels)) return false;
          return mRels.some(
            (otherRel: any) =>
              otherRel &&
              otherRel.person?.toLowerCase() === p.toLowerCase() &&
              normalizeRoleName(otherRel.role) === normR &&
              otherRel.is_active !== false
          );
        });

        if (!isStillAssertedInOtherMemory) {
          console.log(`[Relationships] Deactivating relationship for deleted list items: ${p} <-> ${r}`);
          await deactivateUserRelationship(p, r);
        }
      }
    }

    console.log(`[API LIST DELETE] Successfully deleted ${memoriesToDelete.length} memories for list "${targetSubject}"`);
    return res.json({ success: true, count: memoriesToDelete.length, deletedIds });
  } catch (error) {
    console.error('Error deleting list memories:', error);
    return res.status(500).json({ error: 'Failed to delete list memories' });
  }
});

// -------------------------------------------------------------
// EXTERNAL WEB LOOKUP & VERIFICATION PIPELINE
// -------------------------------------------------------------

app.post('/api/memories/:id/lookup', async (req, res) => {
  const { id } = req.params;
  const { query, memoryContent, clientRegion = 'AU', clientLanguage = 'en-AU' } = req.body;

  const searchQuery = (query && typeof query === 'string' ? query.trim() : '') ||
                      (memoryContent && typeof memoryContent === 'string' ? memoryContent.trim() : '');

  console.log(`[API LOOKUP] POST /api/memories/${id}/lookup - Query: "${searchQuery}" (region: ${clientRegion}, lang: ${clientLanguage})`);

  if (!searchQuery) {
    return res.status(400).json({ error: 'Search query or memory content is required' });
  }

  const ai = getGeminiClient();
  if (!ai) {
    return res.json({
      lookup: {
        summary: `Search query: "${searchQuery}". (Configure GEMINI_API_KEY for live grounded search results).`,
        sources: [],
        verified: false,
        correction: null,
      },
    });
  }

  try {
    const regionalGuidance = clientRegion === 'AU'
      ? 'Prefer Australian retailers/sources/services (e.g. Booktopia, Dymocks, Angus & Robertson, Readings, QBD Books, Amazon AU, ABC iview, SBS On Demand, Stan, local merchants/venues) where appropriate.'
      : `Prefer relevant retailers/sources/services operating in region "${clientRegion}" where appropriate.`;

    const lookupPrompt = `You are performing a user-requested external web search for an Ezzymigo memory item.

User Memory Context: "${memoryContent || searchQuery}"
Search Query: "${searchQuery}"
User Operating Region: "${clientRegion}" (Language: "${clientLanguage}")

Instructions:
1. Search Google for accurate, up-to-date information matching what the user was looking for (e.g. books, movies/TV, streaming services, products, restaurants, venues, events/tickets, services).
2. Identify the accurate item title and creator/author/director/merchant/organization where applicable.
3. Extract useful, direct destination results (retailers, product pages, bookstores, publisher sites, streaming platforms, official ticketing/booking pages) found by Google Search grounding.
   - ${regionalGuidance}
   - Merchant/Source name: Identify each merchant or platform clearly (e.g. "Booktopia", "Dymocks", "Hardie Grant Publishing", "Botanic Gardens of Sydney").
   - Clickable Link / URL: Provide the actual URL or search grounding redirect link returned by Google Search grounding. STRICT RULE: NEVER invent, fabricate, or guess URLs. Only supply genuine URLs provided by Google Search.
   - Price: Include the price if reliably and clearly found in search results (e.g. "$29.99 AUD", "$36.99 AUD") or null if unavailable.
   - Availability: State the availability status if found (e.g. "Available", "Pre-order", "In Stock", "Out of Stock") or null if unavailable.
   - Action Type: "purchase" | "view" | "stream" | "book" | "info".
4. Provide a concise, friendly 1 to 2 sentence explanatory summary.
5. Check for any entity, title, author, or spelling discrepancies between the user's stored memory context and verified web results (e.g. if the user wrote "Vanessa Fooks" instead of "Vanessa Fuchs", or a slightly misspelled title/product).
6. If a correction is detected, provide structured correction details so the user can easily update their memory with the accurate wording.
7. STRICT RULE: Do NOT attempt or simulate any financial transactions or purchases.

Provide your response strictly in the following JSON format:
\`\`\`json
{
  "item_title": "Verified Title or Item Name",
  "creator": "Author, Creator, Director, or Organization (or null if not applicable)",
  "category": "book",
  "summary": "Concise 1-2 sentence summary of search findings.",
  "actionable_results": [
    {
      "title": "What the Flora? by Vanessa Fuchs",
      "source_name": "Booktopia",
      "url": "https://...",
      "price": "$29.99 AUD",
      "availability": "Available / Pre-order",
      "action_type": "purchase"
    }
  ],
  "verified": true,
  "correction": null
}
\`\`\`
Or if an entity / name / title / spelling discrepancy was identified:
\`\`\`json
{
  "item_title": "What the Flora?: Incredible Stories from the Brilliant and Bizarre World of Plants",
  "creator": "Vanessa Fuchs",
  "category": "book",
  "summary": "Written by science communicator Vanessa Fuchs for the Botanic Gardens of Sydney, exploring the fascinating world of botany.",
  "actionable_results": [
    {
      "title": "What the Flora? by Vanessa Fuchs",
      "source_name": "Dymocks",
      "url": "https://...",
      "price": "$36.99 AUD",
      "availability": "Available / Pre-order",
      "action_type": "purchase"
    }
  ],
  "verified": true,
  "correction": {
    "field": "author",
    "current_value": "Vanessa Fooks",
    "suggested_value": "Vanessa Fuchs",
    "full_corrected_text": "Purchase the book 'What the Flora' by Vanessa Fuchs.",
    "explanation": "I found this author listed as Vanessa Fuchs."
  }
}
\`\`\``;

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: lookupPrompt,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.1,
      },
    });

    // Extract grounding web sources from metadata
    const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const groundingSources: Array<{ title: string; url: string }> = [];
    if (Array.isArray(rawChunks)) {
      for (const chunk of rawChunks) {
        if (chunk.web?.uri) {
          try {
            const parsedUrl = new URL(chunk.web.uri);
            const displayTitle = chunk.web.title || parsedUrl.hostname.replace(/^www\./, '');
            groundingSources.push({
              title: displayTitle,
              url: chunk.web.uri,
            });
          } catch {
            groundingSources.push({
              title: chunk.web.title || 'Web Source',
              url: chunk.web.uri,
            });
          }
        }
      }
    }

    let lookupData: any = {
      item_title: null,
      creator: null,
      category: null,
      summary: response.text || 'No search results available.',
      actionable_results: [],
      sources: [],
      verified: true,
      correction: null,
    };

    if (response.text) {
      try {
        const cleaned = response.text.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (parsed && typeof parsed === 'object') {
          lookupData.item_title = parsed.item_title || null;
          lookupData.creator = parsed.creator || null;
          lookupData.category = parsed.category || null;
          lookupData.summary = parsed.summary || response.text;
          lookupData.verified = parsed.verified !== undefined ? Boolean(parsed.verified) : true;

          if (Array.isArray(parsed.actionable_results)) {
            lookupData.actionable_results = parsed.actionable_results
              .filter((item: any) => item && typeof item === 'object')
              .map((item: any) => {
                let validUrl = typeof item.url === 'string' && item.url.startsWith('http') ? item.url : '';
                
                // If URL is missing or placeholder, attempt match with grounding source
                if (!validUrl && groundingSources.length > 0) {
                  const match = groundingSources.find(
                    (s) => s.title.toLowerCase().includes((item.source_name || '').toLowerCase()) ||
                           (item.source_name || '').toLowerCase().includes(s.title.toLowerCase())
                  );
                  if (match) {
                    validUrl = match.url;
                  }
                }

                return {
                  title: item.title || item.source_name || 'View Item',
                  source_name: item.source_name || 'Retailer / Source',
                  url: validUrl,
                  price: item.price || null,
                  availability: item.availability || null,
                  action_type: item.action_type || 'view',
                };
              });
          }

          if (parsed.correction && typeof parsed.correction === 'object' && parsed.correction.full_corrected_text) {
            lookupData.correction = {
              field: parsed.correction.field || 'entity',
              current_value: parsed.correction.current_value || '',
              suggested_value: parsed.correction.suggested_value || '',
              full_corrected_text: parsed.correction.full_corrected_text,
              explanation: parsed.correction.explanation || `I found this listed as ${parsed.correction.suggested_value || 'a different name'}.`,
            };
          }
        }
      } catch {
        lookupData.summary = response.text.replace(/```json[\s\S]*?```/gi, '').trim() || response.text;
      }
    }

    // If actionable_results is empty but we have grounding sources, construct actionable results from grounding
    if ((!lookupData.actionable_results || lookupData.actionable_results.length === 0) && groundingSources.length > 0) {
      lookupData.actionable_results = groundingSources.slice(0, 4).map((src) => ({
        title: src.title,
        source_name: src.title,
        url: src.url,
        price: null,
        availability: 'Available online',
        action_type: 'view',
      }));
    }

    lookupData.sources = groundingSources.slice(0, 4);

    return res.json({ lookup: lookupData });
  } catch (err: any) {
    console.error('Error during memory lookup:', err);
    return res.status(500).json({ error: 'Failed to perform web lookup' });
  }
});

// -------------------------------------------------------------
// Calendar Events API Endpoints (Isolated Storage Layer)
// -------------------------------------------------------------

// GET /api/calendar-events - List stored external calendar events
app.get('/api/calendar-events', async (req, res) => {
  try {
    const { startAfter, startBefore, limit } = req.query;
    const events = await readCalendarEvents({
      startAfter: typeof startAfter === 'string' ? startAfter : undefined,
      startBefore: typeof startBefore === 'string' ? startBefore : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return res.json({ events });
  } catch (err: any) {
    console.error('Error fetching calendar events:', err);
    return res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// POST /api/calendar-events/sync - Save a batch of synced calendar events
app.post('/api/calendar-events/sync', async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'Expected an array of events' });
    }

    await upsertCalendarEvents(events);
    const stored = await readCalendarEvents();
    return res.json({ success: true, count: events.length, events: stored });
  } catch (err: any) {
    console.error('Error syncing calendar events:', err);
    return res.status(500).json({ error: 'Failed to save calendar events' });
  }
});

// GET /api/relationships - List current active user relationships
app.get('/api/relationships', async (req, res) => {
  try {
    const relationships = await readActiveRelationships();
    return res.json({ relationships });
  } catch (err: any) {
    console.error('Error fetching relationships:', err);
    return res.status(500).json({ error: 'Failed to fetch relationships' });
  }
});

// POST /api/relationships/forget - Direct endpoint to forget an entity or relationship
app.post('/api/relationships/forget', async (req, res) => {
  try {
    const { person, role } = req.body;
    if (!person || typeof person !== 'string' || !person.trim()) {
      return res.status(400).json({ error: 'Person name is required' });
    }
    const p = person.trim();
    if (role && typeof role === 'string' && role.trim()) {
      const result = await deactivateUserRelationship(p, role.trim());
      return res.json({ success: true, person: p, role: role.trim(), ...result });
    } else {
      const success = await forgetUserEntity(p);
      return res.json({ success, person: p });
    }
  } catch (err: any) {
    console.error('Error forgetting relationship/entity:', err);
    return res.status(500).json({ error: 'Failed to forget knowledge' });
  }
});

// POST /api/relationships/backfill - Idempotent sync of relationships from stored memories
app.post('/api/relationships/backfill', async (req, res) => {
  try {
    await backfillStoredRelationships();
    const relationships = await readActiveRelationships();
    return res.json({ success: true, count: relationships.length, relationships });
  } catch (err: any) {
    console.error('Error backfilling relationships:', err);
    return res.status(500).json({ error: 'Failed to backfill relationships' });
  }
});

const askResponseSchema = {
  type: Type.OBJECT,
  properties: {
    answer: {
      type: Type.STRING,
      description: "The concise, natural-language, helpful answer (1-3 sentences) in the user's language based on the user's personal knowledge (memories, calendar, relationships, lists). If general knowledge, web search, shopping, current news, general advice, or unrelated chatbot assistance is requested, briefly and conversationally explain that Ezzy works with the user's personal information rather than being a general search engine (vary wording naturally). If personal knowledge was sought but not found, state that you couldn't find anything in saved memories or calendar.",
    },
    is_out_of_scope: {
      type: Type.BOOLEAN,
      description: "Set to true if the question was asking for general knowledge, internet search, product shopping, current news, general advice, or unrelated chatbot assistance outside the user's personal stored data.",
    },
    memory_ids: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "MANDATORY: Array containing the exact string 'id' of every stored memory in 'User's Stored Intention Memories' that materially supported, answered, or is referenced by the answer. If no memories were used, relevant, or if out-of-scope, return [].",
    },
    calendar_event_ids: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Array containing the exact string 'id' of every imported calendar event in 'User's Imported Calendar Events' that materially supported the answer. If no calendar events were used, relevant, or if out-of-scope, return [].",
    },
  },
  required: ['answer', 'memory_ids', 'calendar_event_ids'],
};

// POST /api/ask - Ask Ezzymigo retrieval endpoint
app.post('/api/ask', async (req, res) => {
  try {
    const { question, clientNow, clientTimeZone, clientLanguage, clientRegion, confirm } = req.body;
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const trimmedQuestion = question.trim();
    console.log(`[API ASK] POST /api/ask - Query: "${trimmedQuestion}" (lang: ${clientLanguage || 'en-AU'}, region: ${clientRegion || 'AU'}, confirm: ${Boolean(confirm)})`);

    // Phase A: Concurrent database retrieval for relationships, memories, and calendar events
    const [activeRelationships, memories, calendarEvents] = await Promise.all([
      readActiveRelationships(),
      readMemories(),
      readCalendarEvents(),
    ]);

    // Check for Knowledge Modification / Forget / Correction requests (Ezzymigo Forget Rule)
    const ai = getGeminiClient();
    const knowledgeModResult = await evaluateKnowledgeModification(trimmedQuestion, activeRelationships, Boolean(confirm), ai);
    if (knowledgeModResult && knowledgeModResult.handled) {
      console.log(`[Knowledge Engine] Handled knowledge modification for: "${trimmedQuestion}"`);
      return res.json({
        answer: knowledgeModResult.answer,
        confirmation_required: knowledgeModResult.confirmation_required || false,
        pending_action: knowledgeModResult.pending_action || undefined,
        memory_ids: [],
        calendar_event_ids: [],
      });
    }

    const { resolvedEntities, ambiguousEntities, expandedTokens } = resolveRelationshipsInQuery(trimmedQuestion, activeRelationships);

    if (resolvedEntities.length > 0) {
      console.log(`[Relationships] Resolved query cues:`, resolvedEntities);
    }
    if (ambiguousEntities.length > 0) {
      console.log(`[Relationships] Ambiguous query cues:`, ambiguousEntities);
    }

    const localContext = formatLocalTimeContext(clientNow, clientTimeZone, clientLanguage, clientRegion);

    // Run Context Builder Stage (DYNAMIC CONTEXT RETRIEVAL v1)
    const dynamicRetrieval = buildDynamicRetrievalContext(
      trimmedQuestion,
      memories,
      calendarEvents,
      activeRelationships,
      localContext
    );

    const { candidateMemories, candidateCalendarEvents, retrievalMetadata } = dynamicRetrieval;
    console.log(`[Dynamic Retrieval v1] Built focused candidate set: ${candidateMemories.length}/${memories.length} memories, ${candidateCalendarEvents.length}/${calendarEvents.length} calendar events. Anchors: people=[${retrievalMetadata.resolvedPeople.join(', ')}], roles=[${retrievalMetadata.resolvedRoles.join(', ')}], places=[${retrievalMetadata.detectedPlaces.join(', ')}], topics=[${retrievalMetadata.topicsAndKeywords.join(', ')}], temporal=[${retrievalMetadata.temporalAnchors.months.concat(retrievalMetadata.temporalAnchors.relativeExpressions).join(', ')}]`);

    // -------------------------------------------------------------
    // SHADOW ARCHITECTURE D & NATIVE RETRIEVAL (Step 2.2B)
    // Non-blocking shadow execution for diagnostic comparison only.
    // Legacy DCR candidateMemories remains strictly authoritative for prompt synthesis.
    // GATED: Disabled during normal user Ask requests to eliminate ~7.6s latency overhead.
    // Preserved for deliberate testing/comparison via ENABLE_ARCH_D_SHADOW env var or enableArchDShadow flag.
    // -------------------------------------------------------------
    const enableArchDShadow = process.env.ENABLE_ARCH_D_SHADOW === 'true' || Boolean((req.body as any)?.enableArchDShadow);
    if (enableArchDShadow) {
      try {
        const archDResult = await executeArchitectureDRetrieval({
          question: trimmedQuestion,
          nowIso: localContext.referenceDate.toISOString(),
          activeRoleLabels: activeRelationships.map(r => r.role),
          legacyCandidateIds: candidateMemories.map(m => m.id),
        });
        const ad = archDResult.shadowTelemetry;
        console.log(`[Architecture D Shadow Telemetry] Query: "${trimmedQuestion}" (${ad.query_language_script}) | Route: ${ad.route_taken} | Top: ${ad.top_candidate_id} (Sim: ${ad.top_cosine_similarity?.toFixed(4) ?? 'N/A'}) | Ambiguity Rescue: ${ad.ambiguity_rescue_triggered ? `YES (${ad.ambiguity_rescue_reason})` : 'NO'} | Counts: Legacy=${ad.legacy_ids.length}, ArchD=${ad.architecture_d_ids.length}, Inter=${ad.intersection_ids.length}, LegacyOnly=${ad.legacy_only_ids.length}, ArchDOnly=${ad.architecture_d_only_ids.length} | Latency: Total=${ad.timings.total_architecture_d_ms}ms (Embed=${ad.timings.embedding_api_ms}ms, VecSQL=${ad.timings.vector_sql_ms}ms, Arb=${ad.timings.arbitration_ms}ms, Rescue=${ad.timings.ambiguity_rescue_ms}ms, Hydrate=${ad.timings.hydration_ms}ms)`);
      } catch (shadowErr) {
        console.warn('[Architecture D Shadow Non-Fatal Error]:', shadowErr);
      }
    }

    if (!ai) {
      const qLower = trimmedQuestion.toLowerCase();

      // Direct relationship question fallback (e.g. "Who is Peter?", "Who is my doctor?")
      const whoIsMatch = trimmedQuestion.match(/^who is (?:my\s+|the\s+)?([a-z0-9\s]+?)\??$/i);
      if (whoIsMatch) {
        const rawTarget = whoIsMatch[1].trim();
        const target = rawTarget.toLowerCase();
        const normTarget = normalizeRoleName(target);
        // Check by person
        const personMatch = activeRelationships.find(r => r.person.toLowerCase() === target);
        if (personMatch) {
          return res.json({
            answer: `${personMatch.person} is your ${personMatch.role}.`,
            memory_ids: [],
            calendar_event_ids: []
          });
        }
        // Check by role
        const roleMatch = activeRelationships.find(r => r.normalized_role === normTarget);
        if (roleMatch) {
          return res.json({
            answer: `Your ${roleMatch.role} is ${roleMatch.person}.`,
            memory_ids: [],
            calendar_event_ids: []
          });
        }
        // If not in active relationships:
        return res.json({
          answer: `I don't have any record of who ${rawTarget} is.`,
          memory_ids: [],
          calendar_event_ids: []
        });
      }

      if (candidateMemories.length === 0 && candidateCalendarEvents.length === 0) {
        return res.json({
          answer: "I couldn't find anything relevant in your saved memories or calendar.",
          memory_ids: [],
          calendar_event_ids: []
        });
      }

      const parts: string[] = [];
      if (candidateCalendarEvents.length > 0) {
        parts.push(`Calendar events: ${candidateCalendarEvents.map(e => {
          if (e.is_all_day) {
            const startYMD = (e.start_datetime || '').slice(0, 10);
            const endYMDExcl = (e.end_datetime || '').slice(0, 10) || startYMD;
            const span = formatAllDayCivilDateSpan(startYMD, endYMDExcl, localContext.language || 'en-AU');
            return `${e.title} (${span} All Day)`;
          }
          return `${e.title} (${e.start_datetime} to ${e.end_datetime})`;
        }).join('; ')}`);
      }
      if (candidateMemories.length > 0) {
        parts.push(`Memories: ${candidateMemories.map(m => m.interpretation?.content || m.originalText).join('; ')}`);
      }
      return res.json({
        answer: parts.join(' | '),
        memory_ids: candidateMemories.map(m => m.id),
        calendar_event_ids: candidateCalendarEvents.map(e => e.id)
      });
    }

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
        intent: m.interpretation?.intent || m.interpretation?.kind || 'thought',
        status: m.isDone ? 'done' : 'active',
        people: m.interpretation?.people || [],
        places: m.interpretation?.places || [],
        topics: m.interpretation?.topics || [],
        contexts: m.interpretation?.contexts || [],
        retrieval_cues: m.interpretation?.retrieval_cues || [],
        relationships: m.interpretation?.relationships || [],
        prerequisite: m.interpretation?.prerequisite || null,
        subject: m.interpretation?.subject || null,
        today_occurrence: todayOccurrenceStr,
        original_time_expression: m.interpretation?.original_time_expression || null,
        resolved_datetime: m.interpretation?.resolved_datetime || null,
        resolved_datetime_local: formatIsoToLocal(m.interpretation?.resolved_datetime, localContext.timeZone),
        event_time_expression: m.interpretation?.event_time_expression || null,
        event_datetime: m.interpretation?.event_datetime || null,
        event_datetime_local: formatIsoToLocal(m.interpretation?.event_datetime, localContext.timeZone),
        reminder_time_expression: m.interpretation?.reminder_time_expression || null,
        reminder_datetime: m.interpretation?.reminder_datetime || null,
        reminder_datetime_local: formatIsoToLocal(m.interpretation?.reminder_datetime, localContext.timeZone),
        resurfacing: m.interpretation?.resurfacing || {},
        originalCapture: m.originalText || '',
        createdAt: m.createdAt,
        created_at_local: formatIsoToLocal(m.createdAt, localContext.timeZone)
      };
    });

    const calendarContext = candidateCalendarEvents.map(e => {
      if (e.is_all_day) {
        const startYMD = (e.start_datetime || '').slice(0, 10);
        const endYMDExcl = (e.end_datetime || '').slice(0, 10) || startYMD;
        const formattedSpan = formatAllDayCivilDateSpan(startYMD, endYMDExcl, localContext.language || 'en-AU');
        const displayTiming = `${formattedSpan} (All Day)`;

        return {
          id: e.id,
          title: e.title,
          is_all_day: true,
          date_local: displayTiming,
          timing: 'All Day',
          start_datetime: startYMD,
          start_datetime_local: displayTiming,
          end_datetime: endYMDExcl,
          end_datetime_local: displayTiming,
          location: e.location || null,
          description: e.description || null,
          attendees: e.attendees || [],
          status: e.status || 'confirmed',
          source: e.source || 'google_calendar',
        };
      }

      return {
        id: e.id,
        title: e.title,
        is_all_day: false,
        start_datetime: e.start_datetime,
        start_datetime_local: formatIsoToLocal(e.start_datetime, localContext.timeZone, localContext.language),
        end_datetime: e.end_datetime,
        end_datetime_local: formatIsoToLocal(e.end_datetime, localContext.timeZone, localContext.language),
        location: e.location || null,
        description: e.description || null,
        attendees: e.attendees || [],
        status: e.status || 'confirmed',
        source: e.source || 'google_calendar',
      };
    });

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

OPERATIONAL RULES:
1. PERSONAL KNOWLEDGE & REASONING (IN-SCOPE):
   - Answer queries using stored memories, lists, relationships, and calendar events.
   - Summaries, comparisons, list calculations/aggregations (e.g. summing item costs), and pattern recognition over user data are squarely within scope.
   - Cross-synthesize memories and calendar events seamlessly (e.g., checking calendar for appointments and memories for related preparations).

2. OUT-OF-SCOPE REDIRECTION & BOUNDARIES:
   - For general knowledge (world trivia, geography), internet searches, stock/market data, weather forecasts, or general chatbot requests (coding, generic roleplay):
     * Do NOT use external training data to answer.
     * Warmly and conversationally state that you help with their personal memories, calendar, and lists rather than searching the web for general knowledge.
     * Return "memory_ids": [], "calendar_event_ids": [], and "is_out_of_scope": true.

3. PERSONAL KNOWLEDGE NOT FOUND:
   - If the query is about personal data/events but no relevant record exists:
     * State conversationally that you couldn't find relevant records in their saved memories or calendar.
     * Return "memory_ids": [], "calendar_event_ids": [], and "is_out_of_scope": false.

4. RELATIONSHIPS & IDENTITY:
   - Use active relationships and resolved query roles as retrieval cues (e.g. "my plumber" -> lookup Dave's quotes/notes).
   - For "Who is [Role]?" or "Who is [Person]?": answer only from active relationships listed above. If unlisted or forgotten, state you have no record of that relationship; do NOT assume or revive historical unlisted relationships.
   - STRICT TONE RULE: Do NOT use patronising labels such as "Barb, your wife" or "Steve, your plumber". Refer to persons naturally (e.g., "You wanted to get Barb the book...").

5. TEMPORAL & HUMAN TIME GROUNDING:
   - Respect localized dates/times ('created_at_local', 'resolved_datetime_local') and 'today_occurrence' (active routines/scheduled items for today).
   - Interpret relative historical expressions ("yesterday afternoon", "last weekend", "before my doctor appointment") against the reference time and event timestamps. Stored resolved timestamps remain permanently anchored to their captured dates.
   - For prerequisites: dependent user actions belong to the user once the condition clears; timing on the prerequisite belongs to the condition, not the user's task.
   - CALENDAR ALL-DAY EVENTS ('is_all_day': true): These are untimed civil calendar-date events belonging strictly to the specified calendar date(s). They are 'All Day' events with NO specific start/end clock time. Never invent or display pseudo-times (such as 10:00 am, 9:59 am, or 12:00 am). Describe them naturally as taking place on that day (e.g. "On Friday, 4 September, it's Doug's birthday").

6. STRICT CITATION & GROUNDING:
   - Ground answers strictly in provided data with zero hallucinations.
   - Return all supporting memory IDs in "memory_ids" and calendar event IDs in "calendar_event_ids". If a calculation uses multiple memories, include all of them.
   - Keep answers natural, concise (1-3 sentences), and formatted for the user's locale.`;

    const promptContent = `Current Reference Time: ${localContext.localDateTimeStr} (${localContext.timeZone})

User Question: "${trimmedQuestion}"

User's Stored Intention Memories:
${JSON.stringify(memoryContext, null, 2)}

User's Imported Calendar Events:
${JSON.stringify(calendarContext, null, 2)}

Please answer the user's question accurately and concisely based strictly on the stored memories and imported calendar events above according to your system instructions, and output valid JSON matching the schema with all supporting memory_ids.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.7-flash',
      contents: promptContent,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: askResponseSchema,
        temperature: 0.2,
      },
    });

    let answer = "I couldn't find anything relevant in your saved memories or calendar.";
    let memory_ids: string[] = [];
    let calendar_event_ids: string[] = [];
    let is_out_of_scope = false;

    const rawResponseText = response.text || '{}';
    console.log(`[API ASK] Raw LLM response: ${rawResponseText}`);

    try {
      const parsed = JSON.parse(rawResponseText);
      if (parsed.answer && typeof parsed.answer === 'string') {
        answer = parsed.answer.trim();
      }
      if (parsed.is_out_of_scope === true) {
        is_out_of_scope = true;
      }

      const validMemoryMap = new Map(memories.map(m => [m.id, m]));
      const validEventMap = new Map(calendarEvents.map(e => [e.id, e]));

      if (Array.isArray(parsed.memory_ids)) {
        for (const rawId of parsed.memory_ids) {
          const strId = String(rawId).trim();
          if (validMemoryMap.has(strId)) {
            if (!memory_ids.includes(strId)) memory_ids.push(strId);
          } else {
            // Handle numeric index or partial ID returned by model
            const numIndex = parseInt(strId.replace(/\D/g, ''), 10);
            if (!isNaN(numIndex) && memories[numIndex]) {
              const matchedId = memories[numIndex].id;
              if (!memory_ids.includes(matchedId)) memory_ids.push(matchedId);
            }
          }
        }
      }

      if (Array.isArray(parsed.calendar_event_ids)) {
        for (const rawId of parsed.calendar_event_ids) {
          const strId = String(rawId).trim();
          if (validEventMap.has(strId)) {
            if (!calendar_event_ids.includes(strId)) calendar_event_ids.push(strId);
          }
        }
      }
    } catch (parseErr) {
      console.warn('[Ask Ezzymigo] JSON parse error on response, fallback:', parseErr);
      answer = response.text?.trim() || answer;
    }

    console.log(`[API ASK] Final result - Answer: "${answer}", is_out_of_scope: ${is_out_of_scope}, Supporting memory_ids: ${JSON.stringify(memory_ids)}, calendar_event_ids: ${JSON.stringify(calendar_event_ids)}`);
    return res.json({ answer, memory_ids, calendar_event_ids, is_out_of_scope });
  } catch (error: any) {
    console.error('Error answering question with Ezzymigo:', error);
    return res.status(500).json({ error: 'Failed to retrieve answer for question' });
  }
});

// GET /api/today-relevance - Diagnostic endpoint (query params)
app.get('/api/today-relevance', async (req, res) => {
  try {
    const { clientNow, clientTimeZone, clientLanguage, clientRegion, dismissed } = req.query;
    const dismissedList = typeof dismissed === 'string' ? dismissed.split(',').filter(Boolean) : [];
    const result = await computeTodayRelevance(
      typeof clientNow === 'string' ? clientNow : undefined,
      typeof clientTimeZone === 'string' ? clientTimeZone : undefined,
      typeof clientLanguage === 'string' ? clientLanguage : undefined,
      typeof clientRegion === 'string' ? clientRegion : undefined,
      dismissedList
    );
    return res.json(result);
  } catch (error: any) {
    console.error('Error computing today relevance:', error);
    return res.status(500).json({ error: 'Failed to compute today relevance' });
  }
});

// POST /api/today-relevance - Diagnostic endpoint (JSON body)
app.post('/api/today-relevance', async (req, res) => {
  try {
    const { clientNow, clientTimeZone, clientLanguage, clientRegion, dismissedReflectionIds } = req.body || {};
    const result = await computeTodayRelevance(
      typeof clientNow === 'string' ? clientNow : undefined,
      typeof clientTimeZone === 'string' ? clientTimeZone : undefined,
      typeof clientLanguage === 'string' ? clientLanguage : undefined,
      typeof clientRegion === 'string' ? clientRegion : undefined,
      Array.isArray(dismissedReflectionIds) ? dismissedReflectionIds : []
    );
    return res.json(result);
  } catch (error: any) {
    console.error('Error computing today relevance:', error);
    return res.status(500).json({ error: 'Failed to compute today relevance' });
  }
});

// Vite middleware & Static serving
async function setupServer() {
  await initBunnyDb();
  await cleanupContaminatedOriginalTexts();
  await backfillStoredRelationships();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    
    // Prevent mobile browsers from caching HTML entry points & service worker
    app.use((req, res, next) => {
      if (
        req.path === '/' ||
        req.path.endsWith('.html') ||
        req.path === '/sw.js' ||
        req.path.endsWith('manifest.webmanifest')
      ) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
      next();
    });

    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html') || filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          } else if (filePath.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );

    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ezzymigo server running on port ${PORT}`);
  });
}

setupServer();

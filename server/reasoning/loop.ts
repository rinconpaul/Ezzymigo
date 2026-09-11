import { GoogleGenAI, Type, Schema } from '@google/genai';
import { getGeminiClient, generateWithRetry } from '../config/gemini';
import {
  ThinkingOpportunity,
  EzzyWorldSnapshot,
  ReasoningDecision,
} from '../snapshot/types';

export interface ExecuteReasoningOptions {
  input?: string;
  trigger?: string;
  targetEventId?: string;
}

const NEW_EZZY_SYSTEM_INSTRUCTION = `You are Ezzymigo (Ezzy), the user's long-term personal memory assistant.
You possess general world intelligence, but ANY and ALL personal claims about the user, their family, their health, their appointments, or their schedule MUST come ONLY and STRICTLY from the supplied Ezzy World Snapshot or the user's current input.

ESSENTIAL BEHAVIOURAL PROPOSITION:
Ezzymigo remembers things so the user does not have to continuously carry them mentally.
Remembering is insufficient—Ezzy must bring information forward while it can still help.
Therefore: Storage does not imply surfacing mundane noise, BUT high-value commitments, appointments, and due reminders MUST be brought forward in a timely manner.

CORE PRINCIPLES & BEHAVIOURAL CONTRACT:
1. EVENING LOOK-AHEAD (Previous evening: timePhase "evening" / 5:00 pm - 10:00 pm):
   - When civil time is evening, your primary proactive orientation duty is to look ahead to tomorrow morning!
   - Inspect "calendar.tomorrowMorningEvents" and "commitments.tomorrowMorningDatedMemories".
   - If an important next-morning commitment exists (e.g. Mum's hairdresser appointment at 10:00 am on Friday):
     Set mode to "SPEAK", headline to "Looking Ahead to Tomorrow Morning" (or specific event), and body to a clear, helpful notice (e.g. "Looking ahead to tomorrow morning: Mum has a hairdresser's appointment at 10:00 am during your usual morning visit.").
     Set reason to "Surfacing next-morning commitment during evening look-ahead window", source to "dated_memory" or "calendar_event", and priority to "high".

2. MORNING ORIENTATION (timePhase "morning" / before 12:00 pm):
   - Surface today's upcoming appointments and morning commitments before they occur (e.g. Mum's 10:00 am appointment).
   - Surface due or overdue reminders from "commitments.dueOrOverdueReminders".
   - Prioritize upcoming appointments prominently while there is still time to prepare or act.

3. APPOINTMENT EXPIRATION & FOLLOW-UP:
   - Once an appointment's scheduled time has passed, preparation prompts expire.
   - For an appointment that concluded within the last 1–4 hours, independently evaluate whether asking about the outcome is worthwhile (e.g. "How did Mum's hairdresser appointment go this morning?").
   - If an outcome note already exists in memory or user interactions, or if the user was already asked, do NOT repeat completed matters.

4. DUE OR OVERDUE REMINDERS:
   - Repeat due or overdue reminders from "commitments.dueOrOverdueReminders" appropriately until Done, dismissed, or deleted.

5. UPCOMING OCCASIONS:
   - Provide useful advance notice for upcoming birthdays and special occasions within their advance preparation window (from "occasions").

6. NO ACTIONABLE CONTENT (THROTTLED HUMAN CHECK-IN):
   - If there is genuinely no timely appointment, commitment, due reminder, or follow-up:
     Ezzy may provide ONE restrained, warm human check-in appropriate to the time of day (e.g. "Good morning, Paul. How are you doing today?").
     NEVER output fake filler like "Ezzymigo is quietly holding your context" or "quietly waiting".

7. ZERO INVENTION & STRICT GROUNDING:
   - Never invent personal facts, appointments, or medical notes.
   - Cite exact memory IDs in "citedMemoryIds" and calendar IDs in "citedCalendarIds".

8. FOR "ASK_QUERY" (INCLUDING CURRENT SCREEN CONTEXT):
   - When the user asks a question, answer directly, cleanly, and helpfully in "communication.body".
   - If the user asks about current screen visibility (e.g. "Why isn’t that showing in the TODAY ticker?", "Why is that on my screen?"):
     Consult "currentScreenContext" (which includes activeTickerItem, recentCandidateResolutions, visibleAppointments) as well as the snapshot's commitments and calendar.
     Resolve "that" cleanly to the relevant appointment, commitment, or memory.
     Explain precisely why it is or is not showing based on scheduled time, current civil time (morning vs afternoon vs evening), whether the scheduled time has passed, and its suppression/attention resolution status.
   - ABSOLUTE PROHIBITION ON MEMORY CREATION FOR ASK_QUERY:
     When answering an Ask question, "proposedMutations" MUST ALWAYS BE EMPTY []. Never propose creating, storing, or saving a memory when the user is asking a question!`;

const REASONING_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    communication: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          enum: ['SPEAK', 'PROMPT', 'SILENT'],
          description: 'The communication mode. Use SILENT only when nothing needs attention right now.',
        },
        headline: {
          type: Type.STRING,
          nullable: true,
          description: 'Brief, clean summary headline or topic label (optional; null if mode is SILENT)',
        },
        body: {
          type: Type.STRING,
          nullable: true,
          description:
            'Substantive message or explanation. For ASK_QUERY, this MUST contain the complete, direct answer to the user question (cannot be null when mode is SPEAK).',
        },
        question: {
          type: Type.STRING,
          nullable: true,
          description: 'Optional follow-up or check-in question (null if none or mode is SILENT)',
        },
        reason: {
          type: Type.STRING,
          nullable: true,
          description: 'Internal explanation of why this communication was surfaced or suppressed',
        },
        source: {
          type: Type.STRING,
          nullable: true,
          description: 'Source: calendar_event, dated_memory, scheduled_reminder, occasion, post_event, or human_checkin',
        },
        priority: {
          type: Type.STRING,
          nullable: true,
          enum: ['urgent', 'high', 'normal', 'low'],
        },
        eligibleAt: {
          type: Type.STRING,
          nullable: true,
        },
        expiresAt: {
          type: Type.STRING,
          nullable: true,
        },
        suppressionState: {
          type: Type.STRING,
          nullable: true,
          enum: ['active', 'suppressed', 'satisfied', 'expired'],
        },
      },
      required: ['mode', 'body'],
    },
    proposedMutations: {
      type: Type.ARRAY,
      description: 'Shadow-only memory updates/creations proposed by New Ezzy (NOT executed in shadow mode)',
      items: {
        type: Type.OBJECT,
        properties: {
          originalText: { type: Type.STRING },
          content: { type: Type.STRING },
          kind: {
            type: Type.STRING,
            enum: ['fact', 'task', 'reminder', 'note'],
          },
          timingExpression: { type: Type.STRING, nullable: true },
          isDone: { type: Type.BOOLEAN },
        },
        required: ['originalText', 'content', 'kind', 'isDone'],
      },
    },
    proposedResolutions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'IDs of memories or tasks proposed to be marked completed/resolved (NOT executed in shadow mode)',
    },
    citedMemoryIds: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Exact IDs of memories from snapshot used or cited in this decision',
    },
    citedCalendarIds: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Exact IDs of calendar events from snapshot used or cited in this decision',
    },
    rationale: {
      type: Type.STRING,
      description: 'Concise explanation of why this decision was chosen, referencing behavioural principles',
    },
  },
  required: [
    'communication',
    'proposedMutations',
    'proposedResolutions',
    'citedMemoryIds',
    'citedCalendarIds',
    'rationale',
  ],
};

export async function executeNewEzzyReasoningLoop(
  opportunity: ThinkingOpportunity,
  snapshot: EzzyWorldSnapshot,
  options: ExecuteReasoningOptions = {},
  aiClient?: GoogleGenAI | null
): Promise<{
  decision: ReasoningDecision;
  modelName: string;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
}> {
  const ai = aiClient || getGeminiClient();
  if (!ai) {
    throw new Error('Gemini client unavailable: GEMINI_API_KEY is not configured');
  }

  const modelName = 'gemini-3.8-flash';

  const userPrompt =
    opportunity === 'ASK_QUERY'
      ? `CURRENT OPPORTUNITY: ASK_QUERY
USER QUESTION: "${options.input || snapshot.trigger}"
CIVIL TIME: ${snapshot.civilTime.dayOfWeek}, ${snapshot.civilTime.dateYMD} at ${snapshot.civilTime.timeStr} (${snapshot.civilTime.timeZone})

INSTRUCTIONS FOR ASK_QUERY:
You are directly answering the user's explicit question.
1. In communication.mode, output "SPEAK".
2. In communication.body, output the complete, direct, substantive answer from the facts in EZZY WORLD SNAPSHOT (1–3 sentences or a clear list of items as appropriate).
3. In communication.headline, output an optional short topic label or null. A topic label alone MUST NEVER substitute for the substantive answer.

EZZY WORLD SNAPSHOT:
${JSON.stringify(snapshot, null, 2)}

Directly and helpfully answer the user's question in communication.body using the facts from the snapshot.
Conform strictly to the JSON schema.`
      : `CURRENT OPPORTUNITY: ${opportunity}
TRIGGER: ${options.trigger || snapshot.trigger || 'system_evaluation'}
CIVIL TIME: ${snapshot.civilTime.dayOfWeek}, ${snapshot.civilTime.dateYMD} at ${snapshot.civilTime.timeStr} (${snapshot.civilTime.timeZone})
${options.targetEventId ? `TARGET EVENT ID: ${options.targetEventId}\n` : ''}${options.input ? `CURRENT USER INPUT: "${options.input}"\n` : ''}
EZZY WORLD SNAPSHOT:
${JSON.stringify(snapshot, null, 2)}

Given what you know about this person, their circumstances, their history, and what is happening right now:
Determine what (if anything) should be communicated, what should be persisted or resolved, and provide your concise rationale.
Conform strictly to the JSON schema.`;

  const t0 = Date.now();
  const response = await generateWithRetry(ai, {
    model: modelName,
    contents: userPrompt,
    config: {
      systemInstruction: NEW_EZZY_SYSTEM_INSTRUCTION,
      temperature: 0.1, // Low production-appropriate temperature for reasoning consistency
      responseMimeType: 'application/json',
      responseSchema: REASONING_SCHEMA,
    },
  });

  const latencyMs = Date.now() - t0;
  const rawText = response.text || '{}';

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    console.error('[New Ezzy Loop] Failed to parse JSON response:', rawText);
    parsed = {
      communication: { mode: 'SILENT', headline: null, body: null, question: null },
      proposedMutations: [],
      proposedResolutions: [],
      citedMemoryIds: [],
      citedCalendarIds: [],
      rationale: 'Fallback due to malformed JSON response',
    };
  }

  // Sanitize mode & communication values
  const mode = (parsed.communication?.mode || 'SILENT').toUpperCase();
  const validMode = mode === 'SPEAK' || mode === 'PROMPT' ? mode : 'SILENT';

  let cleanHeadline = validMode === 'SILENT' ? null : parsed.communication?.headline?.trim() || null;
  let cleanBody = validMode === 'SILENT' ? null : parsed.communication?.body?.trim() || null;
  const cleanQuestion = validMode === 'SILENT' ? null : parsed.communication?.question?.trim() || null;

  // Surgical Invariant for ASK_QUERY:
  // A headline alone must never substitute for a substantive answer in body.
  // If the model produced a headline but left body null/blank on ASK_QUERY (e.g. "Doug is going to Sydney"),
  // promote the text to body so that the consumer receives the substantive answer.
  if (opportunity === 'ASK_QUERY' && validMode === 'SPEAK') {
    if (!cleanBody && cleanHeadline) {
      cleanBody = cleanHeadline;
    }
  }

  const decision: ReasoningDecision = {
    communication: {
      mode: validMode,
      headline: cleanHeadline,
      body: cleanBody,
      question: cleanQuestion,
      reason: parsed.communication?.reason || parsed.rationale || null,
      source: parsed.communication?.source || (opportunity === 'TODAY_ORIENT' ? 'dated_memory' : 'post_event'),
      priority: parsed.communication?.priority || (validMode !== 'SILENT' ? 'normal' : null),
      eligibleAt: parsed.communication?.eligibleAt || snapshot.civilTime.iso,
      expiresAt: parsed.communication?.expiresAt || null,
      suppressionState: parsed.communication?.suppressionState || (validMode === 'SILENT' ? 'suppressed' : 'active'),
    },
    proposedMutations: opportunity === 'ASK_QUERY' ? [] : (Array.isArray(parsed.proposedMutations) ? parsed.proposedMutations : []),
    proposedResolutions: Array.isArray(parsed.proposedResolutions)
      ? parsed.proposedResolutions
      : [],
    citedMemoryIds: Array.isArray(parsed.citedMemoryIds) ? parsed.citedMemoryIds : [],
    citedCalendarIds: Array.isArray(parsed.citedCalendarIds)
      ? parsed.citedCalendarIds
      : [],
    rationale: parsed.rationale || 'Evaluated personal snapshot.',
  };

  const usage = response.usageMetadata || {};
  const promptTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;

  return {
    decision,
    modelName,
    latencyMs,
    promptTokens,
    outputTokens,
  };
}

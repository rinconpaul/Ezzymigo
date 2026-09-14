import { GoogleGenAI, Type, Schema } from '@google/genai';
import { getGeminiClient, generateWithRetry } from '../config/gemini';
import {
  AttentionReviewInput,
  AttentionReviewDecision,
  CuratedChannelCommunication,
  CandidateResolution,
} from './types';

const ATTENTION_REVIEW_SYSTEM_INSTRUCTION = `You are the Executive Attention Reviewer for Ezzymigo (Ezzy), the user's long-term personal assistant.

Your role is to govern what Ezzymigo actually presents to the user on their proactive attention channel (the ticker / check-in prompts).
Multiple thinking opportunities independently produce candidate communications.
You are the single executive intelligence that evaluates the candidate pool collectively as one coherent, respectful assistant.

GOVERNING PRINCIPLES & BEHAVIOURAL CONTRACT:
1. CANDIDATES ARE FRESH PROPOSALS:
   Items in "CANDIDATE COMMUNICATIONS POOL" are newly generated proposals. They have NOT yet been presented to the user.
   Do NOT assume a candidate has already been shown to the user or is "redundant" simply because it is in the candidate pool.
   Only items in "RECENTLY PRESENTED TICKER COMMUNICATIONS" were actually presented on the user's screen in prior sessions.

2. HIGH-PRIORITY PROACTIVE SURFACING:
   Ezzymigo's core promise is: REMEMBERING IS INSUFFICIENT—EZZY MUST BRING INFORMATION FORWARD WHILE IT CAN STILL HELP.
   - Previous evening look-ahead: If civil time is evening (5:00 pm - 10:00 pm) and a candidate surfaces tomorrow morning's appointment or commitment (e.g. Mum's hairdresser appointment at 10:00 am), IT MUST BE ACTIVATED (status: 'ACTIVE') in curatedCommunications.
   - Morning orientation: If civil time is morning before an appointment (e.g. Mum's 10:00 am hairdresser appointment), IT MUST BE ACTIVATED (status: 'ACTIVE') prominently on the ticker.
   - Due or overdue reminders: Must be activated and repeated until marked Done, dismissed, or deleted.
   - Occasion & Birthday Anticipation Windows:
     * Advance notice window (2 to 7 days ahead): If a birthday or major occasion occurs within 2 to 7 days (e.g. Arianne's Sunday birthday when today is Friday afternoon), IT MUST BE ACTIVATED (status: 'ACTIVE') for timely preparation and gift/card planning (e.g. 'Upcoming: Arianne's Birthday on Sunday'). NEVER restrain a birthday occurring within 2–7 days as 'more than two days away'—a weekend birthday requires advance Friday planning!
     * Day-before window: Active preparation notice.
     * Day-of window: Active celebratory greetings and reminder.
     * Never flood the ticker: Consolidate to ONE clean occasion item with appropriate priority ('normal' in advance window, 'high' day-before/day-of).

   - TIMESTAMP & ELIGIBILITY INVARIANT:
     * An item CANNOT be ACTIVE before its eligibility time: eligible_at MUST be <= civilTime.iso. If eligible_at is in the future, the item is NOT yet eligible.
     * If an item has expired (civilTime.iso >= expires_at), it MUST NOT be ACTIVE (mark 'STALE' or 'EXPIRED').

3. RESTRAINT APPLIES TO MUNDANE NOISE, NOT SCHEDULED COMMITMENTS:
   - "Sharpen knives", "clean garage", and general non-urgent chores belong safely in memory without interrupting the user. Mark mundane chore repetition as 'RESTRAINED'.
   - NEVER restrain high-value scheduled appointments, tomorrow morning look-aheads, or due reminders.

4. CONVERSATIONAL SATISFACTION & FOLLOW-UP:
   - If an appointment's scheduled time has passed, preparation prompts expire (mark 'STALE').
   - For an appointment that concluded within the last 1–6 hours on the same day, ONE timely follow-up is eligible (e.g. "How did Mum's hairdresser appointment go this morning?").
   - If the user has already responded or an outcome note is recorded in recent interactions, mark all related prompts as 'SATISFIED' and do not surface them.
   - Once past the post-event window (> 6 hours or next day), the follow-up is 'STALE'.

5. THROTTLED HUMAN CHECK-IN COOLDOWN & OUTRANKING:
   - If there is ANY actionable candidate (calendar event, appointment, reminder, occasion, or post-event follow-up):
     Actionable content ALWAYS outranks human check-ins! Do NOT present a human check-in when actionable commitments exist.
   - If there is genuinely NO actionable content:
     Ezzy may provide ONE restrained, warm human check-in appropriate to the time of day (e.g. "Good morning, Paul. How are you doing today?").
     COOLDOWN: Check "RECENTLY PRESENTED TICKER COMMUNICATIONS" and "RECENT USER INTERACTIONS". If ANY human check-in was presented or occurred within the past 12 hours, resolve it as 'RESTRAINED' and output an empty curatedCommunications [] (silencePreferred: true).
     Do NOT repeat "How are you doing?" on every refresh!
     NEVER output fake filler like "Ezzymigo is quietly holding your context" or "quietly waiting".

6. EXPLICIT DISMISSALS:
   - If a candidate's ID, communication ID, or cited topic appears in "EXPLICIT DISMISSALS":
     It MUST be resolved as 'DISMISSED' and NEVER placed into curatedCommunications.

7. RESOLUTION TAXONOMY:
   For every candidate in candidatePool, you MUST provide an explicit resolution in candidateResolutions with status:
   - 'ACTIVE': selected for presentation in curatedCommunications.
   - 'SATISFIED': user answered or already addressed this topic.
   - 'SUPERSEDED': redundant, duplicate, or consolidated into another item.
   - 'STALE': context has passed, or timing is no longer relevant (e.g. past appointment start).
   - 'RESTRAINED': stored safely in memory, but not worthy of interrupting right now.
   - 'DISMISSED': dismissed explicitly.`;

const ATTENTION_REVIEW_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    curatedCommunications: {
      type: Type.ARRAY,
      description:
        'The final coherent communications to actually place in front of the user (empty if silence is preferred).',
      items: {
        type: Type.OBJECT,
        properties: {
          id: {
            type: Type.STRING,
            description: 'Unique ID for this curated item (e.g. derived from primary candidate)',
          },
          mode: {
            type: Type.STRING,
            enum: ['SPEAK', 'PROMPT'],
          },
          headline: {
            type: Type.STRING,
            nullable: true,
          },
          body: {
            type: Type.STRING,
            nullable: true,
          },
          question: {
            type: Type.STRING,
            nullable: true,
          },
          sourceCandidateIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'IDs of candidate communications represented or consolidated by this item',
          },
          linkedEventId: {
            type: Type.STRING,
            nullable: true,
          },
          linkedMemoryId: {
            type: Type.STRING,
            nullable: true,
          },
          subjectPerson: {
            type: Type.STRING,
            nullable: true,
          },
          occurrenceTime: {
            type: Type.STRING,
            nullable: true,
          },
          priorityRationale: {
            type: Type.STRING,
            description: 'Why this item deserves attention right now',
          },
          reason: {
            type: Type.STRING,
            nullable: true,
            description: 'Internal explanation of why this specific item was surfaced',
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
          eligible_at: {
            type: Type.STRING,
            nullable: true,
            description: 'ISO timestamp when this item became eligible for display',
          },
          expires_at: {
            type: Type.STRING,
            nullable: true,
            description: 'ISO timestamp when this item expires from the ticker',
          },
          suppression_state: {
            type: Type.STRING,
            nullable: true,
            enum: ['active', 'suppressed', 'satisfied', 'expired'],
          },
        },
        required: ['id', 'mode', 'sourceCandidateIds', 'priorityRationale'],
      },
    },
    candidateResolutions: {
      type: Type.ARRAY,
      description: 'Resolution for every candidate in candidatePool.',
      items: {
        type: Type.OBJECT,
        properties: {
          candidateId: {
            type: Type.STRING,
            description: 'Exact ID of the candidate from candidatePool',
          },
          status: {
            type: Type.STRING,
            enum: ['ACTIVE', 'SATISFIED', 'SUPERSEDED', 'STALE', 'RESTRAINED', 'DISMISSED'],
          },
          reason: {
            type: Type.STRING,
            description: 'Concise semantic reasoning for this resolution',
          },
        },
        required: ['candidateId', 'status', 'reason'],
      },
    },
    overallRationale: {
      type: Type.STRING,
      description: 'Executive explanation of the attention channel decision and restraint.',
    },
    silencePreferred: {
      type: Type.BOOLEAN,
      description: 'True if nothing genuinely requires attention right now and silence was chosen.',
    },
  },
  required: ['curatedCommunications', 'candidateResolutions', 'overallRationale', 'silencePreferred'],
};

export async function executeAttentionReview(
  input: AttentionReviewInput,
  aiClient?: GoogleGenAI | null
): Promise<{
  decision: AttentionReviewDecision;
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

  const userPrompt = `EXECUTIVE ATTENTION REVIEW REQUEST
CIVIL TIME: ${input.civilTime.dayOfWeek}, ${input.civilTime.dateYMD} at ${input.civilTime.timeStr} (${input.civilTime.timeZone})

CANDIDATE COMMUNICATIONS POOL:
${JSON.stringify(input.candidatePool, null, 2)}

RECENT USER INTERACTIONS (Prompt Answers & User Thoughts):
${JSON.stringify(input.recentInteractions, null, 2)}

RECENTLY PRESENTED TICKER COMMUNICATIONS:
${JSON.stringify(input.recentlyPresentedItems, null, 2)}

RELEVANT CALENDAR CONTEXT:
${JSON.stringify(input.relevantCalendarContext, null, 2)}

EXPLICIT DISMISSALS:
${JSON.stringify(input.explicitDismissals || [], null, 2)}

Review the candidate communications as an ensemble.
Determine whether any candidate has been satisfied by user interactions, whether candidates are duplicate/equivalent, whether items are stale, and what (if anything) should be presented to the user right now.
Conform strictly to the JSON schema.`;

  const t0 = Date.now();
  const response = await generateWithRetry(ai, {
    model: modelName,
    contents: userPrompt,
    config: {
      systemInstruction: ATTENTION_REVIEW_SYSTEM_INSTRUCTION,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: ATTENTION_REVIEW_SCHEMA,
    },
  });

  const latencyMs = Date.now() - t0;
  const rawText = response.text || '{}';

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    console.error('[Attention Reviewer] Failed to parse JSON response:', rawText);
    parsed = {
      curatedCommunications: [],
      candidateResolutions: [],
      overallRationale: 'Fallback due to malformed response',
      silencePreferred: true,
    };
  }

  const curatedCommunications: CuratedChannelCommunication[] = (
    parsed.curatedCommunications || []
  ).map((item: any) => ({
    id: item.id || `curated_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    mode: item.mode === 'SPEAK' ? 'SPEAK' : 'PROMPT',
    headline: item.headline || null,
    body: item.body || null,
    question: item.question || null,
    sourceCandidateIds: Array.isArray(item.sourceCandidateIds) ? item.sourceCandidateIds : [],
    linkedEventId: item.linkedEventId || null,
    priorityRationale: item.priorityRationale || '',
    reason: item.reason || item.priorityRationale || 'Curated for presentation',
    source: item.source || 'dated_memory',
    priority: item.priority || 'high',
    eligible_at: item.eligible_at || input.civilTime?.iso || new Date().toISOString(),
    expires_at: item.expires_at || null,
    suppression_state: item.suppression_state || 'active',
  }));

  const candidateResolutions: CandidateResolution[] = (
    parsed.candidateResolutions || []
  ).map((res: any) => ({
    candidateId: res.candidateId,
    status: res.status,
    reason: res.reason || '',
  }));

  const decision: AttentionReviewDecision = {
    curatedCommunications,
    candidateResolutions,
    overallRationale: parsed.overallRationale || 'Executive review complete.',
    silencePreferred: Boolean(parsed.silencePreferred || curatedCommunications.length === 0),
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

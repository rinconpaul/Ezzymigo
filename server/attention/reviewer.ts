import { GoogleGenAI, Type, Schema } from '@google/genai';
import { getGeminiClient } from '../config/gemini';
import {
  AttentionReviewInput,
  AttentionReviewDecision,
  CuratedChannelCommunication,
  CandidateResolution,
} from './types';

const ATTENTION_REVIEW_SYSTEM_INSTRUCTION = `You are the Executive Attention Reviewer for Ezzymigo (Ezzy), the user's long-term personal assistant.

Your role is to govern what Ezzymigo actually presents to the user on their proactive attention channel (the ticker / check-in prompts).
Multiple thinking opportunities (such as daily orientation, post-event follow-up, occasion reminders) independently produce candidate communications.
You are the single executive intelligence that evaluates the candidate pool collectively as one coherent, respectful assistant.

GOVERNING PRINCIPLES:
1. SEMANTIC EQUIVALENCE & DEDUPLICATION:
   Different candidates with different wordings often address the exact same conversational matter (e.g., "How did Mum's dentist appointment go?" vs "Mum's dentist appointment - anything worth noting?").
   NEVER surface multiple prompts about the same subject. If multiple candidates share the same conversational subject, either select the single best one or consolidate them. All other duplicate/overlapping candidates must be marked SUPERSEDED.

2. CONVERSATIONAL SATISFACTION:
   Carefully examine recent user interactions.
   If Ezzy prompted the user about a subject and the user subsequently responded, OR if the user captured a note/memory that provides the outcome or answers the question:
   THE CONVERSATIONAL MATTER IS SATISFIED.
   Mark ALL remaining candidate questions or follow-ups on that topic as SATISFIED and do NOT include them in the active channel.
   Example: If candidates ask how Mum's dentist appointment went, and the user's response was "The dentist said that the infection had subsided and will wait and see", the matter is completely satisfied. Remove all dentist prompts.

3. PREFER RESTRAINT AND SILENCE OVER INTERRUPTION:
   Storage does not imply surfacing.
   Mundane chores, routine notes ("sharpen knives", "weed the garden"), and non-urgent backlog items belong safely in memory, NOT on the proactive attention channel.
   If nothing is genuinely timely, urgent, or helpful right now, choose SILENCE. An empty active channel is a successful, polished outcome.

4. TEMPORAL ACCURACY:
   Evaluate candidate items against the provided civil time and calendar context.
   Do not ask about upcoming events as if they already happened. Do not orient on past events as if they are upcoming.
   Upcoming events happening later today (e.g. an appointment in 1-3 hours) are appropriate for proactive orientation.

5. COHERENT VOICE:
   The user experiences Ezzymigo as one person, not as a disjoint bundle of automated microservices.
   Limit the active channel to at most 1-2 truly timely communications.
   For every candidate in candidatePool, you MUST provide an explicit resolution in candidateResolutions with status:
   - 'ACTIVE': selected for presentation in curatedCommunications.
   - 'SATISFIED': user answered or already addressed this topic.
   - 'SUPERSEDED': redundant, duplicate, or consolidated into another item.
   - 'STALE': context has passed, or timing is no longer relevant.
   - 'RESTRAINED': stored safely in memory, but not worthy of interrupting the user right now.
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
          priorityRationale: {
            type: Type.STRING,
            description: 'Why this item deserves attention right now',
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
  const response = await ai.models.generateContent({
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

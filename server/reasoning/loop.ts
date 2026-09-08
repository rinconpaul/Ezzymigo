import { GoogleGenAI, Type, Schema } from '@google/genai';
import { getGeminiClient } from '../config/gemini';
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
Therefore: STORAGE DOES NOT IMPLY SURFACING.
An outstanding task is not automatically something that deserves the user's attention today.

CORE PRINCIPLES:
1. PREFER RELEVANCE OVER COMPLETENESS: Only bring up what is directly actionable, timely, and genuinely helpful for the current opportunity.
2. PREFER RESTRAINT OVER INTERRUPTION: Do not nag, do not manufacture conversations, and do not congratulate mundane behaviour.
3. SILENCE IS SUCCESS: When mode is "SILENT", set headline, body, and question to null. When uncertain whether an unsolicited communication would genuinely help, choose SILENCE.
4. ZERO INVENTION: Never invent personal facts, relationships, commitments, medical advice, or calendar events.
5. NO MUNDANE TASK REPETITION: "Sharpen the knives", "Trim hedge", or general chores must remain safely stored in memory without being surfaced every morning. Avoid guilt-inducing repetition of mundane outstanding tasks. If several non-urgent tasks have accumulated over time, Ezzy might occasionally judge that asking "You've got a few non-urgent things sitting in your list. Want to review them?" would be useful, but never turn that into a rigid cadence.
6. EVENT PREPARATION & FOLLOW-UP:
   - For approaching events (PRE_EVENT): surface relevant preparations or things the user specifically noted they wanted to ask/discuss.
   - For recently ended calendar events (POST_EVENT or TODAY_ORIENT after an appointment): independently evaluate whether asking about the outcome is worthwhile (e.g. "How did the dentist go? Anything worth remembering or following up?"). Do not force it; decide based on context.
7. MEANINGFUL FOLLOW-UP VS NAGGING:
   - Recognise genuine unresolved threads (e.g. waiting weeks for a contractor quote or test result).
   - Distinguish meaningful follow-up on open external dependencies from intrusive nagging on passive notes.
8. RESPECT TENSE & COMPLETED MATTERS:
   - Never turn completed past actions or reports into future obligations.
   - If an event, topic, or occasion was already discussed in recent interactions or marked done, it is resolved. Do not repeat completed matters.
9. FOR "ASK_QUERY" ONLY:
   - When the user asks a question and relevant personal information exists in your snapshot, directly and substantively answer their question in "communication.body" (1–3 sentences or a clear list of items as appropriate).
   - "communication.headline" is ONLY an optional brief topic label (or null). A headline or topic label alone (e.g. "Shopping list", "Doug's trip", "Mum's dentist update", "Current plumber", "Gutters") MUST NEVER substitute for the substantive answer. The substantive answer MUST be in "communication.body".
   - If no relevant personal records exist in your snapshot: set mode to "SPEAK" and state conversationally in "communication.body" that you have no record of that in their saved memories or calendar.
   - The silence bias applies to unsolicited prompts (TODAY_ORIENT, PRE_EVENT, POST_EVENT), NOT to direct user questions.
10. STRICT GROUNDING: Any memory or calendar event you mention or rely on must be explicitly cited in "citedMemoryIds" or "citedCalendarIds". Cite ONLY IDs that exist in the snapshot.`;

const REASONING_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    communication: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          enum: ['SPEAK', 'PROMPT', 'SILENT'],
          description: 'The communication mode. Use SILENT when nothing needs attention right now.',
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
  const response = await ai.models.generateContent({
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
    },
    proposedMutations: Array.isArray(parsed.proposedMutations)
      ? parsed.proposedMutations
      : [],
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

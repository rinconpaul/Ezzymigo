import { GoogleGenAI } from '@google/genai';
import { getGeminiClient } from '../config/gemini';

export interface EzzyWorldSnapshot {
  currentTime: string;
  userLocale?: string;
  timeZone?: string;
  calendarEvents?: Array<{
    id: string;
    title: string;
    start: string;
    end?: string;
    isAllDay?: boolean;
    description?: string;
    location?: string;
  }>;
  memories?: Array<{
    id: string;
    content: string;
    kind?: string;
    intent?: string;
    createdAt?: string;
    timingExpression?: string;
    resolvedDatetime?: string;
    isDone?: boolean;
    people?: string[];
    topics?: string[];
  }>;
  relationships?: Array<{
    person: string;
    role: string;
  }>;
  occasions?: Array<{
    id: string;
    title: string;
    date: string;
    timingDescription?: string;
  }>;
  recentInteractions?: Array<{
    eventId?: string;
    occasionId?: string;
    topic?: string;
    promptAsked?: string;
    userResponse?: string;
    status?: 'resolved' | 'pending';
    timestamp?: string;
  }>;
}

export interface ReasoningInvocation {
  opportunity:
    | 'TODAY_ORIENT'
    | 'PRE_EVENT'
    | 'POST_EVENT'
    | 'INBOUND_TELL'
    | 'ASK_QUERY'
    | 'POST_CALL';
  currentTime: string;
  snapshot: EzzyWorldSnapshot;
  userInput?: string;
  triggerEventId?: string;
}

export interface ReasoningDecision {
  communication: {
    mode: 'SPEAK' | 'PROMPT' | 'SILENT';
    headline?: string | null;
    body?: string | null;
    closingQuestion?: string | null;
  };
  proposedMutations: {
    memoriesToPersist: Array<{
      content: string;
      kind: 'fact' | 'task' | 'reminder' | 'note';
      timingExpression?: string | null;
      resolvedDatetime?: string | null;
      isDone?: boolean;
    }>;
    memoryIdsToResolve: string[];
  };
  citedMemoryIds: string[];
  citedCalendarIds: string[];
  rationale: string;
  metrics?: {
    latencyMs: number;
    promptTokens?: number;
    candidateTokens?: number;
    totalTokens?: number;
  };
}

const SYSTEM_INSTRUCTION = `You are Ezzymigo (Ezzy), the user's long-term personal memory assistant.
You possess general world intelligence, but ANY and ALL personal claims about the user, their family, their health, their appointments, or their schedule MUST come ONLY and STRICTLY from the supplied Ezzy World Snapshot or the user's current input.

YOUR PRIME MANDATE:
Your job is NOT to find something clever to say.
Your job is to determine whether saying something would genuinely help the user right now, or whether staying completely SILENT is the most intelligent and respectful choice.
SILENCE is considered a successful, high-value outcome.

CORE BEHAVIOURAL PRINCIPLES:
1. Prefer relevance over completeness: Only bring up what is directly actionable and timely for the current opportunity.
2. Prefer restraint over unnecessary prompting: Do not nag, do not manufacture conversations, and do not congratulate mundane behaviour.
3. SILENCE IS SUCCESS: When mode is "SILENT", set headline, body, and closingQuestion to null. When uncertain whether an unsolicited prompt would help, choose SILENCE.
4. ZERO INVENTION: Never invent personal facts, relationships, commitments, medical advice, or calendar events.
5. NO MANUFACTURED OBLIGATIONS: Do not turn passive background facts (e.g. "Prescription expires in 2027", "The tyre is in the shed") into tasks or questions.
6. RESPECT TENSE & ASPECT: Never turn completed past actions or reports into future obligations (e.g. NEVER say "You were going to speak with X" if the note says they already spoke).
7. DO NOT REPEAT COMPLETED MATTERS: If an event or occasion (like Father's Day) was already discussed in recent interactions, it is resolved. Do not bring it up again.
8. DISTINGUISH INTENTIONS FROM FACTS: In inbound capture, distinguish passive observations/comments from future intentions. If a user comments on a past TV show, do not create a reminder or appointment to watch it.
9. FOR "ASK_QUERY" ONLY: Directly and helpfully answer the user's question from context. The silence bias applies to unsolicited prompts (TODAY_ORIENT, PRE_EVENT, POST_EVENT), NOT to direct questions asked by the user.
10. STRICT GROUNDING: Any memory or calendar event you mention or rely on must be explicitly cited in "citedMemoryIds" or "citedCalendarIds". Cite ONLY IDs that exist in the snapshot.

OUTPUT FORMAT:
Output strictly valid JSON conforming to the following structure:
{
  "communication": {
    "mode": "SPEAK" | "PROMPT" | "SILENT",
    "headline": string or null,
    "body": string or null,
    "closingQuestion": string or null
  },
  "proposedMutations": {
    "memoriesToPersist": [
      {
        "content": string,
        "kind": "fact" | "task" | "reminder" | "note",
        "timingExpression": string or null,
        "resolvedDatetime": string or null,
        "isDone": boolean
      }
    ],
    "memoryIdsToResolve": [string]
  },
  "citedMemoryIds": [string],
  "citedCalendarIds": [string],
  "rationale": string
}
`;

export async function executeReasoningLoop(
  invocation: ReasoningInvocation,
  aiClient?: GoogleGenAI | null
): Promise<ReasoningDecision> {
  const ai = aiClient || getGeminiClient();
  if (!ai) {
    throw new Error('Gemini client unavailable: GEMINI_API_KEY is not configured');
  }

  const userPrompt = `CURRENT OPPORTUNITY: ${invocation.opportunity}
CURRENT TIME: ${invocation.currentTime}
${invocation.triggerEventId ? `TRIGGER EVENT ID: ${invocation.triggerEventId}\n` : ''}${invocation.userInput ? `USER INPUT: "${invocation.userInput}"\n` : ''}
EZZY WORLD SNAPSHOT:
${JSON.stringify(invocation.snapshot, null, 2)}

Given what you know about this person, their history, their current circumstances, and what is happening now:
Determine what (if anything) should be communicated, what should be persisted or resolved, and explain your rationale.
Conform strictly to the JSON schema.`;

  const t0 = Date.now();
  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: userPrompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.1, // Low production-appropriate temperature for consistent reasoning
      responseMimeType: 'application/json',
    },
  });
  const latencyMs = Date.now() - t0;

  if (!response.text) {
    throw new Error('Gemini 3.8 Flash returned empty response text');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(response.text);
  } catch (err: any) {
    throw new Error(`Failed to parse JSON response from Gemini 3.8 Flash: ${err.message}\nRaw: ${response.text}`);
  }

  const decision: ReasoningDecision = {
    communication: {
      mode: parsed.communication?.mode || 'SILENT',
      headline: parsed.communication?.headline || null,
      body: parsed.communication?.body || null,
      closingQuestion: parsed.communication?.closingQuestion || null,
    },
    proposedMutations: {
      memoriesToPersist: Array.isArray(parsed.proposedMutations?.memoriesToPersist)
        ? parsed.proposedMutations.memoriesToPersist
        : [],
      memoryIdsToResolve: Array.isArray(parsed.proposedMutations?.memoryIdsToResolve)
        ? parsed.proposedMutations.memoryIdsToResolve
        : [],
    },
    citedMemoryIds: Array.isArray(parsed.citedMemoryIds) ? parsed.citedMemoryIds : [],
    citedCalendarIds: Array.isArray(parsed.citedCalendarIds) ? parsed.citedCalendarIds : [],
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    metrics: {
      latencyMs,
      promptTokens: response.usageMetadata?.promptTokenCount,
      candidateTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount,
    },
  };

  return decision;
}

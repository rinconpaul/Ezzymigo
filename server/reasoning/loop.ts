import { GoogleGenAI, Type, Schema } from '@google/genai';
import { getGeminiClient, generateWithRetry } from '../config/gemini';
import {
  ThinkingOpportunity,
  EzzyWorldSnapshot,
  ReasoningDecision,
  ReasoningMode,
} from '../snapshot/types';
import { executeCapability, areCapabilitiesEnabled } from '../capabilities/registry';

export interface ExecuteReasoningOptions {
  input?: string;
  trigger?: string;
  targetEventId?: string;
  clientRegion?: string;
}

const NEW_EZZY_SYSTEM_INSTRUCTION = `You are Ezzymigo (Ezzy), the user's long-term personal memory assistant.
You possess general world intelligence, but ANY and ALL personal claims about the user, their family, their health, their appointments, or their schedule MUST come ONLY and STRICTLY from the supplied Ezzy World Snapshot or the user's current input.

ESSENTIAL BEHAVIOURAL PROPOSITION:
Ezzymigo remembers things so the user does not have to continuously carry them mentally.
Remembering is insufficient—Ezzy must bring information forward while it can still help.
Therefore: Storage does not imply surfacing mundane noise, BUT high-value commitments, appointments, and due reminders MUST be brought forward in a timely manner.

GOVERNING PRINCIPLE FOR ANTICIPATORY INTELLIGENCE & CAPABILITIES:
"Context resolves meaning; it does not manufacture intent."
- DO NOT add occasion-specific logic or keyword mappings:
  * Never hardcode: if birthday -> suggest restaurant; if anniversary -> suggest flowers; if doctor -> suggest questions.
  * No regexes, no fixed category templates, no predetermined prompts for individual scenarios.
- The deterministic system controls facts and boundaries. Gemini reasons about meaning.

THE 7-STEP REASONING & CAPABILITY LIFECYCLE:
1. Review event: Evaluate upcoming calendar events or commitments in their temporal context.
2. Decide if help is needed: Does this event involve logistical coordination, preparation, or decisions that the user has NOT yet handled?
   * If already handled (e.g. memory shows "Doug booked Italian place" or user already arranged it) -> stay SILENT or simple informational notice.
   * If mundane routine chore (e.g. routine grocery run) -> stay SILENT or simple reminder without unsolicited capability suggestions.
3. Offer broad communication: If help may be useful, start with broad check-in or orientation (mode "COMMUNICATE" or "ASK").
   * Check in generally on how plans are shaping up or ask if they would like a hand looking into anything.
   * Do NOT jump ahead to picking specific venues, flowers, or bookings before understanding the user's situation.
4. Interpret response: When the user responds (via input or recent interactions):
   * If the user declines or says all sorted -> respect their choice, stay SILENT or simple warm acknowledgement. DO NOT invoke capabilities.
   * If the user expresses a specific logistical need -> move to Step 5 or Step 6.
5. Offer capability (mode "OFFER_CAPABILITY"):
   * If the user mentions a need or undecided aspect without explicitly asking for search yet, offer an approved capability ("search_places"), stating clearly what Ezzy can look up and asking if they would like that.
6. Use capability (mode "USE_CAPABILITY"):
   * When the user explicitly asks Ezzy to find, research, recommend, or suggest options/places, or confirms Ezzy's offer:
   * Set mode to "USE_CAPABILITY".
   * Populate "capabilityRequest" with capability: "search_places" and parameters { query, location, criteria, placeType }.
7. Present results (mode "COMMUNICATE"):
   * Present verified, real options clearly and actionably with practical details (name, address, rating, key features, phone, link) so the user can easily take action.

PRIVACY & LOCATION RESOLUTION HIERARCHY:
- Rule: Do not silently acquire precise location.
- Hierarchy:
  1. Explicit location: If the user or event explicitly specifies a location (e.g., "in Deakin", "near Canberra Hospital"), use that.
  2. Home / General location: Look for where the user lives from active memories.
  3. Broad locality: Use client region or timezone (e.g., Canberra, ACT; Sydney, NSW).
  4. Clarification: If location is completely ambiguous, mode must be "ASK" to clarify the area before searching.

SAFETY & BOUNDARIES:
- Ezzy is strictly an informational and research assistant.
- NEVER attempt automated bookings, reservations, text messages, or phone calls.
- Always present actionable options so the user remains in full control.

GENERIC REASONING CONTRACT MODES:
- "SILENT": No communication needed right now.
- "COMMUNICATE" (or "SPEAK"): Informative message, proactive orientation, or presentation of research results.
- "ASK" (or "PROMPT"): Check-in, exploratory question, or asking for clarification.
- "OFFER_CAPABILITY": Proposing an approved capability (e.g. search_places) to assist with an expressed need.
- "USE_CAPABILITY": Invoking an approved capability (search_places) with structured parameters.

EVENING LOOK-AHEAD & MORNING ORIENTATION:
- Evening: Look ahead to tomorrow morning's commitments.
- Morning: Surface today's upcoming commitments and due reminders before they occur.
- Post-event: Expire preparation prompts. Optionally ask about outcome 1-4 hours after conclusion if not already recorded.
- Ask Query: Answer user questions directly in body. Proposed mutations MUST be empty [] for ASK_QUERY.`;

const REASONING_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    communication: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          enum: [
            'SILENT',
            'COMMUNICATE',
            'ASK',
            'OFFER_CAPABILITY',
            'USE_CAPABILITY',
            'SPEAK',
            'PROMPT',
          ],
          description:
            'The communication mode. Use SILENT when nothing needs attention; COMMUNICATE for notices or presenting results; ASK for broad check-ins; OFFER_CAPABILITY to offer research; USE_CAPABILITY to run an approved capability.',
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
            'Substantive message, check-in, or explanation. For ASK_QUERY, this MUST contain the complete, direct answer.',
        },
        question: {
          type: Type.STRING,
          nullable: true,
          description: 'Optional follow-up, offer, or check-in question (null if none or mode is SILENT)',
        },
        reason: {
          type: Type.STRING,
          nullable: true,
          description: 'Internal explanation of why this communication was surfaced or suppressed',
        },
        source: {
          type: Type.STRING,
          nullable: true,
          description: 'Source: calendar_event, dated_memory, scheduled_reminder, occasion, post_event, capability, or human_checkin',
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
    capabilityRequest: {
      type: Type.OBJECT,
      nullable: true,
      description: 'Required when mode is USE_CAPABILITY. Structured parameters to invoke an approved capability.',
      properties: {
        capability: {
          type: Type.STRING,
          description: 'Must be "search_places"',
        },
        parameters: {
          type: Type.OBJECT,
          description: 'Search parameters',
          properties: {
            query: { type: Type.STRING },
            location: { type: Type.STRING, nullable: true },
            placeType: { type: Type.STRING, nullable: true },
            criteria: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['query'],
        },
        rationale: { type: Type.STRING, nullable: true },
      },
    },
    capabilityOffer: {
      type: Type.OBJECT,
      nullable: true,
      description: 'Required when mode is OFFER_CAPABILITY. Description of the capability offered.',
      properties: {
        capability: { type: Type.STRING },
        description: { type: Type.STRING },
        suggestedParameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING },
            location: { type: Type.STRING, nullable: true },
          },
        },
      },
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
${options.input ? `NOTE: The user has provided current input ("${options.input}"). Address their statement or request directly. If they are asking for recommendations, research, or assistance, use USE_CAPABILITY or COMMUNICATE with capabilityRequest to assist them.\n` : ''}Determine what (if anything) should be communicated, what should be persisted or resolved, and provide your concise rationale.
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
  const rawMode = (parsed.communication?.mode || 'SILENT').toUpperCase();
  const ALLOWED_MODES: ReasoningMode[] = [
    'SILENT',
    'COMMUNICATE',
    'ASK',
    'OFFER_CAPABILITY',
    'USE_CAPABILITY',
    'SPEAK',
    'PROMPT',
  ];
  const validMode: ReasoningMode = (ALLOWED_MODES.includes(rawMode as any)
    ? rawMode
    : 'SILENT') as ReasoningMode;

  let cleanHeadline = validMode === 'SILENT' ? null : parsed.communication?.headline?.trim() || null;
  let cleanBody = validMode === 'SILENT' ? null : parsed.communication?.body?.trim() || null;
  const cleanQuestion = validMode === 'SILENT' ? null : parsed.communication?.question?.trim() || null;

  // Surgical Invariant for ASK_QUERY:
  // A headline alone must never substitute for a substantive answer in body.
  if (opportunity === 'ASK_QUERY' && (validMode === 'SPEAK' || validMode === 'COMMUNICATE')) {
    if (!cleanBody && cleanHeadline) {
      cleanBody = cleanHeadline;
    }
  }

  let capRequest = parsed.capabilityRequest || null;
  const capOffer = parsed.capabilityOffer || null;
  let capResult: any = null;

  // Execute capability server-side if mode is USE_CAPABILITY or capabilityRequest is present
  if (validMode === 'USE_CAPABILITY' || capRequest) {
    if (!capRequest && validMode === 'USE_CAPABILITY') {
      capRequest = {
        capability: 'search_places',
        parameters: {
          query: cleanHeadline || cleanBody || options.input || 'places',
        },
      };
    }

    if (capRequest?.capability) {
      if (!areCapabilitiesEnabled(snapshot.ezzyId)) {
        capResult = {
          disabled: true,
          reason: 'Capability execution disabled in production (ENABLE_EZZY_CAPABILITIES is false).',
        };
      } else {
        try {
          const execution = await executeCapability({
            ezzyId: snapshot.ezzyId,
            capability: capRequest.capability as any,
            parameters: capRequest.parameters || {},
            clientNow: snapshot.civilTime.iso,
            clientTimeZone: snapshot.civilTime.timeZone,
            clientRegion: options.clientRegion || (snapshot as any).clientRegion,
            userMemories: snapshot.activeMemories,
          });
          capResult = execution.data;

          // If places were found and the body is generic or empty, format clean actionable results
          if (
            capResult?.places?.length > 0 &&
            (!cleanBody ||
              cleanBody.length < 25 ||
              cleanBody.toLowerCase().includes('searching') ||
              cleanBody.toLowerCase().includes('looking'))
          ) {
            const placesText = capResult.places
              .map((p: any) => {
                const ratingText = p.rating ? ` (${p.rating}★)` : '';
                const featText = p.features && p.features.length > 0 ? ` - ${p.features.join(', ')}` : '';
                const contactText = p.phoneNumber ? ` | Tel: ${p.phoneNumber}` : '';
                const webText = p.websiteUrl ? ` | ${p.websiteUrl}` : '';
                return `• **${p.name}**${ratingText}: ${p.address}${featText}${contactText}${webText}`;
              })
              .join('\n');
            cleanBody = `Here are suitable options in ${capResult.locationUsed}:\n\n${placesText}`;
          }
        } catch (err) {
          console.warn('[Reasoning Loop] Capability execution failed:', err);
        }
      }
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
    capabilityRequest: capRequest,
    capabilityOffer: capOffer,
    capabilityResult: capResult,
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

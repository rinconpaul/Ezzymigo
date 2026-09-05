import { executeBunnySql } from '../db/client';
import { normalizeSubject } from '../db/search_sync';
import { getGeminiClient } from '../config/gemini';
import { GoogleGenAI, Type } from '@google/genai';

// Helper to query SQL via executeBunnySql
async function querySql(sql: string, args: any[] = []): Promise<any[]> {
  const res = await executeBunnySql([{ sql, args }]);
  return res[0]?.rows || [];
}

// ============================================================================
// PHASE 2 — STEP 2.2B DEFINITIVE RETRIEVAL CONSTANTS
// ============================================================================

export const MAX_FTS_INITIAL_CANDIDATES = 30;
export const MAX_FUZZY_HYDRATED = 15;
export const MAX_REFORMULATIONS = 3;
export const MAX_STAGE_C_FTS_CANDIDATES = 10;
export const MAX_RERANK_INPUT = 10;
export const MAX_RERANK_OUTPUT = 3;

// Extended Stopwords Set
export const STOPWORDS = new Set([
  // Core grammatical particles & pronouns
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do', 'does', 'for', 
  'from', 'had', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'no', 
  'not', 'of', 'on', 'or', 'so', 'that', 'the', 'their', 'there', 'they', 'this', 
  'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 
  'you', 'your', 'any', 'some', 'all', 'out', 'up', 'down', 'off',

  // Pronouns & modals
  'he', 'him', 'his', 'she', 'her', 'hers', 'them', 'they', 'their', 'theirs',
  'us', 'our', 'ours', 'should', 'would', 'could', 'can', 'will', 'shall', 'might', 'must',

  // Conversational filler / question framing words
  'guy', 'girl', 'person', 'thing', 'things', 'stuff', 'again', 'end', 'start',

  // Prepositions & relational connectives
  'about', 'into', 'onto', 'regarding', 'around', 'through', 'over', 'under', 
  'above', 'below', 'between', 'during', 'before', 'after', 'then', 
  'just', 'approximately', 'approx', 'near'
]);

// Generic domain action verbs
export const GENERIC_ACTION_VERBS = new Set([
  'buy', 'bought', 'purchase', 'call', 'called', 'ring', 'rang', 'phone', 'phoned',
  'spoke', 'speak', 'talk', 'talked', 'tell', 'told', 'pay', 'paid', 'cost', 'quote',
  'put', 'left', 'store', 'stored', 'see', 'saw', 'meet', 'met', 'get', 'got', 'give', 'gave',
  'stick', 'stuck', 'say', 'said', 'know', 'knew', 'find', 'found', 'pick', 'picked'
]);

// Conversational Greeting / Non-Search Tokens
export const GREETING_TOKENS = new Set([
  'hello', 'hi', 'hey', 'greetings', 'morning', 'afternoon', 'evening',
  'thanks', 'thank you', 'cheers', 'bye', 'goodbye', 'ok', 'okay'
]);

// 1. Canonical Lemmatization Map
export const LEMMA_CANONICAL_MAP: Readonly<Record<string, string>> = Object.freeze({
  // Pay / Cost / Spend
  paying: 'pay', paid: 'pay', pays: 'pay',
  spending: 'spend', spent: 'spend', spends: 'spend',
  // Buy / Purchase
  buying: 'buy', bought: 'buy', buys: 'buy',
  purchasing: 'purchase', purchased: 'purchase', purchases: 'purchase',
  // Call / Ring / Speak / Phone
  calling: 'call', called: 'call', calls: 'call',
  ringing: 'ring', rang: 'ring', rings: 'ring', rung: 'ring',
  speaking: 'speak', spoke: 'speak', speaks: 'speak', spoken: 'speak',
  talking: 'talk', talked: 'talk', talks: 'talk',
  phoning: 'phone', phoned: 'phone', phones: 'phone',
  // Quote / Estimate
  quoting: 'quote', quoted: 'quote', quotes: 'quote',
  estimating: 'estimate', estimated: 'estimate', estimates: 'estimate',
  // Fix / Repair / Service
  fixing: 'fix', fixed: 'fix', fixes: 'fix',
  repairing: 'repair', repaired: 'repair', repairs: 'repair',
  servicing: 'service', serviced: 'service', services: 'service',
  mending: 'mend', mended: 'mend', mends: 'mend',
  // Leave / Store / Put / Stick
  leaving: 'leave', left: 'leave', leaves: 'leave',
  storing: 'store', stored: 'store', stores: 'store',
  putting: 'put', puts: 'put',
  sticking: 'stick', stuck: 'stick', sticks: 'stick',
  // Shots / Vaccination
  shots: 'shot', vaccination: 'shot', vaccinations: 'shot', vaccine: 'shot', vaccines: 'shot',
  // Paint
  paints: 'paint', painted: 'paint', painting: 'paint',
  // Sell / Sales
  sales: 'sold', selling: 'sold', sells: 'sold', sell: 'sold',
  // Chores / Tasks
  chores: 'chore', tasks: 'chore', task: 'chore', errands: 'chore', errand: 'chore',
  // Pipe / Pipes
  pipes: 'pipe', plumbing: 'pipe', plumber: 'pipe',
  // Battery / Auto
  battery: 'battery', batteries: 'battery', auto: 'car', automobile: 'car', vehicle: 'car',
  // Wife / Husband / Spouse
  wife: 'wife', spouse: 'wife', partner: 'wife',
  // Tradesman / Handyman
  tradesman: 'handyman', tradie: 'handyman', contractor: 'handyman',
  // Dentist / Doctor
  dentist: 'dentist', doctor: 'doctor', dr: 'doctor', checkup: 'checkup', appointment: 'appointment',
});

// 2. Symmetric Semantic Cluster Map
export const SEMANTIC_CLUSTER_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pay: ['pay', 'paid', 'paying', 'cost', 'price', 'spend', 'spent', 'bought', '$'],
  buy: ['buy', 'bought', 'buying', 'purchase', 'purchased', 'purchasing', 'paid', 'pick up', 'picked up', 'cost'],
  call: ['call', 'called', 'calling', 'ring', 'rang', 'ringing', 'phone', 'phoned', 'spoke', 'contact', 'contacted'],
  speak: ['speak', 'spoke', 'speaking', 'talk', 'talked', 'called', 'discuss', 'discussed'],
  quote: ['quote', 'quoted', 'quoting', 'estimate', 'estimated', 'cost', 'price', '$'],
  fix: ['fix', 'fixed', 'fixing', 'repair', 'repaired', 'repairing', 'service', 'serviced', 'mend', 'pipes', 'pipe', 'plumber'],
  leave: ['leave', 'left', 'leaving', 'store', 'stored', 'storing', 'put', 'place', 'placed', 'stick', 'stuck'],
  shot: ['shot', 'shots', 'vaccination', 'vaccinations', 'vaccine', 'vet', 'annual vaccination'],
  chore: ['chore', 'chores', 'task', 'tasks', 'errand', 'errands', 'bins', 'waste'],
  car: ['car', 'auto', 'vehicle', 'automobile', 'battery'],
  pipe: ['pipe', 'pipes', 'plumber', 'plumbing', 'valve', 'hot water'],
  handyman: ['handyman', 'tradesman', 'tradie', 'fence', 'repair'],
  doctor: ['doctor', 'dr', 'checkup', 'appointment', 'reception', 'clinic'],
  sold: ['sold', 'sale', 'sales', 'selling', 'items'],
});

export interface ScoredCandidate {
  memory_id: string;
  content: string;
  original_text: string;
  people: string;
  places: string;
  topics: string;
  retrieval_cues: string;
  items: string;
  subject: string;
  bm25_score: number;
}

export interface ShadowRetrievalTelemetry {
  query: string;
  timestamp: string;
  legacy_ids: string[];
  native_ids: string[];
  intersection_ids: string[];
  legacy_only_ids: string[];
  native_only_ids: string[];
  stage_route: 'stage_a' | 'stage_b' | 'stage_c' | 'zero_result';
  stage_c_triggered: boolean;
  stage_c_reason: string | null;
  stage_a_count: number;
  stage_b_count: number;
  stage_c_count: number;
  native_hydrated_count: number;
  timings: {
    stage_a_ms: number;
    stage_b_ms: number;
    stage_c_ms: number;
    hydration_ms: number;
    total_native_ms: number;
  };
  gemini_calls_made: {
    reformulation: boolean;
    rerank: boolean;
  };
  error: string | null;
}

export interface NativeRetrievalResult {
  candidateMemories: any[];
  telemetry: ShadowRetrievalTelemetry;
}

/**
 * Checks if query is a pure conversational greeting / acknowledgment
 */
export function isGreeting(query: string): boolean {
  const clean = query.toLowerCase().replace(/[^\w\s]/g, '').trim();
  if (!clean) return true;
  const words = clean.split(/\s+/);
  return words.length <= 2 && words.every(w => GREETING_TOKENS.has(w));
}

/**
 * Extracts whole tokens and lemmas from a candidate record for exact boundary comparison
 */
export function extractCandidateTokenSet(candidate: ScoredCandidate): Set<string> {
  const combined = [
    candidate.content,
    candidate.people,
    candidate.places,
    candidate.topics,
    candidate.retrieval_cues,
    candidate.items,
    candidate.subject
  ].join(' ').toLowerCase();

  const words = combined.replace(/[^\w\s$]/g, ' ').split(/\s+/).filter(w => w.length > 0);
  const set = new Set<string>();

  for (const w of words) {
    set.add(w);
    const lemma = LEMMA_CANONICAL_MAP[w];
    if (lemma) set.add(lemma);
  }

  return set;
}

/**
 * Deterministically checks whether top candidate satisfies discriminating query concepts
 */
export function isRetrievalConfident(
  query: string,
  candidates: ScoredCandidate[]
): boolean {
  if (!candidates || candidates.length === 0) {
    return false;
  }

  const topCandidate = candidates[0];
  const candidateTokens = extractCandidateTokenSet(topCandidate);

  const rawWords = query
    .toLowerCase()
    .replace(/[^\w\s$]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0)
    .filter(w => !STOPWORDS.has(w));

  if (rawWords.length === 0) {
    return true;
  }

  const discriminatingTokens: string[] = [];

  for (const word of rawWords) {
    const lemma = LEMMA_CANONICAL_MAP[word] || word;
    if (!GENERIC_ACTION_VERBS.has(lemma)) {
      discriminatingTokens.push(word);
    }
  }

  // If no discriminating target object specified, matching action/anchor is confident
  if (discriminatingTokens.length === 0) {
    return true;
  }

  // Verify all discriminating tokens (or lemmas / synonyms) exist in candidate token set
  for (const token of discriminatingTokens) {
    const lemma = LEMMA_CANONICAL_MAP[token] || token;
    const syns = SEMANTIC_CLUSTER_MAP[lemma] || [];
    const isMatched = candidateTokens.has(token) || 
                      candidateTokens.has(lemma) || 
                      syns.some(s => candidateTokens.has(s) || candidateTokens.has(LEMMA_CANONICAL_MAP[s] || s));
    if (!isMatched) {
      return false; // Low confidence
    }
  }

  return true;
}

/**
 * Builds an FTS5 search expression with morphological and synonym expansion
 */
export function buildFtsQueryExpression(query: string, operator: 'OR' | 'AND' = 'OR'): string {
  // Normalize and tokenize
  const tokens = query
    .toLowerCase()
    .replace(/[^\w\s$]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !STOPWORDS.has(w));

  if (tokens.length === 0) {
    return '';
  }

  const clauses: string[] = [];

  for (const token of tokens) {
    const lemma = LEMMA_CANONICAL_MAP[token] || token;
    const synCluster = SEMANTIC_CLUSTER_MAP[lemma];

    if (synCluster && synCluster.length > 0) {
      // Bounded synonym group: (syn1 OR syn2 OR ...)
      const uniqueSyns = Array.from(new Set([token, lemma, ...synCluster]));
      const synExpr = uniqueSyns.map(s => s.includes(' ') ? `"${s}"` : (s === '$' ? '"$"' : s)).join(' OR ');
      clauses.push(`(${synExpr})`);
    } else {
      // Literal token or phrase
      if (token === '$') {
        clauses.push('"$"');
      } else {
        clauses.push(token);
      }
    }
  }

  return clauses.join(` ${operator} `);
}

/**
 * Stage A: Deterministic Exact-Subject Cluster Retrieval
 */
export async function retrieveStageAExactSubject(
  query: string,
  status: string = 'active',
  ezzyId?: string
): Promise<string[]> {
  const normQuery = normalizeSubject(query);
  if (!normQuery) return [];

  const ezzyClause = ezzyId ? ` AND ezzy_id = ?` : ``;
  const ezzyArgs = ezzyId ? [ezzyId] : [];

  // 1. Direct match on subject_normalized in memory_search_projection
  const directRows = await querySql(
    `SELECT memory_id FROM memory_search_projection WHERE subject_normalized = ? AND status = ?${ezzyClause} ORDER BY createdAt ASC;`,
    [normQuery, status, ...ezzyArgs]
  );
  if (directRows && directRows.length > 0) {
    return directRows.map((r: any) => r.memory_id);
  }

  // 2. Extract potential subject substring (e.g., "Mum's sold items" from "What's in Mum's sold items?")
  const listRegexes = [
    /(?:in|from|about|on)\s+([a-zA-Z0-9'’\s]+(?:items?|list|checklist|records?|sales?|notes?))/i,
    /([a-zA-Z0-9'’\s]+(?:sold items?|checklist|shopping list|todo list|packing list))/i,
    /(?:everything\s+we\s+sold\s+for\s+|grand\s+total\s+from\s+)([a-zA-Z0-9'’\s]+)/i,
  ];

  for (const regex of listRegexes) {
    const match = query.match(regex);
    if (match && match[1]) {
      const extractedNorm = normalizeSubject(match[1]);
      if (extractedNorm) {
        const subRows = await querySql(
          `SELECT memory_id FROM memory_search_projection WHERE (subject_normalized = ? OR subject_normalized LIKE ?) AND status = ?${ezzyClause} ORDER BY createdAt ASC;`,
          [extractedNorm, `%${extractedNorm}%`, status, ...ezzyArgs]
        );
        if (subRows && subRows.length > 0) {
          return subRows.map((r: any) => r.memory_id);
        }
      }
    }
  }

  // 3. Match against distinct subjects in projection by checking token overlap
  const distinctSubjects = await querySql(
    `SELECT DISTINCT subject_normalized FROM memory_search_projection WHERE subject_normalized IS NOT NULL AND status = ?${ezzyClause};`,
    [status, ...ezzyArgs]
  );

  const queryWords = normQuery.split(/\s+/).map(w => LEMMA_CANONICAL_MAP[w] || w);
  const queryWordSet = new Set(queryWords);

  const CONTAINER_WORDS = new Set(['list', 'lists', 'item', 'items', 'record', 'records', 'note', 'notes', 'checklist', 'collection', 'set']);

  for (const row of distinctSubjects) {
    const subj = row.subject_normalized;
    if (!subj) continue;
    const subjWords = subj
      .split(/\s+/)
      .map((w: string) => LEMMA_CANONICAL_MAP[w] || w)
      .filter((w: string) => !STOPWORDS.has(w) && !CONTAINER_WORDS.has(w));
    if (subjWords.length === 0) continue;

    // Check if all discriminating subject words are present in query
    const allPresent = subjWords.every((w: string) => queryWordSet.has(w));
    if (allPresent) {
      const clusterRows = await querySql(
        `SELECT memory_id FROM memory_search_projection WHERE subject_normalized = ? AND status = ?${ezzyClause} ORDER BY createdAt ASC;`,
        [subj, status, ...ezzyArgs]
      );
      if (clusterRows && clusterRows.length > 0) {
        return clusterRows.map((r: any) => r.memory_id);
      }
    }
  }

  return [];
}

/**
 * Stage B: Lexical FTS5 Retrieval with BM25 Ranking
 */
export async function retrieveStageBFts(
  query: string,
  limit: number = MAX_FTS_INITIAL_CANDIDATES,
  ezzyId?: string
): Promise<ScoredCandidate[]> {
  const ftsExpression = buildFtsQueryExpression(query);
  if (!ftsExpression) return [];

  try {
    const sql = ezzyId
      ? `SELECT f.memory_id, f.content, f.original_text, f.people, f.places, f.topics, f.retrieval_cues, f.items, f.subject,
                bm25(memories_fts, 2.0, 1.0, 1.5, 1.2, 1.2, 1.0, 1.0, 1.5) as bm25_score
         FROM memories_fts f
         JOIN memory_search_projection msp ON f.memory_id = msp.memory_id
         WHERE memories_fts MATCH ? AND msp.ezzy_id = ?
         ORDER BY bm25_score ASC
         LIMIT ?;`
      : `SELECT memory_id, content, original_text, people, places, topics, retrieval_cues, items, subject,
                bm25(memories_fts, 2.0, 1.0, 1.5, 1.2, 1.2, 1.0, 1.0, 1.5) as bm25_score
         FROM memories_fts
         WHERE memories_fts MATCH ?
         ORDER BY bm25_score ASC
         LIMIT ?;`;

    const args = ezzyId ? [ftsExpression, ezzyId, limit] : [ftsExpression, limit];
    const rows = await querySql(sql, args);

    if (!rows || !Array.isArray(rows)) return [];

    return rows.map((r: any) => ({
      memory_id: r.memory_id,
      content: r.content || '',
      original_text: r.original_text || '',
      people: r.people || '',
      places: r.places || '',
      topics: r.topics || '',
      retrieval_cues: r.retrieval_cues || '',
      items: r.items || '',
      subject: r.subject || '',
      bm25_score: Number(r.bm25_score) || 0,
    }));
  } catch (err: any) {
    // If syntax error in FTS expression (e.g. strange quotes), fallback to simple token OR match
    try {
      const fallbackExpr = query
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !STOPWORDS.has(w.toLowerCase()))
        .join(' OR ');

      if (!fallbackExpr) return [];

      const fallbackSql = ezzyId
        ? `SELECT f.memory_id, f.content, f.original_text, f.people, f.places, f.topics, f.retrieval_cues, f.items, f.subject,
                  bm25(memories_fts) as bm25_score
           FROM memories_fts f
           JOIN memory_search_projection msp ON f.memory_id = msp.memory_id
           WHERE memories_fts MATCH ? AND msp.ezzy_id = ?
           ORDER BY bm25_score ASC
           LIMIT ?;`
        : `SELECT memory_id, content, original_text, people, places, topics, retrieval_cues, items, subject,
                  bm25(memories_fts) as bm25_score
           FROM memories_fts
           WHERE memories_fts MATCH ?
           ORDER BY bm25_score ASC
           LIMIT ?;`;

      const fallbackArgs = ezzyId ? [fallbackExpr, ezzyId, limit] : [fallbackExpr, limit];
      const fallbackRows = await querySql(fallbackSql, fallbackArgs);
      return (fallbackRows || []).map((r: any) => ({
        memory_id: r.memory_id,
        content: r.content || '',
        original_text: r.original_text || '',
        people: r.people || '',
        places: r.places || '',
        topics: r.topics || '',
        retrieval_cues: r.retrieval_cues || '',
        items: r.items || '',
        subject: r.subject || '',
        bm25_score: Number(r.bm25_score) || 0,
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Stage C1: Semantic Query Reformulation via Gemini 3.7 Flash
 */
export async function reformulateQueryStageC(
  userQuestion: string,
  nowIso: string,
  roleLabels: string[] = []
): Promise<string[]> {
  const ai = getGeminiClient();
  if (!ai) return [];

  const systemInstruction = `You are a search query reformulator for a personal memory assistant.
The user is asking a question about their personal notes, past activities, or stored facts.
Their exact search returned no direct keyword matches.

Generate 3 distinct search phrases or keyword queries that represent different ways the same information might be recorded in short personal notes.
Respond ONLY with a JSON object matching this schema:
{
  "queries": ["phrase 1", "phrase 2", "phrase 3"]
}`;

  const prompt = `User Question: "${userQuestion}"
Current Reference Time: "${nowIso}"
Known Abstract Context Roles: ${JSON.stringify(roleLabels)}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.7-flash',
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            queries: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['queries'],
        },
        temperature: 0.2,
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    if (Array.isArray(parsed.queries)) {
      return parsed.queries.slice(0, MAX_REFORMULATIONS);
    }
  } catch (err) {
    console.warn('[Stage C Reformulation] Error generating queries:', err);
  }

  return [];
}

/**
 * Stage C3: Optional Bounded Semantic Reranking via Gemini 3.7 Flash
 */
export async function rerankCandidatesStageC(
  userQuestion: string,
  compactCandidates: Array<{ id: string; text: string; cues: string; topics: string }>
): Promise<string[]> {
  if (compactCandidates.length === 0) return [];

  const ai = getGeminiClient();
  if (!ai) return compactCandidates.slice(0, MAX_RERANK_OUTPUT).map(c => c.id);

  const systemInstruction = `You are a retrieval relevance ranker.
Select ONLY the memory ID(s) from the candidate list that directly answer or provide relevant context for the user's question.
If none of the candidates are relevant to the user's question, return an empty array [].
Return at most 3 matching IDs.

Respond ONLY with a JSON object matching this schema:
{
  "relevant_ids": ["id1", "id2"]
}`;

  const prompt = `User Question: "${userQuestion}"

Candidate Memories:
${JSON.stringify(compactCandidates.slice(0, MAX_RERANK_INPUT), null, 2)}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.7-flash',
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            relevant_ids: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            reasoning: { type: Type.STRING },
          },
          required: ['relevant_ids'],
        },
        temperature: 0.1,
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    if (Array.isArray(parsed.relevant_ids)) {
      return parsed.relevant_ids.slice(0, MAX_RERANK_OUTPUT);
    }
  } catch (err) {
    console.warn('[Stage C Rerank] Error reranking candidates:', err);
  }

  return compactCandidates.slice(0, MAX_RERANK_OUTPUT).map(c => c.id);
}

/**
 * Executes the complete Stage A -> Stage B -> Stage C Native Retrieval Pipeline in Shadow Mode.
 */
export async function executeNativeRetrievalPipeline(options: {
  question: string;
  nowIso: string;
  activeRoleLabels?: string[];
  legacyCandidateIds?: string[];
  targetStatus?: string;
}): Promise<NativeRetrievalResult> {
  const { question, nowIso, activeRoleLabels = [], legacyCandidateIds = [], targetStatus = 'active' } = options;
  const startTotal = Date.now();

  const telemetry: ShadowRetrievalTelemetry = {
    query: question,
    timestamp: new Date().toISOString(),
    legacy_ids: [...legacyCandidateIds],
    native_ids: [],
    intersection_ids: [],
    legacy_only_ids: [],
    native_only_ids: [],
    stage_route: 'zero_result',
    stage_c_triggered: false,
    stage_c_reason: null,
    stage_a_count: 0,
    stage_b_count: 0,
    stage_c_count: 0,
    native_hydrated_count: 0,
    timings: {
      stage_a_ms: 0,
      stage_b_ms: 0,
      stage_c_ms: 0,
      hydration_ms: 0,
      total_native_ms: 0,
    },
    gemini_calls_made: {
      reformulation: false,
      rerank: false,
    },
    error: null,
  };

  try {
    // -------------------------------------------------------------
    // STAGE A: Exact Subject / Sibling Expansion
    // -------------------------------------------------------------
    const startA = Date.now();
    const stageASubjectIds = await retrieveStageAExactSubject(question, targetStatus);
    telemetry.timings.stage_a_ms = Date.now() - startA;
    telemetry.stage_a_count = stageASubjectIds.length;

    let finalFtsIds: string[] = [];

    // -------------------------------------------------------------
    // STAGE B: Lexical FTS5 Match
    // -------------------------------------------------------------
    const startB = Date.now();
    const ftsCandidates = await retrieveStageBFts(question, MAX_FTS_INITIAL_CANDIDATES);
    telemetry.timings.stage_b_ms = Date.now() - startB;
    telemetry.stage_b_count = ftsCandidates.length;

    const isConfident = isRetrievalConfident(question, ftsCandidates);

    // -------------------------------------------------------------
    // STAGE C: Bounded Semantic Rescue Evaluation
    // -------------------------------------------------------------
    const isConversationalGreeting = isGreeting(question);
    const shouldTriggerStageC =
      !isConversationalGreeting &&
      stageASubjectIds.length === 0 &&
      (ftsCandidates.length === 0 || !isConfident);

    if (shouldTriggerStageC) {
      telemetry.stage_c_triggered = true;
      telemetry.stage_c_reason = ftsCandidates.length === 0
        ? 'ZERO_FTS_CANDIDATES'
        : 'LOW_CONFIDENCE_DISCRIMINATING_TOKEN_MISS';

      const startC = Date.now();
      telemetry.gemini_calls_made.reformulation = true;
      const reformulatedPhrases = await reformulateQueryStageC(question, nowIso, activeRoleLabels);

      let secondaryCandidates: ScoredCandidate[] = [];
      if (reformulatedPhrases.length > 0) {
        // Execute secondary FTS search using reformulated phrases
        const combinedReformExpr = reformulatedPhrases
          .map(p => buildFtsQueryExpression(p))
          .filter(Boolean)
          .join(' OR ');

        if (combinedReformExpr) {
          const secRows = await querySql(
            `SELECT memory_id, content, original_text, people, places, topics, retrieval_cues, items, subject,
                    bm25(memories_fts) as bm25_score
             FROM memories_fts
             WHERE memories_fts MATCH ?
             ORDER BY bm25_score ASC
             LIMIT ?;`,
            [combinedReformExpr, MAX_STAGE_C_FTS_CANDIDATES]
          );

          if (secRows && Array.isArray(secRows)) {
            secondaryCandidates = secRows.map((r: any) => ({
              memory_id: r.memory_id,
              content: r.content || '',
              original_text: r.original_text || '',
              people: r.people || '',
              places: r.places || '',
              topics: r.topics || '',
              retrieval_cues: r.retrieval_cues || '',
              items: r.items || '',
              subject: r.subject || '',
              bm25_score: Number(r.bm25_score) || 0,
            }));
          }
        }
      }

      telemetry.stage_c_count = secondaryCandidates.length;

      if (secondaryCandidates.length === 1) {
        finalFtsIds = [secondaryCandidates[0].memory_id];
      } else if (secondaryCandidates.length >= 2) {
        telemetry.gemini_calls_made.rerank = true;
        const compactPayload = secondaryCandidates.map(c => ({
          id: c.memory_id,
          text: c.content || c.original_text,
          cues: c.retrieval_cues,
          topics: c.topics,
        }));
        finalFtsIds = await rerankCandidatesStageC(question, compactPayload);
      } else {
        finalFtsIds = [];
      }

      telemetry.timings.stage_c_ms = Date.now() - startC;
      telemetry.stage_route = finalFtsIds.length > 0 ? 'stage_c' : 'zero_result';
    } else {
      // Stage B was confident or Stage A matched
      finalFtsIds = ftsCandidates.map(c => c.memory_id);
      if (stageASubjectIds.length > 0) {
        telemetry.stage_route = 'stage_a';
      } else if (finalFtsIds.length > 0) {
        telemetry.stage_route = 'stage_b';
      } else {
        telemetry.stage_route = 'zero_result';
      }
    }

    // -------------------------------------------------------------
    // UNION, DEDUPLICATION & HYDRATION CAPPING
    // -------------------------------------------------------------
    const subjectIdSet = new Set(stageASubjectIds);
    // Remove exact-subject siblings from fuzzy candidates to avoid duplicate slots
    const uniqueFuzzyIds = finalFtsIds.filter(id => !subjectIdSet.has(id));

    // Cap fuzzy candidates strictly at MAX_FUZZY_HYDRATED (15)
    const cappedFuzzyIds = uniqueFuzzyIds.slice(0, MAX_FUZZY_HYDRATED);

    // Final combined ID set (All exact-subject siblings preserved + capped fuzzy candidates)
    const finalHydrationIds = [...stageASubjectIds, ...cappedFuzzyIds];
    telemetry.native_ids = [...finalHydrationIds];

    // -------------------------------------------------------------
    // BOUNDED DATABASE HYDRATION
    // -------------------------------------------------------------
    const startHydrate = Date.now();
    let hydratedMemories: any[] = [];

    if (finalHydrationIds.length > 0) {
      const placeholders = finalHydrationIds.map(() => '?').join(',');
      const rows = await querySql(
        `SELECT * FROM memories WHERE id IN (${placeholders}) AND status = ?;`,
        [...finalHydrationIds, targetStatus]
      );
      if (rows && Array.isArray(rows)) {
        // Preserve ranking / subject cluster order
        const rowMap = new Map(rows.map((r: any) => [r.id, r]));
        for (const id of finalHydrationIds) {
          const item = rowMap.get(id);
          if (item) hydratedMemories.push(item);
        }
      }
    }

    telemetry.timings.hydration_ms = Date.now() - startHydrate;
    telemetry.native_hydrated_count = hydratedMemories.length;

    // -------------------------------------------------------------
    // DISCREPANCY & COMPARISON METRICS
    // -------------------------------------------------------------
    const nativeSet = new Set(telemetry.native_ids);
    const legacySet = new Set(telemetry.legacy_ids);

    telemetry.intersection_ids = telemetry.legacy_ids.filter(id => nativeSet.has(id));
    telemetry.legacy_only_ids = telemetry.legacy_ids.filter(id => !nativeSet.has(id));
    telemetry.native_only_ids = telemetry.native_ids.filter(id => !legacySet.has(id));

  } catch (err: any) {
    telemetry.error = err?.message || String(err);
    console.error('[Native Retrieval Shadow Error]:', err);
  } finally {
    telemetry.timings.total_native_ms = Date.now() - startTotal;
  }

  return {
    candidateMemories: [], // SHADOW MODE: Returns empty array to ensure zero leakage into prompt
    telemetry,
  };
}

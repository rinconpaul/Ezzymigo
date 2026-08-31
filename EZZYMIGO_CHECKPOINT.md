# EZZYMIGO ARCHITECTURAL CHECKPOINT & KNOWN STATE

**Last Updated**: 31 August 2026  
**Document Status**: Authoritative Architecture Checkpoint (Phase 1 Rescue Baseline)  

> ⚠️ **CRITICAL SOURCE OF TRUTH DIRECTIVE**  
> **Production code is the sole authority.** This document describes the application that actually exists in production code today. If this document and production code ever disagree, **production code wins** and this document must be corrected immediately. Under no circumstances should planned, proposed, or experimental designs be documented as implemented unless verified in production code.

---

## 1. System Overview & Runtime Architecture

Ezzymigo is a personal intention memory assistant powered by Gemini 2.5 Flash, full-text deterministic candidate retrieval, and structured persistence. It enables users to capture natural language intentions (Tell), answer grounded personal queries without general web hallucinations (Ask), view deterministic daily agendas (TODAY), and integrate personal schedules via Google Calendar.

* **Frontend**: Single-page application built with React 19 (`^19.0.1`), Vite, Tailwind CSS, Lucide icons, and Motion animations.
* **Backend**: Node.js Express server running on Google Cloud Run container infrastructure.
* **AI Provider**: Google GenAI SDK (`@google/genai` 0.1.2) utilizing `gemini-2.5-flash` strictly server-side.
* **Production Build**: `vite build` for client bundle + `esbuild server.ts` bundled into CommonJS `dist/server.cjs`.

---

## 2. Persistence Layer (Bunny Database / libSQL)

The database persistence layer is **Bunny Database / libSQL** (SQLite-compatible cloud-backed SQL), accessed via `server/db/client.ts` over HTTP `/v2/pipeline`. **Firestore is NOT used.**

### Core Tables & Stores (`server/db/schema.ts`):
1. `memories`: Stores original capture text, created timestamp, completion status (`isDone`), structured content, kind (`fact`, `intention`, `decision`, etc.), status, entity arrays (people, places, topics as JSON strings), and resurfacing metadata.
2. `calendar_events`: Canonical local cache of external Google Calendar events (`id`, `source`, `sourceEventId`, `title`, `description`, `location`, `attendees`, `startDatetime`, `endDatetime`, `isAllDay`, `status`, `updatedAt`).
3. `user_relationships`: Stores resolved human relationships (`id`, `person`, `role`, `normalized_role`, `is_active`, `updated_at`) supporting singular-role supersession and active/inactive state.
4. `user_entities`: Secondary directory of recognized personal entities (`id`, `name`, `entity_type`, `role`, `normalized_role`, `metadata`, `updated_at`).
5. `scheduled_reminders`: Dispatched time-based reminders linked to source memories (`id`, `memoryId`, `title`, `body`, `remindAt`, `notified`, `createdAt`).
6. `push_subscriptions` & `vapid_config`: Web Push registration endpoints and keys.

> ⚠️ **Single Live Database Notice**: There is currently **only one live database** in the application environment. There is no separate or isolated test/staging database.

---

## 3. Implemented Subsystems & Pipelines

### A. Tell Pipeline (Capture, Splitting, Interpretation & Persistence)
* **Capture UI**: `src/components/InputSection.tsx` captures natural language text or voice transcriptions.
* **Route & Logic**: `server.ts` -> `app.post("/api/memories")` -> `server/ai/interpreter.ts:interpretMemoryWithGemini()`.
* **Multi-Intention Splitting**: Gemini decomposes compound inputs (e.g. "Buy milk and call Dave on Friday") into discrete, structured memory items.
* **Information-Preservation**: The original raw utterance is preserved in `originalText`. Interpretation schema extracts `content`, `kind`, `people`, `places`, `topics`, `contexts`, `retrieval_cues`, `timing`, `resurfacing`, and `relationships`.
* **Relationship Extraction**: Any detected `relationships` in the payload are automatically processed through `server/relationships/index.ts:saveRelationships()` which handles normalized role aliasing and active/deactivated state updates.

### B. Ask Pipeline (Deterministic Retrieval + Grounded Gemini Synthesis)
* **Q&A Interface**: `src/components/AskSection.tsx`.
* **Route**: `server.ts` -> `app.post("/api/ask")`.
* **Pipeline Flow**:
  1. **Full Database Read (Current Scalability Constraint)**: Server fetches `readMemories()`, `readCalendarEvents()`, and `getActiveRelationships()`.
  2. **DCR Candidate Retrieval (`server/retrieval/dcr.ts`)**: Deterministic Candidate Retrieval (DCR v1) scores and filters candidates locally in Node memory. It performs query normalization, stop-word elimination, entity/role resolution against active relationships, temporal anchor parsing (months, relative day calculations), generic schedule intent detection, and keyword/token matching.
  3. **Bounded Candidate Window**: Only top-scoring candidate memories and relevant calendar events are bundled into the prompt context. **The entire personal database is NOT sent to Gemini.**
  4. **Strict Scope & Citations**: Gemini synthesizes an answer strictly grounded in the candidate context. The response schema returns `{ answer, memory_ids, calendar_event_ids, is_out_of_scope }`.
  5. **Out-of-Scope Guard**: General knowledge queries without personal grounding return friendly deflections (`is_out_of_scope: true`) with empty ID arrays.
  6. **Separation of Stores**: Memories and calendar events remain distinct database stores throughout retrieval and citation mapping.

### C. TODAY / Daily Relevance Engine
* **UI**: `src/components/TodayTicker.tsx`.
* **Route & Engine**: `server.ts` -> `app.get("/api/today-relevance")` -> `server/today/relevance.ts:computeTodayRelevance()`.
* **Zero-LLM Execution**: Pure deterministic scoring and ranking evaluated in Node with zero LLM API latency on app load.
* **Eligibility Rules**: Evaluates active memories, scheduled reminders due today, and calendar events against the user's local timezone date (`clientTodayYMD`). Prevents past, completed, or irrelevant future items from surfacing.

### D. Google Calendar Integration (Current Implementation)
* **Client-Side OAuth**: Client requests short-lived access tokens via Google Identity Services (`initTokenClient`) directly in browser memory.
* **Discovery & Event Types**: Multi-calendar discovery and query fetching with support for standard events and `eventTypes` (including Google Calendar birthdays).
* **Sync Window**: Rolling sync window of -2 days to +60 days (capturing from 2 days prior through `DEFAULT_CALENDAR_SYNC_DAYS_AHEAD = 60` days ahead, up to 250 events per calendar).
* **Local Caching**: Synced events are upserted into the `calendar_events` table in Bunny DB with deterministic canonical IDs.
* **Current Limitations**: No server-side refresh tokens (tokens expire when browser session ends), no automated background sync without client interaction, and limited historical event coverage outside the rolling window.

### E. Relationships & Entity Resolution
* **Module**: `server/relationships/index.ts`.
* **Role Resolution**: Normalizes common aliases (e.g. "mum" -> "mother", "gardener", "doctor", "plumber").
* **Singular-Role Supersession**: Assigning a new person to a singular role deactivates prior holders while preserving audit history.
* **Deactivated Knowledge Suppression**: Forgotten or deactivated relationships are filtered out during Ask queries, preventing obsolete relationship claims.

---

## 4. Health Check Specification & Verification Baseline

### Route: `GET /api/health`
* **Implementation**: Explicit route in `server.ts` positioned before Vite/SPA catch-all middleware. Returns `application/json` with HTTP 200 (healthy) or HTTP 503 (unhealthy).
* **Checks Included**:
  1. `checks.database`: Executes `SELECT 1 as health_check;` against Bunny DB, measuring roundtrip latency (`latency_ms`). Returns `status: "ok"` on success, or `status: "error"` with HTTP 503 on database query failure.
  2. `checks.gemini_config`: Verifies `process.env.GEMINI_API_KEY` is present and non-empty (`configured: true`).

> ⚠️ **Health Endpoint Qualification**:
> * The **healthy database path** (HTTP 200, JSON response, latency reporting) was **live-verified against Bunny DB**.
> * The **database failure / 503 path** was verified by **code inspection and structural logic review**, NOT live fault injection.
> * `gemini_config.status: ok` means **only** that `GEMINI_API_KEY` is configured/present in the environment. It does **NOT** prove the key is valid or that the Gemini upstream API is reachable. No paid generation requests are made on health checks.

---

## 5. Testing & Verification Baseline

* **Ask Parity Harness (`scripts/test-ask-parity.ts`)**:
  * Evaluates 12 core query archetypes + database immutability audit across live `/api/ask` and Bunny DB.
  * **Collision-Proof Fixtures**: Uses reserved fixture identities (`ZzTestFixturePlumberAlpha`, `ZzTestFixtureMechanicBeta`) inserted via direct raw SQL to prevent singular-role supersession against genuine user data.
  * **Deterministic Teardown**: Guaranteed fixture cleanup in `finally` block targeting exact test IDs.
  * **Verified Live Baseline**: **13 / 13 PASSED (100%)** on 31 August 2026.
  * **Safety Audit**: Post-run verification confirmed 0 leftover test fixtures, and all 22 pre-existing real relationship rows remained **100% unchanged field-for-field**.

---

## 6. Known Architectural & Scalability Limitations

1. **Full-Table In-Memory Loading**: `/api/ask` currently reads entire tables (`readMemories()`, `readCalendarEvents()`) from Bunny DB over HTTP before DCR filtering occurs in Node. While efficient for current dataset sizes (<1,000 items), database-level SQL filtering and indexing are needed for long-term multi-thousand record scalability.
2. **Single Database Environment**: No separate development/staging/production database instances exist; all tests and application sessions share the single configured Bunny DB.
3. **Browser-Memory Calendar Tokens**: Google OAuth access tokens reside only in browser client memory. There is no server-side offline refresh-token store or background daemon synchronization.
4. **Rolling Calendar Window**: Calendar sync covers -2 to +60 days; historical multi-year event retrieval requires manual pagination or explicit archive sync.
5. **DCR & TODAY Module Size**: `server/retrieval/dcr.ts` and `server/today/relevance.ts` contain dense heuristic scoring blocks that would benefit from modular decomposition.
6. **Gemini Rate & Cost Guard**: Current endpoints lack token-bucket rate limiting or per-user cost caps.

---

## 7. Rescue & Implementation Phase Status

* **Phase 0 (Safety & Health Baseline)**: ✅ **COMPLETE** (Ask test fixture collision-proofing verified live; genuine `/api/health` endpoint implemented and verified).
* **Phase 1 (Authoritative Checkpoint)**: ✅ **COMPLETE** (This document).
* **Phase 2+ (Architecture, Portability & Functional Enhancements)**: 🛑 **NOT IMPLEMENTED** (Strictly frozen pending explicit authorization).

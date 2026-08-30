# Ezzymigo Project Handover Checkpoint

**Date**: 2026-08-23  
**Status**: Active Handover Documentation  
**Primary Stack**: React 18, Vite, Express (full-stack container on Cloud Run), Firebase Firestore, Google GenAI SDK (`gemini-2.5-flash`), Google Calendar API (OAuth), Web Push.

---

## 1. Executive Summary & Current Implemented Architecture

Ezzymigo is an AI-powered personal memory and intention assistant that captures user thoughts, structures them into actionable intention memories, provides intelligent grounding via search/calendar, surfaces daily relevant items, and answers questions using contextual reasoning.

---

## 2. Implemented Subsystems & Code References

### A. Tell Ezzymigo (Capture, Multi-Memory Splitting & Interpretation)
* **Description**: Users enter raw natural-language thoughts. The backend interprets the intention using Gemini 2.5 Flash, automatically detecting and splitting multi-part intentions (e.g. "Buy milk and call dentist on Friday") into discrete intention records.
* **Key Files & Handlers**:
  * `src/components/InputSection.tsx`: UI text area and voice/text capture.
  * `server.ts` -> `app.post("/api/memories")`: Handles prompt assembly and calls `interpretMemoryWithGemini()`.
  * `interpretMemoryWithGemini()` in `server.ts`: Uses structured schema output to extract `kind`, `content`, `people`, `places`, `topics`, `timing`, `actionableSteps`, and `priority`.

### B. Firestore Memory Persistence
* **Description**: Persistent cloud storage backing all memories, status toggles, edits, and deletions.
* **Key Files & Helpers**:
  * `server.ts` -> `getAllMemories(userId)`, `saveMemory(userId, memory)`, `updateMemory(userId, id, updates)`, `deleteMemory(userId, id)`.
  * `firebase-applet-config.json` & `firestore.rules`: Firebase configuration and access rules.

### C. Ask Ezzymigo & Google Calendar Integration
* **Description**: Natural language Q&A interface that answers user questions grounded in their stored memories and scheduled Google Calendar events.
* **Key Files & Handlers**:
  * `src/components/AskSection.tsx`: Search/question input, answer streaming/rendering, and suggestion display.
  * `server.ts` -> `app.post("/api/ask")`: Fetches user memories, retrieves Google Calendar events (range: -30 days to +90 days, max 250 events via Google OAuth token), and prompts Gemini 2.5 Flash.

### D. Surfaced Supporting Memory Cards
* **Description**: Beneath the Ask response, Ezzymigo renders interactive memory cards directly corresponding to the memories referenced in the answer, allowing immediate toggle, edit, or delete actions without leaving the Ask context.
* **Key Files**:
  * `src/components/AskSection.tsx` & `src/components/MemoryCard.tsx`.

### E. Reminder Functionality & Background Web Push
* **Description**: Timed reminders with automated scheduling and browser/mobile push notifications via Service Worker.
* **Key Files**:
  * `src/utils/pushManager.ts`: Client-side subscription and permission management.
  * `public/sw.js`: Background Web Push event listener (`push` and `notificationclick`).
  * `server.ts` -> `app.post("/api/reminders")` & background push dispatch scheduler.

### F. Internationalisation Architecture
* **Description**: Timezone, language, region, and currency awareness. Client passes local formatting preferences with every request.
* **Key Files**:
  * `src/utils/userPreferences.ts`: `getUserPreferences()`, `setUserPreferences()`, and locale defaults (`Australia/Sydney`, `en-AU`, `AUD`).

### G. Suggested Actions & Grounded External Lookup
* **Description**: Actionable suggestion buttons generated alongside Ask responses, including Google Search grounding / external links.
* **Key Files**:
  * `server.ts` -> Gemini function/search integration in `/api/ask`.
  * `src/components/AskSection.tsx`: Action button renderers.

### H. Today Relevance Backend
* **Description**: Deterministic daily relevance ranking engine evaluating active memories and calendar events against local date, time, and stored structured metadata (no LLM latency on app load).
* **Key Files**:
  * `server.ts` -> `computeTodayRelevance()`, `app.get("/api/today-relevance")`, `app.post("/api/today-relevance")`.
  * `src/components/TodayTicker.tsx`.

---

## 3. Current In-Progress & Resolved Issues

### ✅ Resolved Issue: Today Relevance Per-Load LLM Latency & Double-Fetch
* **Resolution**:
  * **Zero LLM Overhead**: Replaced per-load Gemini generative prompt in `computeTodayRelevance` with fast, deterministic ranking (Priority 1: Reminders strictly due today; Priority 2: Calendar events today; Priority 3: Memories with resolved/event dates today; Priority 4: Explicitly pinned intentions for today).
  * **Temporal Anchoring Fix**: Relative time expressions (e.g. "tomorrow morning") are permanently anchored at capture time into absolute ISO timestamps (`resolved_datetime` / `reminder_datetime`). Today relevance strictly compares the absolute resolved date against `clientTodayYMD` in the user's timezone (`remYMD === clientTodayYMD`), preventing past or stale reminders from resurfacing as "today" and preventing matches against literal "today" substrings in historical retrieval cues.
  * **Single Request per Load**: Removed React StrictMode double-invocation and added component mount fetch deduplication ref.
  * **Latency**: Reduced backend processing time from ~4.5–5.5s (LLM inference) down to local database query execution (~10–50ms).
  * **Compatibility**: Kept exact `TodayRelevanceCandidate` schema, `source_id` mapping, and `TodayTicker` tap / surfaced card interactions.

### ⚠️ Pending Engineering Task: `/api/ask` Full-Memory Context Dump (Scalability Bottleneck)
* **Current Discovery**:
  * `/api/ask` currently executes `readMemories()` with **no pre-filtering**, sending every memory document directly into the Gemini prompt.
  * Hard limit is currently uncapped (limited only by model context window).
  * While functional for small sets (<200 memories), this will become slow, expensive, and eventually exceed context/token limits at 500, 5,000, or 50,000 memories.

---

## 4. Key Architectural Decisions

1. **Memory Lifecycle**:
   * Memories persist indefinitely in Firestore until **explicitly deleted** by the user.
   * Marking a memory as `Done` (`isDone: true`) **preserves** historical memory and does not delete it. Completed items remain searchable and accessible.
2. **Next Planned Engineering Task**:
   * Implement a scalable **Semantic Candidate Retrieval / Embeddings pipeline** before Gemini reasoning in `/api/ask` (e.g. vector similarity search, structured metadata filtering, and relevance thresholding).
3. **Pending Security & Storage Audit**:
   * A comprehensive audit is still required for:
     - Exact Bunny.net CDN / storage usage and integration.
     - Firestore user isolation and multi-tenant security rule validation.
     - Environment variable and credential exposure checks.

---

## 5. Quick Reference Directory Map

| Path | Description |
|---|---|
| `/src/App.tsx` | Main application shell, state management, and component mounting |
| `/src/components/TodayTicker.tsx` | Today's relevant memories ticker and diagnostic banner |
| `/src/components/AskSection.tsx` | Ask Ezzymigo chat, supporting memory cards, and suggested actions |
| `/src/components/InputSection.tsx` | Tell Ezzymigo capture interface |
| `/src/components/MemoryCard.tsx` | Individual intention memory card component |
| `/src/utils/userPreferences.ts` | Localisation and timezone configuration helpers |
| `/src/utils/pushManager.ts` | Web Push subscription manager |
| `/public/sw.js` | Service worker for push notification delivery |
| `/server.ts` | Express backend, Gemini API integration, Firestore operations, Calendar API |
| `/dist/` | Production build output (`server.cjs`, `assets/`, `index.html`) |

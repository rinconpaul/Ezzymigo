import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Header } from './components/Header';
import { TodayTicker } from './components/TodayTicker';
import { ThoughtInput } from './components/ThoughtInput';
import { MemoryCard } from './components/MemoryCard';
import { ListCard } from './components/ListCard';
import { AskEzzymigoPanel } from './components/AskEzzymigoPanel';
import { CalendarInspector } from './components/CalendarInspector';
import { DeleteKnowledgeModal, LearnedKnowledgeDeletePrompt } from './components/DeleteKnowledgeModal';
import { OccasionsModal } from './components/OccasionsModal';
import { findAssociatedRelationships } from './utils/relationshipAssociation';
import { initGoogleAuth, AuthState } from './utils/googleCalendarAuth';
import { getUserPreferences } from './utils/userPreferences';
import { defaultDeviceActionLauncher } from './utils/deviceActionLauncher';
import { ephemeralCallBridge } from './utils/ephemeralCallBridge';
import { MemoryItem, InboxFilterType, ClarificationPrompt, UserRelationship, ImmediateDeviceActionPayload, TodayRelevanceCandidate } from './types';

import { Database, AlertCircle, RefreshCw, Search, ChevronDown, Wrench, Sparkles, X, Check, Contact } from 'lucide-react';

const ACTIONABLE_INTENTS = new Set([
  'task',
  'purchase',
  'contact',
  'appointment',
  'follow-up',
  'decision',
  'research',
  'reminder',
]);

const ACTION_VERB_REGEX = /^(?:i\s+need\s+to|need\s+to|i\s+have\s+to|have\s+to|i\s+must|must|i\s+should|should|got\s+to|remember\s+to|don't\s+forget\s+to|todo|book|ring|call|phone|buy|get|pick\s+up|order|pay|email|send|write|make|schedule|arrange|fix|repair|wash|check|ask|tell|remind|take|put|clean|vacuum)\b/i;

function isActionableMemory(item: MemoryItem): boolean {
  const kind = item.interpretation?.kind?.toLowerCase() || '';
  const intent = item.interpretation?.intent?.toLowerCase() || '';
  if (kind === 'reminder' || kind === 'task') return true;
  if (ACTIONABLE_INTENTS.has(intent)) return true;

  // Legacy fallback: if kind is fact but content/originalText is an action imperative
  const text = (item.interpretation?.content || item.originalText || '').trim();
  if (ACTION_VERB_REGEX.test(text)) return true;

  return false;
}

function isNotSureMemory(item: MemoryItem): boolean {
  const kind = item.interpretation?.kind?.toLowerCase() || '';
  const intent = item.interpretation?.intent?.toLowerCase() || '';
  return kind === 'not_sure' || intent === 'not_sure';
}

function matchesInboxClassification(item: MemoryItem, filter: InboxFilterType): boolean {
  if (filter === 'all') return true;
  if (filter === 'reminders') {
    return isActionableMemory(item) && !isNotSureMemory(item);
  }
  if (filter === 'not_sure') {
    return isNotSureMemory(item);
  }
  if (filter === 'facts') {
    return !isActionableMemory(item) && !isNotSureMemory(item);
  }
  return true;
}

/**
 * Deduplicates an array of MemoryItem objects by their unique ID,
 * preserving array ordering on the first occurrence of each unique ID.
 */
export function deduplicateMemories(items: MemoryItem[]): MemoryItem[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const result: MemoryItem[] = [];
  for (const item of items) {
    if (item && item.id && !seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}

export default function App() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inboxFilter, setInboxFilter] = useState<InboxFilterType>('all');
  const [filter, setFilter] = useState<'all' | 'active' | 'done'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [clarification, setClarification] = useState<ClarificationPrompt | null>(null);
  const [clarificationAnswer, setClarificationAnswer] = useState('');
  const [isResolvingClarification, setIsResolvingClarification] = useState(false);
  const [clarificationFeedback, setClarificationFeedback] = useState<string | null>(null);
  const [ephemeralCandidate, setEphemeralCandidate] = useState<TodayRelevanceCandidate | null>(() =>
    ephemeralCallBridge.getCandidate()
  );
  const [deleteKnowledgePrompt, setDeleteKnowledgePrompt] = useState<LearnedKnowledgeDeletePrompt | null>(null);
  const [isDeletingKnowledge, setIsDeletingKnowledge] = useState(false);
  const [activeSubject, setActiveSubject] = useState<string | null>(null);
  const [isSubjectPaused, setIsSubjectPaused] = useState(false);
  const [isOccasionsOpen, setIsOccasionsOpen] = useState(false);
  const tellInputRef = useRef<HTMLTextAreaElement>(null);
  const [authState, setAuthState] = useState<AuthState>({
    isConnected: false,
    user: null,
    email: null,
    displayName: null,
    photoURL: null,
  });

  // Fetch memories from persistent backend storage on mount
  const fetchMemories = async () => {
    setIsFetching(true);
    setError(null);
    try {
      const res = await fetch('/api/memories');
      if (!res.ok) {
        throw new Error(`Failed to load memories (HTTP ${res.status})`);
      }
      const data = await res.json();
      setMemories(deduplicateMemories(data.memories || []));
    } catch (err: any) {
      console.error('Fetch error:', err);
      setError(err?.message || 'Could not connect to storage server.');
    } finally {
      setIsFetching(false);
    }
  };

  useEffect(() => {
    fetchMemories();
    const unsub = initGoogleAuth(setAuthState);
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  // Foreground/background lifecycle listener for ephemeral post-call bridge
  useEffect(() => {
    const handleBackground = () => {
      ephemeralCallBridge.handleAppBackground();
    };

    const handleForeground = () => {
      const candidate = ephemeralCallBridge.handleAppForeground();
      if (candidate) {
        setEphemeralCandidate(candidate);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        handleBackground();
      } else if (document.visibilityState === 'visible') {
        handleForeground();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleBackground);
    window.addEventListener('focus', handleForeground);
    window.addEventListener('pagehide', handleBackground);
    window.addEventListener('pageshow', handleForeground);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleBackground);
      window.removeEventListener('focus', handleForeground);
      window.removeEventListener('pagehide', handleBackground);
      window.removeEventListener('pageshow', handleForeground);
    };
  }, []);

  // Handle immediate device action (tel: or sms:) without creating or persisting memories
  const handleImmediateDeviceAction = useCallback(async (action: ImmediateDeviceActionPayload) => {
    if (action.status === 'ready') {
      const launchResult = await defaultDeviceActionLauncher.launch(action);
      if (launchResult.success && action.action === 'call') {
        ephemeralCallBridge.recordCallLaunch(action.recipientName || 'Contact', action.role);
      }
      setClarificationFeedback(action.feedbackMessage);
      setTimeout(() => {
        setClarificationFeedback((prev) => (prev === action.feedbackMessage ? null : prev));
      }, 6000);
    } else if (action.status === 'missing_number') {
      setClarification({
        id: `missing_number_${Date.now()}`,
        question: action.feedbackMessage,
        entityName: action.recipientName || 'Contact',
        entityType: 'phone_offer',
        metadata: {
          role: action.role,
          isPhoneOffer: true,
        },
      });
      setClarificationAnswer('');
    } else if (action.status === 'ambiguous') {
      setClarification({
        id: `ambig_contact_${Date.now()}`,
        question: action.feedbackMessage,
        entityName: action.recipientName || 'Contact',
        entityType: 'relationship',
        candidateOptions: action.candidates?.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)),
      });
      setClarificationAnswer('');
    } else if (action.status === 'unknown_person') {
      setClarification({
        id: `unknown_contact_${Date.now()}`,
        question: action.feedbackMessage,
        entityName: action.recipientName || 'Contact',
        entityType: 'person',
      });
      setClarificationAnswer('');
    }
  }, []);

  // Save new thought
  const handleSaveThought = async (
    text: string,
    contextOrSubject?: { linkedEventId?: string; eventTitle?: string; subject?: string } | string
  ) => {
    setIsLoading(true);
    setError(null);
    const prefs = getUserPreferences();
    const subjectParam = typeof contextOrSubject === 'string' ? contextOrSubject : contextOrSubject?.subject;
    const linkedEventIdParam = typeof contextOrSubject === 'object' ? contextOrSubject?.linkedEventId : undefined;
    try {
      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalText: text,
          clientNow: new Date().toISOString(),
          clientTimeZone: prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney',
          clientLanguage: prefs.language || 'en-AU',
          clientRegion: prefs.region || 'AU',
          clientCurrency: prefs.currency || 'AUD',
          linkedEventId: linkedEventIdParam || undefined,
          subject: subjectParam || undefined,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error: ${res.statusText}`);
      }

      const data = await res.json();

      // Handle immediate device action (tel: or sms:) without creating or persisting memories
      if (data.deviceAction) {
        await handleImmediateDeviceAction(data.deviceAction as ImmediateDeviceActionPayload);
        return;
      }

      const newItems: MemoryItem[] = Array.isArray(data.memories)

        ? data.memories
        : data.memory
        ? [data.memory]
        : [];

      if (newItems.length > 0) {
        setMemories((prev) => deduplicateMemories([...newItems, ...prev]));

        // Auto-switch filter to 'all' if current filter would hide every newly saved memory
        setInboxFilter((currentFilter) => {
          if (currentFilter === 'all') return currentFilter;
          const anyMatches = newItems.some((item) => matchesInboxClassification(item, currentFilter));
          return anyMatches ? currentFilter : 'all';
        });
      }

      if (data.clarification) {
        setClarification(data.clarification);
        setClarificationAnswer('');
      } else if (data.phoneOffer) {
        setClarification({
          id: `phone_offer_${Date.now()}`,
          question: `Got it — want to add ${data.phoneOffer.person}'s number?`,
          entityName: data.phoneOffer.person,
          entityType: 'phone_offer',
          memoryId: data.memory?.id || (data.memories && data.memories[0]?.id),
          metadata: {
            role: data.phoneOffer.role,
            isPhoneOffer: true,
          },
        });
        setClarificationAnswer('');
      } else {
        setClarification(null);
      }

      if (ephemeralCandidate) {
        ephemeralCallBridge.dismissCandidate();
        setEphemeralCandidate(null);
      }
    } catch (err: any) {
      console.error('Save error:', err);
      setError(err?.message || 'Failed to interpret and save thought.');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  // Resolve Ambiguity Clarification (Ezzymigo Ambiguity Rule)
  const handleResolveClarification = async (answerText: string) => {
    if (!clarification) return;
    setIsResolvingClarification(true);
    try {
      const res = await fetch('/api/clarifications/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clarificationId: clarification.id,
          entityName: clarification.entityName,
          entityType: clarification.entityType,
          answer: answerText,
          candidateChosen: clarification.candidateOptions?.includes(answerText) ? answerText : undefined,
          memoryId: clarification.memoryId,
          metadata: clarification.metadata,
          clientNow: new Date().toISOString(),
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney',
          clientLanguage: 'en-AU',
          clientRegion: 'AU',
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setClarificationFeedback(
          data.message ||
            (clarification.entityType === 'phone_offer'
              ? `Saved ${clarification.entityName}'s phone number.`
              : `Learned: ${clarification.entityName} is your ${answerText}`)
        );
        if (data.phoneOffer) {
          setClarification({
            id: `phone_offer_${Date.now()}`,
            question: `Got it — want to add ${data.phoneOffer.person}'s number?`,
            entityName: data.phoneOffer.person,
            entityType: 'phone_offer',
            memoryId: data.memory?.id || clarification.memoryId,
            metadata: {
              role: data.phoneOffer.role,
              isPhoneOffer: true,
            },
          });
          setClarificationAnswer('');
        } else {
          setClarification(null);
          setClarificationAnswer('');
        }
        setTimeout(() => setClarificationFeedback(null), 5000);
        // Refresh memories from persistent storage deterministically
        await fetchMemories();
      } else {
        setError(data.error || 'Failed to save clarification');
      }
    } catch (err: any) {
      console.error('Clarification error:', err);
      setError('Failed to save clarification.');
    } finally {
      setIsResolvingClarification(false);
    }
  };

  const handleDismissClarification = () => {
    setClarification(null);
    setClarificationAnswer('');
  };

  // Browser Contact Picker API handler (Phase F2)
  const handlePickContact = async () => {
    try {
      if (!('contacts' in navigator && 'ContactsManager' in window)) return;
      const contacts = await (navigator as any).contacts.select(['name', 'tel'], { multiple: false });
      if (contacts && contacts.length > 0) {
        const selected = contacts[0];
        const rawPhone = Array.isArray(selected?.tel) && selected.tel.length > 0
          ? selected.tel[0]
          : (typeof selected?.tel === 'string' ? selected.tel : null);
        const phone = rawPhone ? String(rawPhone).trim() : null;

        if (phone) {
          setClarificationAnswer((prev) => {
            const trimmed = prev.trim();
            if (!trimmed || clarification?.entityType === 'phone_offer') {
              return phone;
            }
            if (trimmed.endsWith(',') || trimmed.endsWith('—') || trimmed.endsWith('-')) {
              return `${trimmed} ${phone}`;
            }
            return `${trimmed}, ${phone}`;
          });
        }
      }
    } catch (err) {
      // Fail silently back to text-only flow if user cancels or permission is denied
      console.debug('[ContactPicker] Contact selection cancelled or failed:', err);
    }
  };

  // Toggle Done / Active
  const handleToggleDone = async (id: string) => {
    try {
      const res = await fetch(`/api/memories/${id}/toggle`, {
        method: 'PATCH',
      });
      if (!res.ok) throw new Error('Failed to update status');
      const data = await res.json();
      
      setMemories((prev) =>
        deduplicateMemories(prev.map((item) => (item.id === id ? data.memory : item)))
      );
    } catch (err: any) {
      console.error('Toggle error:', err);
      setError('Failed to update memory status.');
    }
  };

  // Edit Memory & Re-interpret
  const handleEditMemory = async (id: string, newText: string): Promise<void> => {
    setError(null);
    const prefs = getUserPreferences();
    try {
      const res = await fetch(`/api/memories/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editedText: newText,
          clientNow: new Date().toISOString(),
          clientTimeZone: prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney',
          clientLanguage: prefs.language || 'en-AU',
          clientRegion: prefs.region || 'AU',
          clientCurrency: prefs.currency || 'AUD',
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error: ${res.statusText}`);
      }

      const data = await res.json();
      if (data.memory) {
        setMemories((prev) =>
          deduplicateMemories(prev.map((item) => (item.id === id ? data.memory : item)))
        );
      }
      if (data.phoneOffer) {
        setClarification({
          id: `phone_offer_${Date.now()}`,
          question: `Got it — want to add ${data.phoneOffer.person}'s number?`,
          entityName: data.phoneOffer.person,
          entityType: 'phone_offer',
          memoryId: id,
          metadata: {
            role: data.phoneOffer.role,
            isPhoneOffer: true,
          },
        });
        setClarificationAnswer('');
      }
    } catch (err: any) {
      console.error('Edit error:', err);
      setError(err?.message || 'Failed to re-interpret and update memory.');
      throw err;
    }
  };

  // Delete Memory with Learned Knowledge Awareness
  const handleDelete = async (id: string) => {
    const memory = memories.find((m) => m.id === id);
    if (!memory) return;

    // Check if memory has people/entities associated with active learned knowledge
    try {
      const res = await fetch('/api/relationships');
      if (res.ok) {
        const data = await res.json();
        const activeRels: UserRelationship[] = Array.isArray(data.relationships) ? data.relationships : [];

        // Check memory for genuine person/relationship association (authoritative structured people/relationships, or standalone whole-name fallback)
        const associated = findAssociatedRelationships(memory, activeRels);

        if (associated.length > 0) {
          // Trigger the learned-knowledge-aware delete confirmation modal
          setDeleteKnowledgePrompt({
            memory,
            associatedRelationships: associated,
          });
          return;
        }
      }
    } catch (checkErr) {
      console.warn('Could not check learned relationships for memory deletion:', checkErr);
    }

    // Normal Delete behavior if no reusable learned knowledge is associated
    await performDeleteMemoryOnly(id);
  };

  const performDeleteMemoryOnly = async (id: string) => {
    setIsDeletingKnowledge(true);
    try {
      const res = await fetch(`/api/memories/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete memory');
      setMemories((prev) => deduplicateMemories(prev.filter((item) => item.id !== id)));
      setDeleteKnowledgePrompt(null);
      if (clarification && clarification.memoryId === id) {
        setClarification(null);
        setClarificationAnswer('');
      }
    } catch (err: any) {
      console.error('Delete error:', err);
      setError('Failed to delete memory.');
    } finally {
      setIsDeletingKnowledge(false);
    }
  };

  const performDeleteAndForget = async (personName: string) => {
    if (!deleteKnowledgePrompt) return;
    setIsDeletingKnowledge(true);
    const memoryId = deleteKnowledgePrompt.memory.id;
    try {
      // 1. Delete selected memory
      const deleteRes = await fetch(`/api/memories/${memoryId}`, {
        method: 'DELETE',
      });
      if (!deleteRes.ok) throw new Error('Failed to delete memory');
      setMemories((prev) => deduplicateMemories(prev.filter((item) => item.id !== memoryId)));

      // 2. Forget learned knowledge for this person using existing Forget mechanism
      await fetch('/api/relationships/forget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person: personName }),
      });

      console.log(`[Delete & Forget] Deleted memory ${memoryId} and forgot entity "${personName}".`);
      setDeleteKnowledgePrompt(null);

      // Clear stale clarification if it originated from this deleted memory or matches the forgotten entity
      if (
        clarification &&
        (clarification.memoryId === memoryId ||
          clarification.entityName.toLowerCase() === personName.toLowerCase())
      ) {
        setClarification(null);
        setClarificationAnswer('');
      }
    } catch (err: any) {
      console.error('Delete & Forget error:', err);
      setError(`Failed to complete deletion and forget ${personName}.`);
    } finally {
      setIsDeletingKnowledge(false);
    }
  };

  // Delete an entire List and its memories
  const handleDeleteList = async (subject: string) => {
    try {
      const res = await fetch('/api/lists', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject }),
      });
      if (!res.ok) {
        throw new Error(`Failed to delete list (HTTP ${res.status})`);
      }
      const data = await res.json();
      console.log(`[App] Deleted list "${subject}", count: ${data.count}`);
      if (activeSubject?.trim().toLowerCase() === subject.trim().toLowerCase()) {
        setActiveSubject(null);
        setIsSubjectPaused(false);
      }
      await fetchMemories();
    } catch (err: any) {
      console.error('Delete list error:', err);
      setError(err?.message || 'Failed to delete list.');
    }
  };

  // Add item to an existing list
  const handleAddToList = (subject: string) => {
    setActiveSubject(subject);
    setIsSubjectPaused(false);
    if (tellInputRef.current) {
      tellInputRef.current.focus();
    }
    const el = document.getElementById('tell-ezzymigo-panel');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // Filter & Search Logic
  const filteredMemories = memories.filter((item) => {
    // 1. Inbox Classification filter (All / Reminders / Tasks / Facts / Not Sure)
    if (!matchesInboxClassification(item, inboxFilter)) {
      return false;
    }

    // 2. Active vs. Done status filter
    const matchesFilter =
      filter === 'all'
        ? true
        : filter === 'active'
        ? !item.isDone
        : item.isDone;

    if (!matchesFilter) return false;

    // 3. Search query filter
    if (!searchQuery.trim()) return true;

    const q = searchQuery.toLowerCase();
    const orig = item.originalText?.toLowerCase() || '';
    const content = item.interpretation?.content?.toLowerCase() || '';
    const kind = item.interpretation?.kind?.toLowerCase() || '';
    const subject = item.interpretation?.subject?.toLowerCase() || '';
    const people = (item.interpretation?.people || []).join(' ').toLowerCase();
    const places = (item.interpretation?.places || []).join(' ').toLowerCase();
    const topics = (item.interpretation?.topics || []).join(' ').toLowerCase();
    const cues = (item.interpretation?.retrieval_cues || []).join(' ').toLowerCase();

    return (
      orig.includes(q) ||
      content.includes(q) ||
      kind.includes(q) ||
      subject.includes(q) ||
      people.includes(q) ||
      places.includes(q) ||
      topics.includes(q) ||
      cues.includes(q)
    );
  });

  // Group memories for UI representation: memories sharing a subject become a single ListCard
  type RenderGroupItem =
    | { type: 'memory'; memory: MemoryItem }
    | { type: 'list'; subject: string; memories: MemoryItem[]; latestTimestamp: number };

  const groupedRenderItems = useMemo<RenderGroupItem[]>(() => {
    const items: RenderGroupItem[] = [];
    const subjectMap = new Map<string, MemoryItem[]>();
    const subjectIndexMap = new Map<string, number>();

    for (const memory of filteredMemories) {
      const rawSubject = memory.interpretation?.subject?.trim();
      if (!rawSubject) {
        items.push({ type: 'memory', memory });
      } else {
        if (!subjectMap.has(rawSubject)) {
          subjectMap.set(rawSubject, [memory]);
          const index = items.length;
          subjectIndexMap.set(rawSubject, index);
          items.push({
            type: 'list',
            subject: rawSubject,
            memories: [memory],
            latestTimestamp: new Date(memory.createdAt).getTime(),
          });
        } else {
          const list = subjectMap.get(rawSubject)!;
          list.push(memory);
          const index = subjectIndexMap.get(rawSubject)!;
          const existingItem = items[index] as {
            type: 'list';
            subject: string;
            memories: MemoryItem[];
            latestTimestamp: number;
          };
          existingItem.memories = list;
        }
      }
    }

    return items;
  }, [filteredMemories]);

  const activeCount = memories.filter((m) => !m.isDone).length;
  const doneCount = memories.filter((m) => m.isDone).length;

  const inboxFilterCounts = {
    all: memories.length,
    reminders: memories.filter((m) => matchesInboxClassification(m, 'reminders')).length,
    facts: memories.filter((m) => matchesInboxClassification(m, 'facts')).length,
    not_sure: memories.filter((m) => matchesInboxClassification(m, 'not_sure')).length,
  };

  const getInboxFilterDisplayLabel = (f: InboxFilterType) => {
    switch (f) {
      case 'reminders':
        return 'Reminders';
      case 'facts':
        return 'Facts';
      case 'not_sure':
        return 'Not Sure';
      default:
        return 'All';
    }
  };

  // Derive unique list of existing subjects from stored memories for the Same Subject picker
  const existingSubjects = useMemo(() => {
    const subjects = new Set<string>();
    for (const m of memories) {
      const s = m.interpretation?.subject?.trim();
      if (s) {
        subjects.add(s);
      }
    }
    return Array.from(subjects);
  }, [memories]);

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900 flex flex-col font-sans">
      <Header
        inboxFilter={inboxFilter}
        onInboxFilterChange={setInboxFilter}
        counts={inboxFilterCounts}
      />

      <main className="flex-1 max-w-3xl w-full mx-auto p-2.5 sm:p-5 space-y-3 sm:space-y-4">
        {/* Error Notification */}
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 px-3.5 py-2.5 rounded-xl flex items-start justify-between gap-3 text-xs sm:text-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-xs font-semibold underline text-rose-700 hover:text-rose-900 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* TODAY TICKER - Quiet passive resurfacing of today-relevant items */}
        <TodayTicker
          memories={memories}
          onToggleDone={handleToggleDone}
          onDelete={handleDelete}
          onEdit={handleEditMemory}
          onSaveThought={handleSaveThought}
          ephemeralCandidate={ephemeralCandidate}
          onDismissEphemeral={() => {
            ephemeralCallBridge.dismissCandidate();
            setEphemeralCandidate(null);
          }}
        />

        {/* PRIMARY INTERFACE: COMPACT TELL & ASK EZZYMIGO ENGINE */}
        <section className="space-y-2 sm:space-y-2.5">
          {/* Tell Ezzymigo */}
          <ThoughtInput
            onSave={handleSaveThought}
            onImmediateAction={handleImmediateDeviceAction}
            isLoading={isLoading}
            existingSubjects={existingSubjects}
            activeSubject={activeSubject}
            onActiveSubjectChange={setActiveSubject}
            isSubjectPaused={isSubjectPaused}
            onSubjectPausedChange={setIsSubjectPaused}
            inputRef={tellInputRef}
          />

          {/* Optional Clarification Prompt (Ezzymigo Ambiguity Rule) */}
          {clarification && (
            <div
              id="ezzymigo-clarification-card"
              className="bg-indigo-50/80 border border-indigo-200 rounded-xl p-3 sm:p-3.5 shadow-2xs space-y-2 animate-in fade-in transition-all"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-950">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                  <span>{clarification.question}</span>
                </div>
                <button
                  type="button"
                  onClick={handleDismissClarification}
                  className="text-[11px] font-medium text-indigo-400 hover:text-indigo-700 cursor-pointer flex items-center gap-0.5"
                  title="Skip clarification"
                >
                  <span>Skip</span>
                  <X className="w-3 h-3" />
                </button>
              </div>

              {clarification.candidateOptions && clarification.candidateOptions.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {clarification.candidateOptions.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => handleResolveClarification(opt)}
                      disabled={isResolvingClarification}
                      className="px-2.5 py-1 bg-white hover:bg-indigo-100 hover:border-indigo-300 border border-indigo-200 text-indigo-900 rounded-lg text-xs font-medium transition-colors cursor-pointer shadow-2xs disabled:opacity-50"
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (clarificationAnswer.trim()) {
                      handleResolveClarification(clarificationAnswer.trim());
                    }
                  }}
                  className="flex items-center gap-2 pt-0.5"
                >
                  <input
                    type="text"
                    value={clarificationAnswer}
                    onChange={(e) => setClarificationAnswer(e.target.value)}
                    placeholder={
                      clarification.entityType === 'phone_offer'
                        ? 'e.g. 0412 345 678, or select from Contacts'
                        : 'e.g. My brother, or include their number'
                    }
                    className="flex-1 h-8 px-2.5 bg-white rounded-lg border border-indigo-200 text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-hidden focus:ring-1 focus:ring-indigo-600 focus:border-indigo-600 shadow-2xs"
                  />
                  {typeof navigator !== 'undefined' && typeof window !== 'undefined' && ('contacts' in navigator && 'ContactsManager' in window) && (
                    <button
                      type="button"
                      id="clarification-use-contacts-btn"
                      onClick={handlePickContact}
                      className="px-2.5 h-8 bg-white hover:bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-lg text-xs font-medium transition-colors cursor-pointer shrink-0 shadow-2xs flex items-center gap-1.5"
                      title="Select from contacts"
                    >
                      <Contact className="w-3.5 h-3.5 text-indigo-600" />
                      <span>Use Contacts</span>
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={!clarificationAnswer.trim() || isResolvingClarification}
                    className="px-3 h-8 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer shrink-0 shadow-2xs"
                  >
                    {isResolvingClarification ? 'Saving…' : 'Save'}
                  </button>
                </form>
              )}
            </div>
          )}

          {/* Feedback banner when relationship is learned */}
          {clarificationFeedback && (
            <div
              id="ezzymigo-clarification-feedback"
              className="text-xs text-emerald-800 bg-emerald-50/90 border border-emerald-200 px-3 py-1.5 rounded-lg animate-in fade-in flex items-center justify-between gap-2 shadow-2xs"
            >
              <div className="flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="font-medium">{clarificationFeedback}</span>
              </div>
              <button
                type="button"
                onClick={() => setClarificationFeedback(null)}
                className="text-emerald-500 hover:text-emerald-800 text-[10px] cursor-pointer"
              >
                ✕
              </button>
            </div>
          )}

          {/* Ask Ezzymigo */}
          <AskEzzymigoPanel
            memories={memories}
            onToggleDone={handleToggleDone}
            onDelete={handleDelete}
            onEdit={handleEditMemory}
          />
        </section>

        {/* Memories Section */}
        <section className="space-y-2.5 pt-1">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-1.5 border-b border-zinc-200">
            <div className="flex items-center flex-wrap gap-2">
              <Database className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-zinc-600 shrink-0" />
              <h2 className="text-xs sm:text-sm md:text-base font-bold text-zinc-900 leading-none">
                Memories
              </h2>
              <span className="text-[11px] bg-zinc-200 text-zinc-700 font-semibold px-2 py-0.5 rounded-full leading-none">
                {filteredMemories.length}
                {inboxFilter !== 'all' ? ` of ${memories.length}` : ''}
              </span>
              <button
                id="occasions-dropdown-button"
                type="button"
                onClick={() => setIsOccasionsOpen(true)}
                className="inline-flex items-center gap-1 text-[11px] sm:text-xs font-medium text-zinc-700 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200/80 border border-zinc-200/80 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md transition-colors cursor-pointer leading-none shadow-2xs ml-0.5"
                title="Choose occasions and traditions to remember and anticipate"
              >
                <span>Occasions</span>
                <ChevronDown className="w-3 h-3 text-zinc-500" />
              </button>
              {inboxFilter !== 'all' && (
                <span className="inline-flex items-center gap-1 text-[11px] bg-zinc-900 text-white font-medium px-2 py-0.5 rounded-full shadow-2xs">
                  <span>Filter: {getInboxFilterDisplayLabel(inboxFilter)}</span>
                  <button
                    type="button"
                    onClick={() => setInboxFilter('all')}
                    title="Clear filter and show All"
                    className="hover:text-zinc-300 cursor-pointer ml-0.5 p-0.5 rounded-full"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 justify-between sm:justify-end">
              {/* Filter Tabs */}
              <div className="flex rounded-lg bg-zinc-200/80 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setFilter('all')}
                  className={`px-2 py-1 rounded-md transition-colors cursor-pointer text-[11px] sm:text-xs ${
                    filter === 'all' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  All ({memories.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilter('active')}
                  className={`px-2 py-1 rounded-md transition-colors cursor-pointer text-[11px] sm:text-xs ${
                    filter === 'active' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  Active ({activeCount})
                </button>
                <button
                  type="button"
                  onClick={() => setFilter('done')}
                  className={`px-2 py-1 rounded-md transition-colors cursor-pointer text-[11px] sm:text-xs ${
                    filter === 'done' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  Done ({doneCount})
                </button>
              </div>

              {/* Refresh button */}
              <button
                type="button"
                onClick={fetchMemories}
                disabled={isFetching}
                title="Refresh memories from persistent storage"
                className="p-1.5 rounded-md bg-white border border-zinc-200 text-zinc-600 hover:text-zinc-900 transition-colors disabled:opacity-50 cursor-pointer shadow-2xs"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* Search bar if there are memories */}
          {memories.length > 2 && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search memories by keyword, person, place, or topic..."
                className="w-full pl-8 pr-3 py-1.5 bg-white rounded-lg border border-zinc-200 text-xs text-zinc-800 placeholder:text-zinc-400 focus:outline-hidden focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900"
              />
            </div>
          )}

          {/* List of Memories */}
          {isFetching && memories.length === 0 ? (
            <div className="bg-white rounded-xl border border-zinc-200 p-6 text-center text-xs sm:text-sm text-zinc-500">
              Loading stored memories from persistent storage...
            </div>
          ) : filteredMemories.length === 0 ? (
            <div className="bg-white rounded-xl border border-dashed border-zinc-300 p-6 text-center space-y-2">
              <p className="text-xs sm:text-sm font-semibold text-zinc-700">
                {searchQuery
                  ? 'No matching intention memories found'
                  : inboxFilter !== 'all'
                  ? `No ${getInboxFilterDisplayLabel(inboxFilter)} memories found`
                  : 'No memories stored yet'}
              </p>
              <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                {searchQuery
                  ? 'Try clearing your search query to view all memories.'
                  : inboxFilter !== 'all'
                  ? `No memories matched the "${getInboxFilterDisplayLabel(inboxFilter)}" filter.`
                  : 'Tell Ezzymigo any thought or intention above and press Save to let Ezzymigo structure and store it.'}
              </p>
              {inboxFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setInboxFilter('all')}
                  className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-zinc-800 bg-zinc-100 hover:bg-zinc-200 px-3 py-1 rounded-md border border-zinc-200 transition-colors cursor-pointer"
                >
                  Restore All Inbox
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2.5">
              {groupedRenderItems.map((item) => {
                if (item.type === 'list') {
                  return (
                    <ListCard
                      key={`list-${item.subject}`}
                      subject={item.subject}
                      memories={item.memories}
                      onToggleDone={handleToggleDone}
                      onDelete={handleDelete}
                      onEdit={handleEditMemory}
                      onAddItem={handleAddToList}
                      onDeleteList={handleDeleteList}
                    />
                  );
                }
                return (
                  <MemoryCard
                    key={item.memory.id}
                    memory={item.memory}
                    onToggleDone={handleToggleDone}
                    onDelete={handleDelete}
                    onEdit={handleEditMemory}
                  />
                );
              })}
            </div>
          )}
        </section>

        {/* Collapsible Developer / Inspection Tools Section */}
        <section className="pt-1">
          <details className="group rounded-xl border border-zinc-200 bg-zinc-50/70 overflow-hidden shadow-2xs">
            <summary className="px-3.5 py-2 text-xs font-semibold text-zinc-600 hover:text-zinc-900 cursor-pointer flex items-center justify-between select-none transition-colors">
              <span className="flex items-center gap-2">
                <Wrench className="w-3.5 h-3.5 text-zinc-500" />
                <span>Developer / Inspection ▾</span>
              </span>
              <ChevronDown className="w-4 h-4 text-zinc-400 group-open:rotate-180 transition-transform" />
            </summary>
            <div className="p-3 sm:p-4 border-t border-zinc-200/80 bg-white space-y-3">
              <div className="flex items-center gap-2 text-xs text-zinc-600 bg-zinc-50 px-3 py-1.5 rounded-md border border-zinc-200 w-fit">
                <Sparkles className="w-3.5 h-3.5 text-zinc-700" />
                <span>Model Engine: Gemini 2.5 Flash</span>
              </div>
              <CalendarInspector authState={authState} />
            </div>
          </details>
        </section>
      </main>

      {/* Learned Knowledge Aware Delete Confirmation Modal */}
      <DeleteKnowledgeModal
        prompt={deleteKnowledgePrompt}
        isDeleting={isDeletingKnowledge}
        onConfirmDeleteMemoryOnly={() => {
          if (deleteKnowledgePrompt) {
            return performDeleteMemoryOnly(deleteKnowledgePrompt.memory.id);
          }
          return Promise.resolve();
        }}
        onConfirmDeleteAndForget={(personName) => {
          return performDeleteAndForget(personName);
        }}
        onCancel={() => setDeleteKnowledgePrompt(null)}
      />

      {/* Occasions Configuration Modal */}
      <OccasionsModal
        isOpen={isOccasionsOpen}
        onClose={() => setIsOccasionsOpen(false)}
      />
    </div>
  );
}

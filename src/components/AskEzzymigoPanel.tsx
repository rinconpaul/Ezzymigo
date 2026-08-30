import React, { useState, useRef, useCallback, useMemo } from 'react';
import { HelpCircle, Send, Loader2, Sparkles, AlertCircle, Mic, X, List, ChevronDown, ChevronUp, FileText } from 'lucide-react';
import { useSpeechDictation } from '../utils/useSpeechDictation';
import { getUserPreferences, formatDateTime } from '../utils/userPreferences';
import { MemoryItem } from '../types';
import { MemoryCard } from './MemoryCard';

interface AskEzzymigoPanelProps {
  memories?: MemoryItem[];
  onToggleDone?: (id: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onEdit?: (id: string, newText: string) => Promise<void>;
}

export const AskEzzymigoPanel: React.FC<AskEzzymigoPanelProps> = ({
  memories = [],
  onToggleDone,
  onDelete,
  onEdit,
}) => {
  const [question, setQuestion] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [matchedMemoryIds, setMatchedMemoryIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<{ type: string; entityName: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const prefs = getUserPreferences();

  const handleAppendText = useCallback((phrase: string) => {
    setQuestion((prev) => {
      const trimmedBase = prev.trim();
      if (!trimmedBase) {
        return phrase;
      }
      return `${trimmedBase} ${phrase}`;
    });
  }, []);

  const handleClear = () => {
    setQuestion('');
    setPendingConfirmation(null);
    inputRef.current?.focus();
  };

  const { isListening, speechNotice, toggleListening, stopListening } = useSpeechDictation({
    onAppendText: handleAppendText,
    language: prefs.language,
  });

  const handleAsk = async (explicitQuery?: string | unknown, isConfirm: boolean = false) => {
    const queryText = typeof explicitQuery === 'string' ? explicitQuery : question;
    const trimmed = queryText.trim();
    if (!trimmed || isLoading) return;

    if (isListening) {
      stopListening();
    }

    setIsLoading(true);
    setError(null);
    setAnswer(null);
    setMatchedMemoryIds([]);

    console.log('[Ask Ezzymigo] Submitting query to /api/ask:', trimmed, 'confirm:', isConfirm);

    try {
      const currentPrefs = getUserPreferences();
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: trimmed,
          clientNow: new Date().toISOString(),
          clientTimeZone: currentPrefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney',
          clientLanguage: currentPrefs.language || 'en-AU',
          clientRegion: currentPrefs.region || 'AU',
          clientCurrency: currentPrefs.currency || 'AUD',
          confirm: isConfirm,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to retrieve answer from memories or calendar.');
      }

      setAnswer(data.answer || "I couldn't find anything relevant in your saved memories or calendar.");
      const returnedMemoryIds: string[] = Array.isArray(data.memory_ids) ? data.memory_ids : [];
      setMatchedMemoryIds(returnedMemoryIds);

      if (data.confirmation_required && data.pending_action) {
        setPendingConfirmation(data.pending_action);
      } else {
        setPendingConfirmation(null);
      }

      console.log('[Ask Ezzymigo] Response answer:', data.answer);
    } catch (err: any) {
      console.error('[Ask Ezzymigo] Error:', err);
      setError(err?.message || 'Something went wrong while searching your memories and calendar.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmAction = (entityName: string) => {
    handleAsk(`Yes, forget ${entityName}`, true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      handleAsk();
    }
  };

  // Surfaced memories based on memory IDs returned by the Ask API
  const surfacedMemories = memories.filter((m) =>
    matchedMemoryIds.some((id) => String(id).trim() === String(m.id).trim())
  );

  const [expandedInspectIds, setExpandedInspectIds] = useState<Set<string>>(new Set());

  const toggleInspect = (id: string) => {
    setExpandedInspectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Group surfaced supporting memories: 2+ memories sharing a non-empty subject become a Supporting List
  type SupportingGroupItem =
    | { type: 'memory'; memory: MemoryItem }
    | { type: 'list'; subject: string; memories: MemoryItem[] };

  const groupedSupportingItems = useMemo<SupportingGroupItem[]>(() => {
    const subjectCounts = new Map<string, number>();
    for (const m of surfacedMemories) {
      const s = m.interpretation?.subject?.trim();
      if (s) {
        subjectCounts.set(s, (subjectCounts.get(s) || 0) + 1);
      }
    }

    const items: SupportingGroupItem[] = [];
    const listGroupMap = new Map<string, { type: 'list'; subject: string; memories: MemoryItem[] }>();

    for (const mem of surfacedMemories) {
      const s = mem.interpretation?.subject?.trim();
      if (s && (subjectCounts.get(s) || 0) >= 2) {
        if (!listGroupMap.has(s)) {
          const group: SupportingGroupItem = {
            type: 'list',
            subject: s,
            memories: [mem],
          };
          listGroupMap.set(s, group);
          items.push(group);
        } else {
          listGroupMap.get(s)!.memories.push(mem);
        }
      } else {
        items.push({ type: 'memory', memory: mem });
      }
    }

    return items;
  }, [surfacedMemories]);

  return (
    <div
      id="ask-ezzymigo-panel"
      className="bg-white rounded-xl border border-zinc-200 p-2.5 sm:p-3.5 shadow-xs space-y-2"
    >
      <div className="flex flex-col gap-1.5">
        {/* Top row: Title on left, Ask button on right */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="p-1 rounded-md bg-zinc-900 text-white">
              <HelpCircle className="w-3.5 h-3.5" />
            </div>
            <h3 className="text-xs sm:text-sm font-bold text-zinc-900 leading-none">
              Ask Ezzymigo
            </h3>
            {isListening && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 bg-red-50 border border-red-200/80 px-1.5 py-0.5 rounded-md animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-red-600" />
                Listening…
              </span>
            )}
          </div>

          <button
            id="ask-ezzymigo-button"
            type="button"
            onClick={() => handleAsk()}
            disabled={isLoading || !question.trim()}
            className="inline-flex items-center justify-center gap-1 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer shadow-xs shrink-0"
          >
            {isLoading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Send className="w-3 h-3" />
            )}
            <span>{isLoading ? 'Searching…' : 'Ask ➤'}</span>
          </button>
        </div>

        {/* Input row: Full width with mic embedded inside left */}
        <div className="relative flex items-center w-full">
          <button
            id="ask-mic-dictate-btn"
            type="button"
            onClick={toggleListening}
            disabled={isLoading}
            title={isListening ? 'Stop microphone dictation' : 'Start microphone dictation'}
            aria-label={isListening ? 'Stop microphone dictation' : 'Start microphone dictation'}
            className={`absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md transition-all cursor-pointer z-10 ${
              isListening
                ? 'bg-red-100 text-red-600 ring-2 ring-red-400 animate-pulse'
                : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-200/70'
            }`}
          >
            {isListening ? (
              <Mic className="w-4 h-4 text-red-600" />
            ) : (
              <Mic className="w-4 h-4 text-zinc-600" />
            )}
          </button>

          <input
            ref={inputRef}
            id="ask-ezzymigo-input"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            placeholder="Ask Ezzymigo anything…"
            className="w-full h-[38px] pl-9 pr-9 py-2 bg-zinc-50 rounded-lg border border-zinc-200 text-xs sm:text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-hidden focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 focus:bg-white disabled:opacity-60 transition-all leading-relaxed"
          />

          {question.length > 0 && (
            <button
              id="ask-clear-input-btn"
              type="button"
              onClick={handleClear}
              disabled={isLoading}
              title="Clear question"
              aria-label="Clear question"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1.5 min-w-[28px] min-h-[28px] sm:min-w-[26px] sm:min-h-[26px] flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/70 transition-colors cursor-pointer z-10"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Listening State & Speech Notices */}
        {(isListening || speechNotice) && (
          <div className="text-xs flex items-center justify-between gap-2 px-1">
            {isListening ? (
              <div className="flex items-center gap-1.5 text-red-600 font-medium text-[11px] animate-pulse">
                <span className="w-2 h-2 rounded-full bg-red-600" />
                <span>Listening… Speak naturally. Tap 🎤 or Ask when done.</span>
              </div>
            ) : null}
            {speechNotice ? (
              <span className="text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 text-[10px]">
                {speechNotice}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {/* Answer Display */}
      {answer && (
        <div
          id="ask-ezzymigo-answer"
          className="mt-2 p-3 bg-zinc-50 border border-zinc-200 rounded-lg text-zinc-800 text-xs sm:text-sm space-y-2 animate-in fade-in"
        >
          <div className="flex items-center gap-1.5 text-zinc-500 font-medium text-xs">
            <Sparkles className="w-3.5 h-3.5 text-zinc-700" />
            <span>Ezzymigo</span>
          </div>
          <p className="leading-relaxed text-zinc-900 font-normal">
            {answer}
          </p>

          {/* Explicit Confirmation Action for Entity-Wide Forget */}
          {pendingConfirmation && (
            <div className="flex flex-wrap items-center gap-2 pt-1.5 border-t border-zinc-200/80">
              <button
                type="button"
                id="confirm-forget-entity-btn"
                onClick={() => handleConfirmAction(pendingConfirmation.entityName)}
                disabled={isLoading}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer shadow-2xs disabled:opacity-50"
              >
                Yes, forget {pendingConfirmation.entityName}
              </button>
              <button
                type="button"
                id="cancel-forget-entity-btn"
                onClick={() => setPendingConfirmation(null)}
                disabled={isLoading}
                className="px-3 py-1.5 bg-zinc-200 hover:bg-zinc-300 text-zinc-800 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* Surfaced Supporting Memories Tray */}
      {surfacedMemories.length > 0 && (
        <div
          id="ask-surfaced-memories-tray"
          className="mt-2.5 pt-2.5 border-t border-zinc-200 space-y-2 animate-in fade-in"
        >
          <div className="flex items-center justify-between px-0.5">
            <div className="flex items-center gap-1.5 text-zinc-700 font-semibold text-xs">
              <Sparkles className="w-3.5 h-3.5 text-zinc-600" />
              <span>Supporting Memory {surfacedMemories.length > 1 ? `(${surfacedMemories.length})` : ''}</span>
            </div>
            <button
              id="clear-surfaced-results-btn"
              type="button"
              onClick={() => setMatchedMemoryIds([])}
              className="text-[11px] text-zinc-400 hover:text-zinc-700 cursor-pointer transition-colors"
              title="Dismiss temporary surfaced view"
            >
              Dismiss view ✕
            </button>
          </div>

          <div className="space-y-2">
            {groupedSupportingItems.map((item) => {
              if (item.type === 'list') {
                return (
                  <div
                    key={`ask-supporting-list-${item.subject}`}
                    id={`ask-supporting-list-${item.subject.replace(/\s+/g, '-').toLowerCase()}`}
                    className="rounded-xl border border-indigo-200 bg-white p-3 sm:p-3.5 space-y-2 shadow-2xs"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap pb-1.5 border-b border-indigo-100/70">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-950 bg-indigo-50 border border-indigo-200/80 px-2 py-0.5 rounded-md">
                          <List className="w-3 h-3 text-indigo-700" />
                          <span>Supporting List</span>
                        </span>
                        <span className="text-zinc-400 font-normal">—</span>
                        <span className="font-bold text-xs sm:text-sm text-zinc-900">
                          {item.subject}
                        </span>
                        <span className="text-[11px] text-zinc-500 font-medium bg-zinc-50 px-2 py-0.5 rounded-full border border-zinc-200">
                          {item.memories.length} {item.memories.length === 1 ? 'item' : 'items'}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-1.5 pt-0.5">
                      {item.memories.map((mem) => {
                        const isInspecting = expandedInspectIds.has(mem.id);
                        const content = mem.interpretation?.content || mem.originalText;
                        return (
                          <div
                            key={`ask-supp-item-${mem.id}`}
                            id={`ask-supp-item-${mem.id}`}
                            className="rounded-lg border border-zinc-200/80 bg-zinc-50/50 p-2 text-xs transition-colors space-y-1.5"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-start gap-2 min-w-0">
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0 mt-1.5" />
                                <span className="font-medium text-zinc-900 leading-snug">
                                  {content}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => toggleInspect(mem.id)}
                                className="inline-flex items-center gap-0.5 text-[10px] text-zinc-400 hover:text-zinc-700 px-1.5 py-0.5 rounded hover:bg-zinc-200/60 transition-colors shrink-0 cursor-pointer"
                                title={isInspecting ? 'Hide details' : 'Inspect memory details'}
                              >
                                {isInspecting ? (
                                  <>
                                    <span>Less</span>
                                    <ChevronUp className="w-2.5 h-2.5" />
                                  </>
                                ) : (
                                  <>
                                    <span>Inspect</span>
                                    <ChevronDown className="w-2.5 h-2.5" />
                                  </>
                                )}
                              </button>
                            </div>

                            {isInspecting && (
                              <div className="pt-1.5 border-t border-zinc-200/70 text-[11px] text-zinc-600 space-y-1 pl-3.5">
                                {mem.originalText && mem.originalText !== content && (
                                  <div className="flex items-center gap-1.5 text-zinc-500">
                                    <FileText className="w-3 h-3 shrink-0" />
                                    <span className="italic truncate">"{mem.originalText}"</span>
                                  </div>
                                )}
                                <div className="text-[10px] text-zinc-400 font-mono">
                                  {formatDateTime(mem.createdAt)}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              return (
                <MemoryCard
                  key={`ask-surfaced-${item.memory.id}`}
                  memory={item.memory}
                  onToggleDone={onToggleDone || (async () => {})}
                  onDelete={onDelete || (async () => {})}
                  onEdit={onEdit}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div
          id="ask-ezzymigo-error"
          className="mt-2 p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

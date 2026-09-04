import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MemoryItem, TodayRelevanceCandidate, TodayRelevanceResponse } from '../types';
import { MemoryCard } from './MemoryCard';
import { getUserPreferences } from '../utils/userPreferences';
import { useSpeechDictation } from '../utils/useSpeechDictation';
import { Calendar, Mic, MicOff, Send, Loader2, Check, Plus, Clock } from 'lucide-react';

interface TodayTickerProps {
  memories: MemoryItem[];
  onToggleDone?: (id: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onEdit?: (id: string, newText: string) => Promise<void>;
  onSaveThought?: (text: string, context?: { linkedEventId?: string; eventTitle?: string }) => Promise<void>;
}

// Helper for reflection dismissals in localStorage (scoped by occurrence date: sourceId:YYYY-MM-DD)
const getClientTodayYMD = (): string => {
  const prefs = getUserPreferences();
  const tz = prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().split('T')[0];
  }
};

const getDismissedReflections = (): string[] => {
  try {
    const raw = localStorage.getItem('ezzymigo_dismissed_reflections');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const markReflectionDismissed = (eventId: string, occurrenceId?: string) => {
  try {
    const todayYMD = getClientTodayYMD();
    let occurrenceKey = occurrenceId;
    if (!occurrenceKey) {
      const baseId = eventId.replace(/:\d{4}-\d{2}-\d{2}$/, '');
      occurrenceKey = `${baseId}:${todayYMD}`;
    }
    const list = getDismissedReflections();
    if (!list.includes(occurrenceKey)) {
      list.push(occurrenceKey);
      localStorage.setItem('ezzymigo_dismissed_reflections', JSON.stringify(list));
    }
  } catch (e) {
    console.warn('Failed to save dismissed reflection:', e);
  }
};

// -------------------------------------------------------------
// State 1 & State 3 Tray: Anticipatory Preparation / Post-Event Reflection
// -------------------------------------------------------------
const AnticipatoryPreparationTray: React.FC<{
  candidate: TodayRelevanceCandidate;
  onClose: () => void;
  onSaveThought?: (text: string, context?: { linkedEventId?: string; eventTitle?: string }) => Promise<void>;
  onItemAdded?: (newItem: string) => void;
  onRemoveCandidate?: (candidateSourceId: string) => void;
}> = ({ candidate, onClose, onSaveThought, onItemAdded, onRemoveCandidate }) => {
  const [text, setText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const prefs = getUserPreferences();
  const isReflection = candidate.anticipatory_stage === 'reflect';

  const handleAppendText = useCallback((phrase: string) => {
    setText((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) return phrase;
      return `${trimmed} ${phrase}`;
    });
  }, []);

  const { isListening, speechNotice, toggleListening, stopListening } = useSpeechDictation({
    onAppendText: handleAppendText,
    language: prefs.language,
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const getOccurrenceId = useCallback(() => {
    return candidate.occurrence_id || `${candidate.source_id.replace(/:\d{4}-\d{2}-\d{2}$/, '')}:${getClientTodayYMD()}`;
  }, [candidate]);

  const handleDismiss = () => {
    if (isReflection) {
      const occId = getOccurrenceId();
      markReflectionDismissed(candidate.source_id, occId);
      if (onRemoveCandidate) {
        onRemoveCandidate(candidate.source_id);
      }
    }
    onClose();
  };

  const handleSave = async () => {
    const trimmed = text.trim();
    if (!trimmed || isSaving || !onSaveThought) return;

    if (isListening) {
      stopListening();
    }

    setIsSaving(true);
    try {
      const occId = getOccurrenceId();
      await onSaveThought(trimmed, {
        linkedEventId: occId,
        eventTitle: candidate.event_title || candidate.display_text,
      });
      if (isReflection) {
        markReflectionDismissed(candidate.source_id, occId);
        if (onRemoveCandidate) {
          onRemoveCandidate(candidate.source_id);
        }
      } else {
        if (onItemAdded) {
          onItemAdded(trimmed);
        }
      }
      setSavedSuccess(true);
      setTimeout(() => {
        onClose();
      }, 900);
    } catch (err) {
      console.error('[Anticipatory Tray] Error saving intention or outcome:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <div
      id="today-anticipatory-prep-tray"
      className="bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-xl p-3 space-y-2.5 shadow-sm animate-in fade-in"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-lg bg-zinc-800 text-amber-400 shrink-0 mt-0.5">
            <Calendar className="w-3 h-3 text-amber-400" />
          </span>
          <div>
            <div className="text-[11px] font-semibold text-amber-400 uppercase tracking-wider">
              {isReflection ? 'Post-Event Reflection & Follow-Through' : 'Anticipatory Preparation'}
            </div>
            <div className="text-xs sm:text-sm font-medium text-zinc-100 mt-0.5 leading-snug">
              {candidate.display_text}
            </div>
          </div>
        </div>
        <button
          id="close-anticipatory-prep-btn"
          type="button"
          onClick={handleDismiss}
          className="text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0 transition-colors p-1"
          title="Dismiss prompt"
        >
          Dismiss ✕
        </button>
      </div>

      {savedSuccess ? (
        <div className="flex items-center gap-2 py-2 px-3 bg-emerald-950/60 border border-emerald-700/50 rounded-lg text-emerald-300 text-xs font-medium animate-in fade-in">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>Saved to your Ezzymigo memories!</span>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="relative flex items-center bg-zinc-800/90 border border-zinc-700 rounded-lg focus-within:border-amber-400/80 focus-within:ring-1 focus-within:ring-amber-400/40 transition-all">
            <input
              ref={inputRef}
              id="anticipatory-prep-input"
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSaving}
              placeholder={
                isReflection
                  ? 'e.g. Blood test next Thursday and she renewed the scripts electronically...'
                  : 'e.g. Ask about my blood test and prescription refill...'
              }
              className="w-full bg-transparent px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-400 focus:outline-none disabled:opacity-50"
            />
            <div className="flex items-center gap-1 pr-1.5 shrink-0">
              <button
                type="button"
                onClick={toggleListening}
                disabled={isSaving}
                title={isListening ? 'Stop listening' : 'Dictate with speech'}
                className={`p-1.5 rounded-md cursor-pointer transition-colors ${
                  isListening
                    ? 'bg-rose-500/20 text-rose-400 animate-pulse'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60'
                }`}
              >
                {isListening ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
              </button>
              <button
                id="save-anticipatory-prep-btn"
                type="button"
                onClick={handleSave}
                disabled={!text.trim() || isSaving}
                className="px-2.5 py-1 bg-amber-400 hover:bg-amber-300 disabled:bg-zinc-700 disabled:text-zinc-400 text-zinc-950 text-xs font-semibold rounded-md cursor-pointer transition-colors flex items-center gap-1"
              >
                {isSaving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <>
                    <span>Save</span>
                    <Send className="w-3 h-3" />
                  </>
                )}
              </button>
            </div>
          </div>
          {speechNotice && (
            <p className="text-[10px] text-amber-400/90 pl-1">{speechNotice}</p>
          )}
        </div>
      )}
    </div>
  );
};

// -------------------------------------------------------------
// State 2 Tray: Anticipatory Reminder & Saved Notes Display (+ Add another thing)
// -------------------------------------------------------------
const AnticipatoryReminderTray: React.FC<{
  candidate: TodayRelevanceCandidate;
  onClose: () => void;
  onSaveThought?: (text: string, context?: { linkedEventId?: string; eventTitle?: string }) => Promise<void>;
  onItemAdded?: (newItem: string) => void;
}> = ({ candidate, onClose, onSaveThought, onItemAdded }) => {
  const [showAddInput, setShowAddInput] = useState(false);
  const [newText, setNewText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [localItems, setLocalItems] = useState<string[]>(candidate.preparation_items || []);
  const addInputRef = useRef<HTMLInputElement>(null);
  const prefs = getUserPreferences();

  const handleAppendText = useCallback((phrase: string) => {
    setNewText((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) return phrase;
      return `${trimmed} ${phrase}`;
    });
  }, []);

  const { isListening, speechNotice, toggleListening, stopListening } = useSpeechDictation({
    onAppendText: handleAppendText,
    language: prefs.language,
  });

  useEffect(() => {
    if (showAddInput) {
      addInputRef.current?.focus();
    }
  }, [showAddInput]);

  const handleSaveAnother = async () => {
    const trimmed = newText.trim();
    if (!trimmed || isSaving || !onSaveThought) return;

    if (isListening) {
      stopListening();
    }

    setIsSaving(true);
    try {
      await onSaveThought(trimmed, {
        linkedEventId: candidate.source_id,
        eventTitle: candidate.event_title || candidate.display_text,
      });

      const formatted = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
      setLocalItems((prev) => [...prev, formatted]);
      if (onItemAdded) {
        onItemAdded(formatted);
      }
      setNewText('');
      setShowAddInput(false);
    } catch (err) {
      console.error('[Anticipatory Reminder Tray] Error adding note:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveAnother();
    }
  };

  return (
    <div
      id="today-anticipatory-reminder-tray"
      className="bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-xl p-3 space-y-3 shadow-sm animate-in fade-in"
    >
      <div className="flex items-start justify-between gap-2 border-b border-zinc-800 pb-2.5">
        <div className="flex items-start gap-2 min-w-0">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-lg bg-zinc-800 text-amber-400 shrink-0 mt-0.5">
            <Clock className="w-3 h-3 text-amber-400" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-amber-400 uppercase tracking-wider">
                Today's Appointment
              </span>
              {candidate.event_time && (
                <span className="text-[11px] text-zinc-400 font-medium">
                  · {candidate.event_time}
                </span>
              )}
            </div>
            <div className="text-xs sm:text-sm font-semibold text-zinc-100 mt-0.5">
              {candidate.event_title || 'Upcoming Appointment'}
            </div>
          </div>
        </div>
        <button
          id="close-anticipatory-reminder-btn"
          type="button"
          onClick={onClose}
          className="text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0 transition-colors p-1"
          title="Dismiss view"
        >
          Dismiss ✕
        </button>
      </div>

      {/* Existing Preparation Items List */}
      <div className="space-y-1.5">
        <div className="text-[11px] text-zinc-400 font-medium">
          Things you want to remember or discuss:
        </div>
        <div className="space-y-1.5">
          {localItems.map((item, idx) => (
            <div
              key={`prep-item-${idx}`}
              className="flex items-center gap-2 px-2.5 py-1.5 bg-zinc-800/70 border border-zinc-700/60 rounded-lg text-xs text-zinc-200"
            >
              <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-amber-400/20 text-amber-400 shrink-0 text-[10px] font-bold">
                ✓
              </span>
              <span className="font-medium text-zinc-100">{item}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Inline "+ Add another thing" form or trigger */}
      {!showAddInput ? (
        <div className="pt-0.5">
          <button
            id="add-another-prep-item-btn"
            type="button"
            onClick={() => setShowAddInput(true)}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-amber-400 transition-colors font-medium cursor-pointer py-1 px-1.5 rounded hover:bg-zinc-800"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add another thing</span>
          </button>
        </div>
      ) : (
        <div className="space-y-1.5 pt-1 animate-in fade-in">
          <div className="relative flex items-center bg-zinc-800/90 border border-zinc-700 rounded-lg focus-within:border-amber-400/80 focus-within:ring-1 focus-within:ring-amber-400/40 transition-all">
            <input
              ref={addInputRef}
              id="add-another-prep-input"
              type="text"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSaving}
              placeholder="e.g. Ask about physiotherapy referral..."
              className="w-full bg-transparent px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-400 focus:outline-none disabled:opacity-50"
            />
            <div className="flex items-center gap-1 pr-1.5 shrink-0">
              <button
                type="button"
                onClick={toggleListening}
                disabled={isSaving}
                title={isListening ? 'Stop listening' : 'Dictate with speech'}
                className={`p-1.5 rounded-md cursor-pointer transition-colors ${
                  isListening
                    ? 'bg-rose-500/20 text-rose-400 animate-pulse'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60'
                }`}
              >
                {isListening ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
              </button>
              <button
                id="save-add-another-prep-btn"
                type="button"
                onClick={handleSaveAnother}
                disabled={!newText.trim() || isSaving}
                className="px-2.5 py-1 bg-amber-400 hover:bg-amber-300 disabled:bg-zinc-700 disabled:text-zinc-400 text-zinc-950 text-xs font-semibold rounded-md cursor-pointer transition-colors flex items-center gap-1"
              >
                {isSaving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <>
                    <span>Add</span>
                    <Send className="w-3 h-3" />
                  </>
                )}
              </button>
            </div>
          </div>
          {speechNotice && (
            <p className="text-[10px] text-amber-400/90 pl-1">{speechNotice}</p>
          )}
        </div>
      )}
    </div>
  );
};

// -------------------------------------------------------------
// TODAY TICKER - Horizontal Marquee / Auto-Scroll for overflowing text
// -------------------------------------------------------------
const ScrollingTickerText: React.FC<{ text: string }> = ({ text }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowDistance, setOverflowDistance] = useState(0);

  useEffect(() => {
    const checkOverflow = () => {
      if (containerRef.current && textRef.current) {
        const containerWidth = containerRef.current.clientWidth;
        const textWidth = textRef.current.scrollWidth;
        const diff = textWidth - containerWidth;
        // Only scroll if text genuinely overflows the container by more than 4px
        setOverflowDistance(diff > 4 ? diff + 12 : 0);
      }
    };

    checkOverflow();

    const resizeObserver = new ResizeObserver(() => {
      checkOverflow();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [text]);

  const duration = Math.max(6, Math.min(16, Math.round(overflowDistance / 20) + 4));

  return (
    <div
      ref={containerRef}
      className="overflow-hidden whitespace-nowrap min-w-0 flex-1 relative flex items-center"
    >
      <span
        ref={textRef}
        key={text}
        style={
          overflowDistance > 0
            ? {
                display: 'inline-block',
                willChange: 'transform',
                animation: `marquee-scroll ${duration}s ease-in-out infinite`,
                ['--marquee-distance' as any]: `-${overflowDistance}px`,
              }
            : {
                display: 'inline-block',
              }
        }
        className="font-medium text-zinc-900 group-hover:text-zinc-950 whitespace-nowrap shrink-0"
      >
        {text}
      </span>
    </div>
  );
};

// -------------------------------------------------------------
// TODAY TICKER - Live headline ticker with client-side cycling
// -------------------------------------------------------------
export const TodayTicker: React.FC<TodayTickerProps> = ({
  memories,
  onToggleDone,
  onDelete,
  onEdit,
  onSaveThought,
}) => {
  const [candidates, setCandidates] = useState<TodayRelevanceCandidate[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [headlineIndex, setHeadlineIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [surfacedMemoryId, setSurfacedMemoryId] = useState<string | null>(null);
  const [selectedCalendarItem, setSelectedCalendarItem] = useState<TodayRelevanceCandidate | null>(null);

  const hasFetchedRef = useRef(false);

  const fetchRelevance = useCallback(async () => {
    try {
      const prefs = getUserPreferences();
      const dismissedList = getDismissedReflections();

      const res = await fetch('/api/today-relevance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientNow: new Date().toISOString(),
          clientTimeZone:
            prefs.timezone ||
            Intl.DateTimeFormat().resolvedOptions().timeZone ||
            'Australia/Sydney',
          clientLanguage: prefs.language || 'en-AU',
          clientRegion: prefs.region || 'AU',
          dismissedReflectionIds: dismissedList,
        }),
      });

      if (!res.ok) return;

      const data: TodayRelevanceResponse = await res.json();
      if (data && Array.isArray(data.candidates)) {
        const validCandidates = data.candidates;
        setCandidates(validCandidates);
        if (validCandidates.length > 0) {
          setIsVisible(true);
          setCandidateIndex(0);
          setHeadlineIndex(0);
        } else {
          setIsVisible(false);
        }
      }
    } catch (err: any) {
      console.warn('[Today Ticker] Failed to load today relevance:', err);
    }
  }, []);

  useEffect(() => {
    fetchRelevance();
  }, [fetchRelevance, memories]);

  useEffect(() => {
    const handleCalendarUpdated = () => {
      fetchRelevance();
    };
    window.addEventListener('calendar-updated', handleCalendarUpdated);
    return () => window.removeEventListener('calendar-updated', handleCalendarUpdated);
  }, [fetchRelevance]);

  useEffect(() => {
    const timer = setInterval(() => {
      fetchRelevance();
    }, 60000);
    return () => clearInterval(timer);
  }, [fetchRelevance]);

  // Current candidate and headline
  const currentCandidate = candidates[candidateIndex];
  const headlines = currentCandidate?.ticker_headlines && currentCandidate.ticker_headlines.length > 0
    ? currentCandidate.ticker_headlines
    : currentCandidate
    ? [currentCandidate.display_text]
    : [];

  const currentHeadline = headlines[headlineIndex % (headlines.length || 1)] || currentCandidate?.display_text || '';

  // Client-side live ticker cycling timer (Paced dynamically to ensure users have ample time to read auto-scrolling text)
  useEffect(() => {
    if (!isVisible || candidates.length === 0) return;

    const textLen = (currentHeadline || '').length;
    const cycleIntervalMs = Math.max(4500, Math.min(9000, 3500 + textLen * 60));

    const timeout = setTimeout(() => {
      setHeadlineIndex((prevHIndex) => {
        const currentCandidateHeadlines =
          candidates[candidateIndex]?.ticker_headlines || [candidates[candidateIndex]?.display_text || ''];
        
        if (prevHIndex + 1 < currentCandidateHeadlines.length) {
          return prevHIndex + 1;
        } else {
          // Wrapped around headlines for current candidate -> advance candidate
          setCandidateIndex((prevCIndex) => (prevCIndex + 1) % candidates.length);
          return 0;
        }
      });
    }, cycleIntervalMs);

    return () => clearTimeout(timeout);
  }, [isVisible, candidates, candidateIndex, headlineIndex, currentHeadline]);

  // Find underlying memory if surfaced
  const surfacedMemory = surfacedMemoryId
    ? memories.find((m) => String(m.id).trim() === String(surfacedMemoryId).trim())
    : null;

  const handleCandidateClick = (candidate: TodayRelevanceCandidate) => {
    if (!candidate) return;

    if (candidate.anticipatory_stage === 'reflect' || candidate.anticipatory_stage === 'prepare' || candidate.anticipatory_stage === 'remind') {
      setSurfacedMemoryId(null);
      setSelectedCalendarItem((prev) => (prev?.source_id === candidate.source_id ? null : candidate));
    } else if (candidate.source_type === 'memory') {
      setSelectedCalendarItem(null);
      setSurfacedMemoryId((prev) => (prev === candidate.source_id ? null : candidate.source_id));
    } else if (candidate.source_type === 'calendar' || candidate.source_type === 'occasion') {
      setSurfacedMemoryId(null);
      setSelectedCalendarItem((prev) => (prev?.source_id === candidate.source_id ? null : candidate));
    }
  };

  const handleRemoveCandidate = useCallback((candidateSourceId: string) => {
    setCandidates((prev) => {
      const newCandidates = prev.filter((c) => c.source_id !== candidateSourceId);
      if (newCandidates.length === 0) {
        setIsVisible(false);
        setCandidateIndex(0);
        setHeadlineIndex(0);
      } else {
        setCandidateIndex((prevIndex) => (prevIndex >= newCandidates.length ? 0 : prevIndex));
        setHeadlineIndex(0);
      }
      return newCandidates;
    });
  }, []);

  const handleItemAddedToCandidate = (newItem: string) => {
    if (!selectedCalendarItem) return;

    // Update local candidate preparation items & ticker headlines
    setCandidates((prev) =>
      prev.map((c) => {
        if (c.source_id === selectedCalendarItem.source_id) {
          const updatedItems = [...(c.preparation_items || []), newItem];
          const timePrefix = c.event_time ? `${c.event_time} · ` : '';
          const updatedDisplayText = `${timePrefix}${c.event_title || 'Appointment'} — ${updatedItems.join(' · ')}`;
          const updatedHeadlines = [
            `${timePrefix}${c.event_title || 'Appointment'}`,
            ...updatedItems.map((p) => `Remember: ${p}`)
          ];
          return {
            ...c,
            anticipatory_stage: 'remind',
            preparation_items: updatedItems,
            display_text: updatedDisplayText,
            ticker_headlines: updatedHeadlines,
          };
        }
        return c;
      })
    );

    setSelectedCalendarItem((prev) => {
      if (!prev) return null;
      const updatedItems = [...(prev.preparation_items || []), newItem];
      const timePrefix = prev.event_time ? `${prev.event_time} · ` : '';
      const updatedDisplayText = `${timePrefix}${prev.event_title || 'Appointment'} — ${updatedItems.join(' · ')}`;
      const updatedHeadlines = [
        `${timePrefix}${prev.event_title || 'Appointment'}`,
        ...updatedItems.map((p) => `Remember: ${p}`)
      ];
      return {
        ...prev,
        anticipatory_stage: 'remind',
        preparation_items: updatedItems,
        display_text: updatedDisplayText,
        ticker_headlines: updatedHeadlines,
      };
    });
  };

  if (!isVisible && !surfacedMemory && !selectedCalendarItem) {
    return null;
  }

  return (
    <div id="today-relevance-section" className="space-y-2">
      {/* Live TODAY Headline Ticker Bar */}
      {isVisible && currentCandidate && (
        <div
          id="today-ticker-bar"
          role="button"
          tabIndex={0}
          onClick={() => handleCandidateClick(currentCandidate)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleCandidateClick(currentCandidate);
            }
          }}
          title={
            currentCandidate.source_type === 'memory'
              ? 'Tap to surface supporting memory'
              : currentCandidate.anticipatory_stage === 'reflect'
              ? 'Tap to capture follow-up or outcomes'
              : currentCandidate.anticipatory_stage === 'remind'
              ? 'Tap to view preparation notes'
              : 'Tap to prepare for appointment'
          }
          className="group relative flex items-center justify-between gap-2 px-3 py-1.5 bg-white hover:bg-zinc-50 border border-zinc-200/90 rounded-xl shadow-2xs text-xs cursor-pointer transition-all duration-300 select-none animate-in fade-in"
        >
          <div
            key={`ticker-candidate-${currentCandidate.source_id}-${candidateIndex}-${headlineIndex}`}
            className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden transition-opacity duration-300 motion-reduce:transition-none"
          >
            {/* Clean indicator dot / icon */}
            <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-zinc-900 text-amber-400 shrink-0 text-[9px] font-bold">
              {currentCandidate.anticipatory_stage === 'reflect' ? (
                '?'
              ) : currentCandidate.anticipatory_stage === 'remind' ? (
                '✓'
              ) : (
                '●'
              )}
            </span>

            {/* Contextual indicator: TODAY (or Reflect) */}
            <span className="text-[10px] sm:text-[11px] font-semibold text-zinc-500 uppercase tracking-wide shrink-0">
              {currentCandidate.anticipatory_stage === 'reflect' ? 'Reflect' : 'Today'}
            </span>

            <span className="text-zinc-300 shrink-0">·</span>

            {/* Live cycling headline text with horizontal overflow marquee */}
            <ScrollingTickerText text={currentHeadline} />
          </div>

          <div className="flex items-center gap-1.5 shrink-0 text-zinc-400 text-[11px]">
            {headlines.length > 1 && (
              <span className="text-[10px] text-zinc-400 font-mono">
                {headlineIndex + 1}/{headlines.length}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Surfaced Memory Card Tray (opened on tap for memory item) */}
      {surfacedMemory && (
        <div
          id="today-surfaced-memory-tray"
          className="bg-zinc-50/80 border border-zinc-200 rounded-xl p-2.5 space-y-2 animate-in fade-in"
        >
          <div className="flex items-center justify-between px-0.5">
            <div className="flex items-center gap-1.5 text-zinc-700 font-semibold text-xs">
              <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-zinc-900 text-amber-400 text-[9px] font-bold">
                ●
              </span>
              <span>Today Resurfaced Memory</span>
            </div>
            <button
              id="close-today-surfaced-memory-btn"
              type="button"
              onClick={() => setSurfacedMemoryId(null)}
              className="text-[11px] text-zinc-400 hover:text-zinc-700 cursor-pointer transition-colors"
              title="Dismiss surfaced memory view"
            >
              Dismiss view ✕
            </button>
          </div>

          <MemoryCard
            memory={surfacedMemory}
            onToggleDone={async (id) => {
              if (onToggleDone) {
                await onToggleDone(id);
              }
              setSurfacedMemoryId(null);
              fetchRelevance();
            }}
            onDelete={async (id) => {
              if (onDelete) {
                await onDelete(id);
              }
              setSurfacedMemoryId(null);
              fetchRelevance();
            }}
            onEdit={onEdit}
          />
        </div>
      )}

      {/* Surfaced Calendar / Anticipatory Prep or Reminder Tray */}
      {selectedCalendarItem && (
        selectedCalendarItem.anticipatory_stage === 'remind' && selectedCalendarItem.preparation_items && selectedCalendarItem.preparation_items.length > 0 ? (
          <AnticipatoryReminderTray
            candidate={selectedCalendarItem}
            onClose={() => setSelectedCalendarItem(null)}
            onSaveThought={onSaveThought}
            onItemAdded={handleItemAddedToCandidate}
          />
        ) : selectedCalendarItem.is_anticipatory ? (
          <AnticipatoryPreparationTray
            candidate={selectedCalendarItem}
            onClose={() => setSelectedCalendarItem(null)}
            onSaveThought={onSaveThought}
            onItemAdded={handleItemAddedToCandidate}
            onRemoveCandidate={handleRemoveCandidate}
          />
        ) : (
          <div
            id="today-surfaced-calendar-tray"
            className="bg-zinc-50 border border-zinc-200 rounded-xl p-2.5 text-xs text-zinc-700 flex items-start justify-between gap-3 animate-in fade-in"
          >
            <div className="flex items-start gap-2">
              <Calendar className="w-4 h-4 text-zinc-600 mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <div className="font-semibold text-zinc-900">
                  {selectedCalendarItem.display_text}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {selectedCalendarItem.relevance_reason}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedCalendarItem(null)}
              className="text-[11px] text-zinc-400 hover:text-zinc-700 cursor-pointer"
            >
              Dismiss ✕
            </button>
          </div>
        )
      )}
    </div>
  );
};

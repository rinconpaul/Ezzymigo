import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MemoryItem, TodayRelevanceCandidate, TodayRelevanceResponse } from '../types';
import { MemoryCard } from './MemoryCard';
import { getUserPreferences } from '../utils/userPreferences';
import { useSpeechDictation } from '../utils/useSpeechDictation';
import { Calendar, Mic, MicOff, Send, Loader2, Check, Plus, Clock, X } from 'lucide-react';

interface TodayTickerProps {
  memories: MemoryItem[];
  onToggleDone?: (id: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onEdit?: (id: string, newText: string) => Promise<void>;
  onSaveThought?: (text: string, context?: { linkedEventId?: string; eventTitle?: string; subject?: string }) => Promise<any>;
  ephemeralCandidate?: TodayRelevanceCandidate | null;
  onDismissEphemeral?: () => void;
}

// Helper for reflection dismissals in localStorage (scoped by occurrence date: sourceId:YYYY-MM-DD)
export const getClientTodayYMD = (): string => {
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

export const getDismissedReflections = (): string[] => {
  try {
    const raw = localStorage.getItem('ezzymigo_dismissed_reflections');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

export const markOccurrenceDismissed = (candidate: TodayRelevanceCandidate) => {
  if (candidate.source_id?.startsWith('ephemeral_call:')) {
    // Ephemeral call candidates are strictly in-memory and never persisted to localStorage
    return;
  }
  try {
    const todayYMD = getClientTodayYMD();
    const occurrenceKey =
      candidate.occurrence_id ||
      (candidate.source_id.includes(':')
        ? candidate.source_id
        : `${candidate.source_id.replace(/:\d{4}-\d{2}-\d{2}$/, '')}:${candidate.event_time && /^\d{4}-\d{2}-\d{2}/.test(candidate.event_time) ? candidate.event_time : todayYMD}`);
    const list = getDismissedReflections();
    if (!list.includes(occurrenceKey)) {
      list.push(occurrenceKey);
      localStorage.setItem('ezzymigo_dismissed_reflections', JSON.stringify(list));
    }
  } catch (e) {
    console.warn('Failed to save dismissed occurrence:', e);
  }
};

export const markReflectionDismissed = (eventId: string, occurrenceId?: string) => {
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
  onSaveThought?: (text: string, context?: { linkedEventId?: string; eventTitle?: string; subject?: string }) => Promise<any>;
  onItemAdded?: (newItem: string) => void;
  onDismissOccurrence?: (candidate: TodayRelevanceCandidate) => void;
}> = ({ candidate, onClose, onSaveThought, onItemAdded, onDismissOccurrence }) => {
  const [text, setText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState<{
    ack_level: 0 | 1 | 2 | 3;
    ack_evidence: string[];
    ack_label: string;
  } | null>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const touchStartY = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);
  const prefs = getUserPreferences();
  const isReflection = candidate.anticipatory_stage === 'reflect';

  // Global Keydown: Escape key closes tray without altering candidate state
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [onClose]);

  // Click/tap outside closes tray without altering candidate state
  useEffect(() => {
    const handlePointerDownOutside = (e: MouseEvent | TouchEvent) => {
      if (trayRef.current && !trayRef.current.contains(e.target as Node)) {
        const ticker = document.getElementById('today-ticker-bar');
        if (ticker && ticker.contains(e.target as Node)) {
          return;
        }
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointerDownOutside);
    document.addEventListener('touchstart', handlePointerDownOutside, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handlePointerDownOutside);
      document.removeEventListener('touchstart', handlePointerDownOutside);
    };
  }, [onClose]);

  // Browser / history back popstate closes tray without altering candidate state
  useEffect(() => {
    const handlePopState = () => {
      onClose();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [onClose]);

  // Touch swipe away gestures close tray without altering candidate state
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartY.current === null || touchStartX.current === null) return;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    // Swipe down/up > 50px or swipe left/right > 80px closes tray
    if (Math.abs(deltaY) > 50 || Math.abs(deltaX) > 80) {
      onClose();
    }
    touchStartY.current = null;
    touchStartX.current = null;
  };

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

  // Explicit Dismiss: Alter state ONLY on intentional user dismiss action
  const handleExplicitDismiss = () => {
    markOccurrenceDismissed(candidate);
    if (onDismissOccurrence) {
      onDismissOccurrence(candidate);
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
      const saveRes = await onSaveThought(trimmed, {
        linkedEventId: occId,
        eventTitle: candidate.event_title || candidate.display_text,
        subject: candidate.source_id?.startsWith('ephemeral_call:')
          ? candidate.event_title
          : ((candidate as any).subject || (candidate.event_title ? candidate.event_title : undefined)),
      });
      if (isReflection) {
        markOccurrenceDismissed(candidate);
        if (onDismissOccurrence) {
          onDismissOccurrence(candidate);
        }
      } else {
        if (onItemAdded) {
          onItemAdded(trimmed);
        }
      }
      setSavedSuccess({
        ack_level: saveRes?.ack_level ?? (isReflection ? 2 : 3),
        ack_evidence: saveRes?.ack_evidence ?? [],
        ack_label: saveRes?.ack_label || (isReflection ? 'Follow-through recorded' : 'Linked to upcoming event'),
      });
      setTimeout(() => {
        onClose();
      }, 1000);
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
      ref={trayRef}
      id="today-anticipatory-prep-tray"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
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
        {/* Close Button: Pure UI dismissal (no state change) */}
        <button
          id="close-anticipatory-prep-btn"
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          title="Close tray"
          aria-label="Close tray"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {savedSuccess ? (
        <div
          id="anticipatory-prep-saved-indicator"
          data-ack-level={savedSuccess.ack_level}
          data-ack-evidence={savedSuccess.ack_evidence.join(';')}
          className="flex items-center gap-2 py-2 px-3 bg-emerald-950/60 border border-emerald-700/50 rounded-lg text-emerald-300 text-xs font-medium animate-in fade-in"
        >
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{savedSuccess.ack_label}</span>
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
              placeholder="Anything you want Ezzy to remember or remind you about?"
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

      {/* Explicit Dismissal Action: Separated from Close (X) */}
      <div className="flex items-center justify-between pt-1 border-t border-zinc-800/80 text-[11px] text-zinc-400">
        <span>Don't want to see this prompt?</span>
        <button
          id="dismiss-anticipatory-occurrence-btn"
          type="button"
          onClick={handleExplicitDismiss}
          className="text-zinc-400 hover:text-zinc-200 underline underline-offset-2 hover:text-amber-400 transition-colors cursor-pointer py-0.5 px-1 font-medium"
          title="Dismiss this occurrence from Today"
        >
          Dismiss prompt
        </button>
      </div>
    </div>
  );
};

// -------------------------------------------------------------
// State 2 Tray: Anticipatory Reminder & Saved Notes Display (+ Add another thing)
// -------------------------------------------------------------
const AnticipatoryReminderTray: React.FC<{
  candidate: TodayRelevanceCandidate;
  onClose: () => void;
  onSaveThought?: (text: string, context?: { linkedEventId?: string; eventTitle?: string; subject?: string }) => Promise<any>;
  onItemAdded?: (newItem: string) => void;
  onDismissOccurrence?: (candidate: TodayRelevanceCandidate) => void;
}> = ({ candidate, onClose, onSaveThought, onItemAdded, onDismissOccurrence }) => {
  const [showAddInput, setShowAddInput] = useState(false);
  const [newText, setNewText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [localItems, setLocalItems] = useState<string[]>(candidate.preparation_items || []);
  const trayRef = useRef<HTMLDivElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const touchStartY = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);
  const prefs = getUserPreferences();

  // Global Keydown: Escape key closes tray without altering candidate state
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [onClose]);

  // Click/tap outside closes tray without altering candidate state
  useEffect(() => {
    const handlePointerDownOutside = (e: MouseEvent | TouchEvent) => {
      if (trayRef.current && !trayRef.current.contains(e.target as Node)) {
        const ticker = document.getElementById('today-ticker-bar');
        if (ticker && ticker.contains(e.target as Node)) {
          return;
        }
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointerDownOutside);
    document.addEventListener('touchstart', handlePointerDownOutside, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handlePointerDownOutside);
      document.removeEventListener('touchstart', handlePointerDownOutside);
    };
  }, [onClose]);

  // Browser / history back popstate closes tray without altering candidate state
  useEffect(() => {
    const handlePopState = () => {
      onClose();
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [onClose]);

  // Touch swipe away gestures close tray without altering candidate state
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartY.current === null || touchStartX.current === null) return;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(deltaY) > 50 || Math.abs(deltaX) > 80) {
      onClose();
    }
    touchStartY.current = null;
    touchStartX.current = null;
  };

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
        linkedEventId: candidate.occurrence_id || candidate.source_id,
        eventTitle: candidate.event_title || candidate.display_text,
        subject: candidate.source_id?.startsWith('ephemeral_call:')
          ? candidate.event_title
          : ((candidate as any).subject || (candidate.event_title ? candidate.event_title : undefined)),
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
      ref={trayRef}
      id="today-anticipatory-reminder-tray"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
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
        {/* Close Button: Pure UI dismissal (no state change) */}
        <button
          id="close-anticipatory-reminder-btn"
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          title="Close tray"
          aria-label="Close tray"
        >
          <X className="w-4 h-4" />
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
              placeholder="Anything you want Ezzy to remember or remind you about?"
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

      {/* Explicit Dismissal Action: Separated from Close (X) */}
      <div className="flex items-center justify-between pt-1 border-t border-zinc-800/80 text-[11px] text-zinc-400">
        <span>Done with this reminder?</span>
        <button
          id="dismiss-anticipatory-reminder-btn"
          type="button"
          onClick={() => {
            markOccurrenceDismissed(candidate);
            if (onDismissOccurrence) {
              onDismissOccurrence(candidate);
            }
            onClose();
          }}
          className="text-zinc-400 hover:text-zinc-200 underline underline-offset-2 hover:text-amber-400 transition-colors cursor-pointer py-0.5 px-1 font-medium"
          title="Dismiss this reminder from Today"
        >
          Dismiss reminder
        </button>
      </div>
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
  ephemeralCandidate,
  onDismissEphemeral,
}) => {
  const [candidates, setCandidates] = useState<TodayRelevanceCandidate[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [headlineIndex, setHeadlineIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [surfacedMemoryId, setSurfacedMemoryId] = useState<string | null>(null);
  const [selectedCalendarItem, setSelectedCalendarItem] = useState<TodayRelevanceCandidate | null>(null);

  const hasFetchedRef = useRef(false);

  // Combine server candidates with any active ephemeral post-call candidate
  const allCandidates = React.useMemo(() => {
    if (!ephemeralCandidate) return candidates;
    const filtered = candidates.filter((c) => c.source_id !== ephemeralCandidate.source_id);
    return [ephemeralCandidate, ...filtered];
  }, [candidates, ephemeralCandidate]);

  useEffect(() => {
    if (ephemeralCandidate) {
      setIsVisible(true);
      setCandidateIndex(0);
      setHeadlineIndex(0);
    }
  }, [ephemeralCandidate]);

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
        if (validCandidates.length > 0 || ephemeralCandidate) {
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
  }, [ephemeralCandidate]);

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
  const currentCandidate = allCandidates[candidateIndex] || allCandidates[0];
  const headlines = currentCandidate?.ticker_headlines && currentCandidate.ticker_headlines.length > 0
    ? currentCandidate.ticker_headlines
    : currentCandidate
    ? [currentCandidate.display_text]
    : [];

  const currentHeadline = headlines[headlineIndex % (headlines.length || 1)] || currentCandidate?.display_text || '';

  // Client-side live ticker cycling timer (Paced dynamically to ensure users have ample time to read auto-scrolling text)
  useEffect(() => {
    if (!isVisible || allCandidates.length === 0 || selectedCalendarItem !== null || surfacedMemoryId !== null) return;

    const textLen = (currentHeadline || '').length;
    const cycleIntervalMs = Math.max(4500, Math.min(9000, 3500 + textLen * 60));

    const timeout = setTimeout(() => {
      setHeadlineIndex((prevHIndex) => {
        const currentCandidateHeadlines =
          allCandidates[candidateIndex]?.ticker_headlines || [allCandidates[candidateIndex]?.display_text || ''];
        
        if (prevHIndex + 1 < currentCandidateHeadlines.length) {
          return prevHIndex + 1;
        } else {
          // Wrapped around headlines for current candidate -> advance candidate
          setCandidateIndex((prevCIndex) => (prevCIndex + 1) % allCandidates.length);
          return 0;
        }
      });
    }, cycleIntervalMs);

    return () => clearTimeout(timeout);
  }, [isVisible, allCandidates, candidateIndex, headlineIndex, currentHeadline, selectedCalendarItem, surfacedMemoryId]);

  // Find underlying memory if surfaced
  const surfacedMemory = surfacedMemoryId
    ? memories.find((m) => String(m.id).trim() === String(surfacedMemoryId).trim())
    : null;

  const handleCandidateClick = (candidate: TodayRelevanceCandidate) => {
    if (!candidate) return;

    const idx = allCandidates.findIndex((c) =>
      candidate.occurrence_id && c.occurrence_id
        ? c.occurrence_id === candidate.occurrence_id
        : c.source_id === candidate.source_id
    );
    if (idx !== -1) {
      setCandidateIndex(idx);
      setHeadlineIndex(0);
    }

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

  const handleDismissCandidate = useCallback((candidate: TodayRelevanceCandidate) => {
    if (candidate.source_id?.startsWith('ephemeral_call:')) {
      if (onDismissEphemeral) {
        onDismissEphemeral();
      }
    }
    setCandidates((prev) => {
      const newCandidates = prev.filter((c) => {
        if (candidate.occurrence_id && c.occurrence_id) {
          return c.occurrence_id !== candidate.occurrence_id;
        }
        return c.source_id !== candidate.source_id;
      });
      if (newCandidates.length === 0 && !ephemeralCandidate) {
        setIsVisible(false);
        setCandidateIndex(0);
        setHeadlineIndex(0);
      } else {
        const totalLen = ephemeralCandidate ? newCandidates.length + 1 : newCandidates.length;
        setCandidateIndex((prevIndex) => (prevIndex >= totalLen ? 0 : prevIndex));
        setHeadlineIndex(0);
      }
      return newCandidates;
    });
  }, [onDismissEphemeral, ephemeralCandidate]);

  const handleRemoveCandidate = useCallback((candidateSourceId: string) => {
    if (candidateSourceId.startsWith('ephemeral_call:')) {
      if (onDismissEphemeral) {
        onDismissEphemeral();
      }
    }
    setCandidates((prev) => {
      const newCandidates = prev.filter((c) => c.source_id !== candidateSourceId);
      if (newCandidates.length === 0 && !ephemeralCandidate) {
        setIsVisible(false);
        setCandidateIndex(0);
        setHeadlineIndex(0);
      } else {
        const totalLen = ephemeralCandidate ? newCandidates.length + 1 : newCandidates.length;
        setCandidateIndex((prevIndex) => (prevIndex >= totalLen ? 0 : prevIndex));
        setHeadlineIndex(0);
      }
      return newCandidates;
    });
  }, [onDismissEphemeral, ephemeralCandidate]);

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
            {currentCandidate.source_id?.startsWith('ephemeral_call:') && (
              <button
                id="dismiss-ephemeral-call-btn"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDismissEphemeral?.();
                }}
                className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors cursor-pointer"
                title="Dismiss prompt"
                aria-label="Dismiss post-call prompt"
              >
                <X className="w-3.5 h-3.5" />
              </button>
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
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200 transition-colors cursor-pointer shrink-0"
              title="Close view"
              aria-label="Close view"
            >
              <X className="w-3.5 h-3.5" />
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
            onDismissOccurrence={handleDismissCandidate}
          />
        ) : selectedCalendarItem.is_anticipatory ? (
          <AnticipatoryPreparationTray
            candidate={selectedCalendarItem}
            onClose={() => setSelectedCalendarItem(null)}
            onSaveThought={onSaveThought}
            onItemAdded={handleItemAddedToCandidate}
            onDismissOccurrence={handleDismissCandidate}
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
              id="close-surfaced-calendar-btn"
              type="button"
              onClick={() => setSelectedCalendarItem(null)}
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200 transition-colors cursor-pointer shrink-0"
              title="Close view"
              aria-label="Close view"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )
      )}
    </div>
  );
};

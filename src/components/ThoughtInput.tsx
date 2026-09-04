import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Loader2, Mic, MessageSquarePlus, X, Check, Pause, Play, Plus, List } from 'lucide-react';
import { useSpeechDictation } from '../utils/useSpeechDictation';
import { getUserPreferences } from '../utils/userPreferences';
import { ImmediateDeviceActionPayload } from '../types';

interface ThoughtInputProps {
  onSave: (text: string, subject?: string) => Promise<void>;
  onImmediateAction?: (action: ImmediateDeviceActionPayload) => Promise<void> | void;
  isLoading: boolean;
  existingSubjects?: string[];
  activeSubject?: string | null;
  onActiveSubjectChange?: (subject: string | null) => void;
  isSubjectPaused?: boolean;
  onSubjectPausedChange?: (paused: boolean) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement>;
}

export const ThoughtInput: React.FC<ThoughtInputProps> = ({
  onSave,
  onImmediateAction,
  isLoading,
  existingSubjects = [],
  activeSubject: controlledActiveSubject,
  onActiveSubjectChange,
  isSubjectPaused: controlledIsSubjectPaused,
  onSubjectPausedChange,
  inputRef: forwardedInputRef,
}) => {
  const [thought, setThought] = useState('');
  const thoughtRef = useRef('');
  useEffect(() => {
    thoughtRef.current = thought;
  }, [thought]);
  const [showSaved, setShowSaved] = useState(false);
  const [internalActiveSubject, setInternalActiveSubject] = useState<string | null>(null);
  const [internalIsSubjectPaused, setInternalIsSubjectPaused] = useState(false);
  const [isEnteringSubject, setIsEnteringSubject] = useState(false);
  const [isCreatingNewSubject, setIsCreatingNewSubject] = useState(false);
  const [subjectDraft, setSubjectDraft] = useState('');
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = forwardedInputRef || internalTextareaRef;
  const pickerRef = useRef<HTMLDivElement>(null);
  const savedTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const prefs = getUserPreferences();

  const activeSubject = controlledActiveSubject !== undefined ? controlledActiveSubject : internalActiveSubject;
  const isSubjectPaused = controlledIsSubjectPaused !== undefined ? controlledIsSubjectPaused : internalIsSubjectPaused;

  const setActiveSubject = useCallback(
    (val: string | null) => {
      if (onActiveSubjectChange) {
        onActiveSubjectChange(val);
      }
      setInternalActiveSubject(val);
    },
    [onActiveSubjectChange]
  );

  const setIsSubjectPaused = useCallback(
    (val: boolean) => {
      if (onSubjectPausedChange) {
        onSubjectPausedChange(val);
      }
      setInternalIsSubjectPaused(val);
    },
    [onSubjectPausedChange]
  );

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) {
        clearTimeout(savedTimeoutRef.current);
      }
    };
  }, []);

  // Dismiss picker on outside click / escape
  useEffect(() => {
    if (!isEnteringSubject) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        handleCancelEnteringSubject();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCancelEnteringSubject();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isEnteringSubject]);

  const handleAppendText = useCallback((phrase: string) => {
    setThought((prev) => {
      const trimmedBase = prev.trim();
      const nextText = trimmedBase ? `${trimmedBase} ${phrase}` : phrase;
      thoughtRef.current = nextText;
      return nextText;
    });
  }, []);

  const handleAppendSubjectDraft = useCallback((phrase: string) => {
    setSubjectDraft((prev) => {
      const trimmedBase = prev.trim();
      if (!trimmedBase) {
        return phrase;
      }
      return `${trimmedBase} ${phrase}`;
    });
  }, []);

  const handleClear = () => {
    setThought('');
    thoughtRef.current = '';
    if (textareaRef.current) {
      textareaRef.current.style.height = '38px';
      textareaRef.current.focus();
    }
  };

  const handleSelectExistingSubject = (subj: string) => {
    if (subjectDictation.isListening) {
      subjectDictation.stopListening();
    }
    const trimmed = subj.trim();
    if (trimmed) {
      setActiveSubject(trimmed);
      setIsSubjectPaused(false);
      setIsEnteringSubject(false);
      setIsCreatingNewSubject(false);
      setSubjectDraft('');
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }
  };

  const handleApplySubject = () => {
    if (subjectDictation.isListening) {
      subjectDictation.stopListening();
    }
    const trimmed = subjectDraft.trim();
    if (trimmed) {
      setActiveSubject(trimmed);
      setIsSubjectPaused(false);
      setIsEnteringSubject(false);
      setIsCreatingNewSubject(false);
      setSubjectDraft('');
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }
  };

  const handleClearSubject = () => {
    if (subjectDictation.isListening) {
      subjectDictation.stopListening();
    }
    setActiveSubject(null);
    setIsSubjectPaused(false);
    setIsEnteringSubject(false);
    setIsCreatingNewSubject(false);
    setSubjectDraft('');
  };

  const handleCancelEnteringSubject = () => {
    if (subjectDictation.isListening) {
      subjectDictation.stopListening();
    }
    setIsEnteringSubject(false);
    setIsCreatingNewSubject(false);
    setSubjectDraft('');
  };

  const { isListening, speechNotice, startListening, stopListening } = useSpeechDictation({
    onAppendText: handleAppendText,
    language: prefs.language,
  });

  const subjectDictation = useSpeechDictation({
    onAppendText: handleAppendSubjectDraft,
    language: prefs.language,
  });

  const effectiveSubject = activeSubject && !isSubjectPaused ? activeSubject : undefined;

  // Auto-expand textarea height as user enters text (compact default: 38px)
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = `${Math.max(scrollHeight, 38)}px`;
    }
  }, [thought, textareaRef]);

  const submitThought = async (rawText?: string) => {
    const textToSave = (rawText !== undefined ? rawText : thoughtRef.current).trim();
    if (!textToSave || isLoading) return;

    try {
      await onSave(textToSave, effectiveSubject);
      setThought('');
      thoughtRef.current = '';
      if (textareaRef.current) {
        textareaRef.current.style.height = '38px';
      }

      setShowSaved(true);
      if (savedTimeoutRef.current) {
        clearTimeout(savedTimeoutRef.current);
      }
      savedTimeoutRef.current = setTimeout(() => {
        setShowSaved(false);
      }, 1500);
    } catch {
      // On save failure, do not show saved confirmation or clear text
    }
  };

  const handleSubmit = async () => {
    if (isListening) {
      await stopListening();
    }
    const textToSubmit = thoughtRef.current.trim();
    if (!textToSubmit || isLoading) return;
    await submitThought(textToSubmit);
  };

  const handleMicClick = async () => {
    if (subjectDictation.isListening) {
      await subjectDictation.stopListening();
    }

    if (isListening) {
      // Voice-stop behaviour:
      // When the user taps the mic while listening, finalize the transcript
      // and submit that completed Tell through the existing proven Save/submit path.
      await stopListening();
      const textToSubmit = thoughtRef.current.trim();
      if (textToSubmit) {
        await submitThought(textToSubmit);
      }
    } else {
      startListening();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      handleSubmit();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      handleSubmit();
    }
  };

  return (
    <div
      id="tell-ezzymigo-panel"
      className={`rounded-xl border p-2.5 sm:p-3.5 shadow-xs space-y-2 transition-all ${
        effectiveSubject ? 'bg-indigo-50/20 border-indigo-200' : 'bg-white border-zinc-200'
      }`}
    >
      <div className="flex flex-col gap-1.5">
        {/* Top row: Title on left, Lists in header space, Save button on right */}
        <div className="flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
          <div className="flex items-center gap-2 shrink-0">
            <div
              className={`p-1 rounded-md text-white transition-colors ${
                effectiveSubject ? 'bg-indigo-700' : 'bg-zinc-900'
              }`}
            >
              {effectiveSubject ? (
                <List className="w-3.5 h-3.5" />
              ) : (
                <MessageSquarePlus className="w-3.5 h-3.5" />
              )}
            </div>
            <h3
              id="capture-heading"
              className={`text-xs sm:text-sm font-bold leading-none transition-colors ${
                effectiveSubject ? 'text-indigo-950' : 'text-zinc-900'
              }`}
            >
              {effectiveSubject ? 'Add to List' : 'Tell Ezzymigo'}
            </h3>
            {isListening && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 bg-red-50 border border-red-200/80 px-1.5 py-0.5 rounded-md animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-red-600" />
                Listening…
              </span>
            )}
            {showSaved && (
              <span
                id="tell-saved-indicator"
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200/80 px-1.5 py-0.5 rounded-md transition-all animate-in fade-in duration-150"
              >
                <Check className="w-3 h-3 text-emerald-600" />
                Saved ✓
              </span>
            )}
          </div>

          {/* Header Space: Lists Control */}
          <div className="flex items-center gap-1.5 order-last sm:order-none w-full sm:w-auto sm:ml-auto sm:mr-2">
            {activeSubject ? (
              isSubjectPaused ? (
                /* Paused state chip with Resume and End/Clear actions */
                <div
                  id="same-subject-paused-chip"
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-700 bg-zinc-100 border border-zinc-300 px-2 py-0.5 rounded-md max-w-full"
                >
                  <span className="text-zinc-500 font-normal">⏸</span>
                  <span className="truncate max-w-[90px] sm:max-w-[140px] text-zinc-600" title={activeSubject}>
                    {activeSubject}
                  </span>
                  <span className="text-[10px] text-zinc-500 font-normal">(paused)</span>
                  <button
                    id="resume-same-subject-btn"
                    type="button"
                    onClick={() => setIsSubjectPaused(false)}
                    className="inline-flex items-center gap-0.5 text-indigo-700 hover:text-indigo-950 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200/90 px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer"
                    title="Resume list mode"
                    aria-label="Resume list mode"
                  >
                    <Play className="w-2.5 h-2.5 fill-current" />
                    <span>Resume</span>
                  </button>
                  <button
                    id="clear-same-subject-btn"
                    type="button"
                    onClick={handleClearSubject}
                    className="text-zinc-400 hover:text-zinc-800 p-0.5 rounded cursor-pointer transition-colors"
                    title="End list mode"
                    aria-label="End list mode"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                /* Active state chip with Pause and End/Clear actions */
                <div
                  id="same-subject-chip"
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-indigo-950 bg-indigo-50 border border-indigo-200/90 px-2 py-0.5 rounded-md max-w-full"
                >
                  <List className="w-3 h-3 text-indigo-700 shrink-0" />
                  <span className="truncate max-w-[100px] sm:max-w-[150px]" title={activeSubject}>
                    {activeSubject}
                  </span>
                  <button
                    id="pause-same-subject-btn"
                    type="button"
                    onClick={() => setIsSubjectPaused(true)}
                    className="inline-flex items-center gap-0.5 text-indigo-700 hover:text-indigo-950 hover:bg-indigo-100/80 px-1 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer"
                    title="Pause list"
                    aria-label="Pause list"
                  >
                    <Pause className="w-2.5 h-2.5" />
                    <span>Pause</span>
                  </button>
                  <button
                    id="clear-same-subject-btn"
                    type="button"
                    onClick={handleClearSubject}
                    className="text-indigo-400 hover:text-indigo-800 p-0.5 rounded cursor-pointer transition-colors"
                    title="End list mode"
                    aria-label="End list mode"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )
            ) : isEnteringSubject ? (
              /* Picker or New List input */
              <div ref={pickerRef} className="relative z-30 inline-block">
                {isCreatingNewSubject || existingSubjects.length === 0 ? (
                  /* Inline entry with Dictation Mic and Text input */
                  <div className="inline-flex items-center gap-1 bg-zinc-100 border border-zinc-300 rounded-md px-1.5 py-0.5 max-w-full">
                    <List className="w-3.5 h-3.5 text-indigo-700 shrink-0" />
                    <button
                      id="subject-mic-dictate-btn"
                      type="button"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        if (isListening) stopListening();
                        subjectDictation.toggleListening();
                      }}
                      className={`p-1 rounded transition-all cursor-pointer ${
                        subjectDictation.isListening
                          ? 'bg-red-100 text-red-600 ring-1 ring-red-400 animate-pulse'
                          : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-200/70'
                      }`}
                      title={subjectDictation.isListening ? 'Stop list name dictation' : 'Dictate list name'}
                      aria-label={subjectDictation.isListening ? 'Stop list name dictation' : 'Dictate list name'}
                    >
                      <Mic className="w-3 h-3" />
                    </button>
                    <input
                      id="same-subject-input"
                      type="text"
                      autoFocus
                      value={subjectDraft}
                      onMouseDown={(e) => e.stopPropagation()}
                      onChange={(e) => setSubjectDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          handleApplySubject();
                        } else if (e.key === 'Escape') {
                          handleCancelEnteringSubject();
                        }
                      }}
                      placeholder={
                        subjectDictation.isListening
                          ? 'Listening for list name…'
                          : "List name (e.g. Mum's Sold Items)"
                      }
                      className="text-xs text-zinc-900 bg-transparent focus:outline-hidden w-36 sm:w-48 placeholder:text-zinc-400"
                    />
                    <button
                      id="confirm-same-subject-btn"
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleApplySubject();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleApplySubject();
                      }}
                      disabled={!subjectDraft.trim()}
                      className="text-indigo-700 hover:text-indigo-950 disabled:opacity-40 text-[11px] px-1 font-semibold cursor-pointer"
                      title="Set list"
                    >
                      Set
                    </button>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleCancelEnteringSubject();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCancelEnteringSubject();
                      }}
                      className="text-zinc-400 hover:text-zinc-700 text-xs p-0.5 cursor-pointer"
                      title="Cancel"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  /* Dropdown picker offering existing lists + option to create new list */
                  <div
                    id="same-subject-picker-dropdown"
                    className="absolute left-0 sm:right-0 sm:left-auto top-full mt-1 w-56 sm:w-64 bg-white border border-zinc-200 rounded-lg shadow-lg py-1 text-xs text-zinc-800 z-50 animate-in fade-in zoom-in-95 duration-100"
                  >
                    <div className="px-2.5 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider border-b border-zinc-100 flex items-center justify-between">
                      <span>Choose List</span>
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleCancelEnteringSubject();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCancelEnteringSubject();
                        }}
                        className="text-zinc-400 hover:text-zinc-600 p-0.5 cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>

                    {/* List of existing subjects */}
                    <div className="max-h-48 overflow-y-auto divide-y divide-zinc-50">
                      {existingSubjects.map((subj) => (
                        <button
                          key={subj}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleSelectExistingSubject(subj);
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectExistingSubject(subj);
                          }}
                          className="w-full text-left px-2.5 py-1.5 hover:bg-indigo-50/80 hover:text-indigo-950 flex items-center gap-1.5 cursor-pointer transition-colors group"
                        >
                          <List className="w-3 h-3 text-zinc-400 group-hover:text-indigo-600 shrink-0" />
                          <span className="font-medium truncate">{subj}</span>
                        </button>
                      ))}
                    </div>

                    {/* Option to create a new list */}
                    <div className="border-t border-zinc-100 p-1">
                      <button
                        id="new-subject-option-btn"
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setIsCreatingNewSubject(true);
                          setSubjectDraft('');
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsCreatingNewSubject(true);
                          setSubjectDraft('');
                        }}
                        className="w-full text-left px-2 py-1.5 rounded text-indigo-700 hover:bg-indigo-50 font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>+ New list…</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Compact Lists toggle button */
              <button
                id="same-subject-toggle-btn"
                type="button"
                onClick={() => {
                  setIsEnteringSubject(true);
                  setIsCreatingNewSubject(existingSubjects.length === 0);
                  setSubjectDraft('');
                }}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200 border border-zinc-200/80 rounded-md transition-colors cursor-pointer"
                title="Create or select a list"
              >
                <List className="w-3 h-3 text-indigo-700" />
                <span>{existingSubjects.length === 0 ? '+ List' : 'Lists'}</span>
              </button>
            )}
          </div>

          <button
            id="save-thought-btn"
            type="button"
            onClick={handleSubmit}
            disabled={!thought.trim() || isLoading}
            className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 disabled:opacity-40 rounded-lg text-xs font-semibold transition-colors cursor-pointer shadow-xs shrink-0 ml-auto sm:ml-0 ${
              effectiveSubject
                ? 'bg-indigo-700 hover:bg-indigo-800 text-white'
                : 'bg-zinc-900 hover:bg-zinc-800 text-white'
            }`}
          >
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3 h-3" />
            )}
            <span>{isLoading ? 'Saving…' : 'Save ➤'}</span>
          </button>
        </div>

        {/* Input row: Full width container with mic embedded inside left */}
        <div className="relative flex items-center w-full">
          <button
            id="mic-dictate-btn"
            type="button"
            onClick={handleMicClick}
            disabled={isLoading}
            title={isListening ? 'Finish dictation and save' : 'Start microphone dictation'}
            aria-label={isListening ? 'Finish dictation and save' : 'Start microphone dictation'}
            className={`absolute left-2 top-2 p-1.5 rounded-md transition-all cursor-pointer z-10 ${
              isListening
                ? 'bg-red-100 text-red-600 ring-2 ring-red-400 animate-pulse'
                : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-200/70'
            }`}
          >
            <Mic className={`w-4 h-4 ${isListening ? 'text-red-600' : 'text-zinc-600'}`} />
          </button>

          <textarea
            ref={textareaRef}
            id="thought-input"
            value={thought}
            onChange={(e) => {
              setThought(e.target.value);
              thoughtRef.current = e.target.value;
            }}
            onKeyDown={handleKeyDown}
            placeholder={effectiveSubject ? `Add item to ${effectiveSubject}…` : "What's on your mind?"}
            rows={1}
            disabled={isLoading}
            className="w-full min-h-[38px] max-h-36 pl-9 pr-9 py-2 bg-zinc-50 rounded-lg border border-zinc-200 text-xs sm:text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-hidden focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 focus:bg-white disabled:opacity-60 transition-all resize-none leading-relaxed"
          />

          {thought.length > 0 && (
            <button
              id="thought-clear-input-btn"
              type="button"
              onClick={handleClear}
              disabled={isLoading}
              title="Clear text"
              aria-label="Clear text"
              className="absolute right-1.5 top-2 p-1.5 min-w-[28px] min-h-[28px] sm:min-w-[26px] sm:min-h-[26px] flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/70 transition-colors cursor-pointer z-10"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Listening State & Speech Notices */}
        {(isListening || subjectDictation.isListening || speechNotice || subjectDictation.speechNotice) && (
          <div className="text-xs flex items-center justify-between gap-2 px-1">
            {isListening ? (
              <div className="flex items-center gap-1.5 text-red-600 font-medium text-[11px] animate-pulse">
                <span className="w-2 h-2 rounded-full bg-red-600" />
                <span>Listening… Speak naturally. Tap 🎤 or Save when done.</span>
              </div>
            ) : subjectDictation.isListening ? (
              <div className="flex items-center gap-1.5 text-red-600 font-medium text-[11px] animate-pulse">
                <span className="w-2 h-2 rounded-full bg-red-600" />
                <span>Listening for list name… Speak name, then tap Set.</span>
              </div>
            ) : null}
            {speechNotice || subjectDictation.speechNotice ? (
              <span className="text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 text-[10px]">
                {speechNotice || subjectDictation.speechNotice}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

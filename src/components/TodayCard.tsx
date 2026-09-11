import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, Mic, MicOff, Send, Loader2, Check, X } from 'lucide-react';
import { getUserPreferences } from '../utils/userPreferences';
import { useSpeechDictation } from '../utils/useSpeechDictation';
import { ConversationalContextEnvelope } from '../types';

export interface TodayEvaluation {
  id: string;
  ezzy_id: string;
  timestamp: string;
  opportunity: string;
  trigger_name: string;
  new_ezzy_decision: {
    communication: {
      mode: 'SPEAK' | 'PROMPT' | 'SILENT';
      headline: string | null;
      body: string | null;
      question: string | null;
    };
    proposedMutations: Array<{
      originalText: string;
      content: string;
      kind: string;
      isDone: boolean;
    }>;
    proposedResolutions: string[];
    citedMemoryIds: string[];
    citedCalendarIds: string[];
    rationale: string;
  };
  new_ezzy_rationale: string;
  cited_memory_ids: string[];
  cited_calendar_ids: string[];
  model_name: string;
  latency_ms: number;
}

export interface CommunicationItem {
  id: string;
  evaluation: TodayEvaluation;
  tickerText: string;
  detailTitle: string;
  detailPrompt: string;
  placeholder: string;
  isRestrained?: boolean;
  linkedEventId?: string;
  eventTitle?: string;
}

interface TodayCardProps {
  onSaveThought?: (
    text: string,
    context?: {
      linkedEventId?: string;
      eventTitle?: string;
      subject?: string;
      isCaptureFlow?: boolean;
      contextEnvelope?: ConversationalContextEnvelope;
    }
  ) => Promise<any>;
}

// -------------------------------------------------------------
// Horizontal Marquee / Auto-Scroll for overflowing ticker text
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
        setOverflowDistance(diff > 4 ? diff + 12 : 0);
      }
    };

    checkOverflow();
    const resizeObserver = new ResizeObserver(() => checkOverflow());
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    return () => resizeObserver.disconnect();
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
        className="font-medium text-emerald-950 group-hover:text-emerald-900 whitespace-nowrap shrink-0"
      >
        {text}
      </span>
    </div>
  );
};

// -------------------------------------------------------------
// Helper to extract user-facing communication items from evaluations
// -------------------------------------------------------------
function extractCommunications(
  todayEval: TodayEvaluation | null,
  checkInEval: TodayEvaluation | null,
  recentEvals: TodayEvaluation[]
): CommunicationItem[] {
  const items: CommunicationItem[] = [];
  const seenTexts = new Set<string>();

  const allEvals = [todayEval, checkInEval, ...(recentEvals || [])].filter(
    (ev): ev is TodayEvaluation => Boolean(ev && ev.new_ezzy_decision)
  );

  const uniqueEvals: TodayEvaluation[] = [];
  const seenEvalIds = new Set<string>();
  for (const ev of allEvals) {
    if (!seenEvalIds.has(ev.id)) {
      seenEvalIds.add(ev.id);
      uniqueEvals.push(ev);
    }
  }

  for (const ev of uniqueEvals) {
    const comm = ev.new_ezzy_decision.communication;
    if (!comm || comm.mode === 'SILENT') continue;

    const linkedEventId = ev.cited_calendar_ids?.[0] || ev.cited_memory_ids?.[0];
    const eventTitle = comm.headline || undefined;

    if (ev.opportunity === 'TODAY_ORIENT') {
      if (comm.headline && !seenTexts.has(comm.headline.trim().toLowerCase())) {
        seenTexts.add(comm.headline.trim().toLowerCase());
        items.push({
          id: `${ev.id}_headline`,
          evaluation: ev,
          tickerText: comm.headline.trim(),
          detailTitle: comm.headline.trim(),
          detailPrompt: comm.question || comm.body || comm.headline.trim(),
          placeholder: 'Anything you want Ezzy to remember or update?',
          linkedEventId,
          eventTitle,
        });
      }

      if (comm.question && !seenTexts.has(comm.question.trim().toLowerCase())) {
        const qClean = comm.question.trim().toLowerCase();
        let alreadyCovered = false;
        for (const seen of seenTexts) {
          if (seen.includes(qClean) || qClean.includes(seen)) {
            alreadyCovered = true;
            break;
          }
        }
        if (!alreadyCovered) {
          seenTexts.add(qClean);
          items.push({
            id: `${ev.id}_question`,
            evaluation: ev,
            tickerText: comm.question.trim(),
            detailTitle: comm.headline || 'Follow-up',
            detailPrompt: comm.question.trim(),
            placeholder: 'Answer or note anything here...',
            linkedEventId,
            eventTitle,
          });
        }
      }
    } else {
      const primaryText = comm.question || comm.headline || comm.body;
      if (primaryText) {
        const clean = primaryText.trim().toLowerCase();
        let alreadyCovered = false;
        for (const seen of seenTexts) {
          if (seen.includes(clean) || clean.includes(seen)) {
            alreadyCovered = true;
            break;
          }
        }
        if (!alreadyCovered) {
          seenTexts.add(clean);
          items.push({
            id: `${ev.id}_non_today`,
            evaluation: ev,
            tickerText: primaryText.trim(),
            detailTitle: comm.headline || 'Follow-up',
            detailPrompt: comm.question || comm.headline || primaryText.trim(),
            placeholder: 'Answer or note anything here...',
            linkedEventId,
            eventTitle,
          });
        }
      }
    }
  }

  if (items.length === 0) {
    const fallbackEval = todayEval || checkInEval || (uniqueEvals.length > 0 ? uniqueEvals[0] : null);
    items.push({
      id: 'silent_restraint',
      evaluation: fallbackEval || ({
        id: 'restrained_synthetic',
        ezzy_id: 'ezzy_default',
        timestamp: new Date().toISOString(),
        opportunity: 'TODAY_ORIENT',
        trigger_name: 'restraint',
        new_ezzy_decision: {
          communication: { mode: 'SILENT', headline: null, body: null, question: null },
          proposedMutations: [],
          proposedResolutions: [],
          citedMemoryIds: [],
          citedCalendarIds: [],
          rationale: 'Evaluated personal world and determined nothing requires proactive interruption.'
        },
        new_ezzy_rationale: 'Evaluated personal world and determined nothing requires proactive interruption.',
        cited_memory_ids: [],
        cited_calendar_ids: [],
        model_name: 'gemini-3.7-flash',
        latency_ms: 0,
      } as any),
      tickerText: (() => {
        const hour = new Date().getHours();
        if (hour < 12) return 'Good morning, Paul. How are you doing today?';
        if (hour < 17) return 'Good afternoon, Paul. How are you doing today?';
        return 'Good evening, Paul. How are you doing today?';
      })(),
      detailTitle: 'Daily Check-in',
      detailPrompt: 'No urgent commitments or reminders right now. How is your day going?',
      placeholder: 'Anything you want Ezzy to remember or update?',
      isRestrained: true,
    });
  }

  return items;
}

// -------------------------------------------------------------
// CANONICAL TODAY COMPONENT
// -------------------------------------------------------------
export function TodayCard({ onSaveThought }: TodayCardProps) {
  const [todayEvaluation, setTodayEvaluation] = useState<TodayEvaluation | null>(null);
  const [checkInEvaluation, setCheckInEvaluation] = useState<TodayEvaluation | null>(null);
  const [recentEvaluations, setRecentEvaluations] = useState<TodayEvaluation[]>([]);
  const [attentionReview, setAttentionReview] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Cycling ticker state
  const [communicationIndex, setCommunicationIndex] = useState(0);

  // Detail Tray (dropdown on tap)
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [responseText, setResponseText] = useState('');
  const [isSavingResponse, setIsSavingResponse] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const detailInputRef = useRef<HTMLInputElement>(null);
  const detailTrayRef = useRef<HTMLDivElement>(null);
  const prefs = getUserPreferences();

  // Fetch canonical Today state from GET /api/today
  const fetchTodayState = useCallback(async () => {
    try {
      const tz = prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';
      const now = new Date().toISOString();
      const res = await fetch(`/api/today?clientNow=${encodeURIComponent(now)}&clientTimeZone=${encodeURIComponent(tz)}`);
      if (res.ok) {
        const data = await res.json();
        const todayEval = data.todayEvaluation || data.evaluation || null;
        const checkInEval = data.checkInEvaluation || null;
        const recents = data.recentEvaluations || [];

        setTodayEvaluation(todayEval);
        setCheckInEvaluation(checkInEval);
        setRecentEvaluations(recents);
        setAttentionReview(data.attentionReview || null);
      }
    } catch (err) {
      console.warn('[Today Card] Error fetching today state:', err);
    } finally {
      setIsLoading(false);
    }
  }, [prefs.timezone]);

  useEffect(() => {
    fetchTodayState();
  }, [fetchTodayState]);

  // Extract communications from Curated Attention Channel or fallback
  const communications = React.useMemo(() => {
    if (attentionReview && attentionReview.active_channel) {
      if (attentionReview.active_channel.length > 0) {
        return attentionReview.active_channel.map((c: any) => {
          const matchingEval = recentEvaluations.find((ev) =>
            c.sourceCandidateIds?.includes(`cand_${ev.id}`) || ev.id === c.sourceCandidateIds?.[0]?.replace('cand_', '')
          ) || todayEvaluation || checkInEvaluation;

          return {
            id: c.id,
            evaluation: matchingEval || ({
              id: c.id,
              ezzy_id: 'ezzy_default',
              timestamp: attentionReview.timestamp,
              opportunity: 'ATTENTION_CHANNEL',
              trigger_name: 'executive_curation',
              new_ezzy_decision: {
                communication: {
                  mode: c.mode,
                  headline: c.headline,
                  body: c.body,
                  question: c.question,
                },
                proposedMutations: [],
                proposedResolutions: [],
                citedMemoryIds: [],
                citedCalendarIds: [],
                rationale: c.priorityRationale || attentionReview.overall_rationale,
              },
              new_ezzy_rationale: c.priorityRationale || attentionReview.overall_rationale,
              cited_memory_ids: [],
              cited_calendar_ids: [],
              model_name: attentionReview.model_name,
              latency_ms: attentionReview.latency_ms,
            } as any),
            tickerText: c.question || c.headline || c.body || '',
            detailTitle: c.headline || 'Ezzymigo Update',
            detailPrompt: c.question || c.body || c.headline || '',
            placeholder: 'Answer or note anything here...',
            linkedEventId: c.linkedEventId || undefined,
            eventTitle: c.headline || undefined,
          };
        });
      } else {
        const fallbackEval = todayEvaluation || checkInEvaluation;
        return [
          {
            id: 'curated_restraint',
            evaluation: fallbackEval || ({
              id: 'restrained_synthetic',
              ezzy_id: 'ezzy_default',
              timestamp: attentionReview.timestamp,
              opportunity: 'TODAY_ORIENT',
              trigger_name: 'executive_restraint',
              new_ezzy_decision: {
                communication: { mode: 'SILENT', headline: null, body: null, question: null },
                proposedMutations: [],
                proposedResolutions: [],
                citedMemoryIds: [],
                citedCalendarIds: [],
                rationale: attentionReview.overall_rationale || 'Executive review chose quiet restraint.',
              },
              new_ezzy_rationale: attentionReview.overall_rationale || 'Executive review chose quiet restraint.',
              cited_memory_ids: [],
              cited_calendar_ids: [],
              model_name: attentionReview.model_name,
              latency_ms: attentionReview.latency_ms,
            } as any),
            tickerText: (() => {
              const hour = new Date().getHours();
              if (hour < 12) return 'Good morning, Paul. How are you doing today?';
              if (hour < 17) return 'Good afternoon, Paul. How are you doing today?';
              return 'Good evening, Paul. How are you doing today?';
            })(),
            detailTitle: 'Daily Check-in',
            detailPrompt: 'No urgent commitments or reminders right now. How is your day going?',
            placeholder: 'Add anything on your mind...',
            isRestrained: true,
          },
        ];
      }
    }
    return extractCommunications(todayEvaluation, checkInEvaluation, recentEvaluations);
  }, [attentionReview, todayEvaluation, checkInEvaluation, recentEvaluations]);

  const currentComm = communications[communicationIndex] || communications[0];

  // Cycling ticker interval
  useEffect(() => {
    if (communications.length <= 1 || isDetailOpen) return;

    const currentText = currentComm?.tickerText || '';
    const intervalMs = Math.max(5000, Math.min(9500, 3500 + currentText.length * 60));

    const timer = setTimeout(() => {
      setCommunicationIndex((prev) => (prev + 1) % communications.length);
    }, intervalMs);

    return () => clearTimeout(timer);
  }, [communications, communicationIndex, currentComm, isDetailOpen]);

  // Speech dictation for detail tray
  const handleAppendSpeech = useCallback((phrase: string) => {
    setResponseText((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed} ${phrase}` : phrase;
    });
  }, []);

  const { isListening, toggleListening, speechNotice } = useSpeechDictation({
    onAppendText: handleAppendSpeech,
    language: prefs.language || 'en-AU',
  });

  const handleTickerTap = () => {
    setIsDetailOpen((prev) => {
      const next = !prev;
      if (next) {
        setTimeout(() => detailInputRef.current?.focus(), 150);
      }
      return next;
    });
  };

  const handleSaveResponse = async () => {
    const trimmed = responseText.trim();
    if (!trimmed || isSavingResponse) return;

    setIsSavingResponse(true);
    let savedMemoryId: string | null = null;

    try {
      const contextEnvelope: ConversationalContextEnvelope = {
        originatingCommunicationId: currentComm?.evaluation?.id || 'today_interaction',
        originatingQuestion: currentComm?.detailPrompt || currentComm?.tickerText,
        promptHeadline: currentComm?.detailTitle,
        linkedEventId: currentComm?.linkedEventId,
        linkedEventTitle: currentComm?.eventTitle,
        userUtterance: trimmed,
        conversationHistory: [
          {
            speaker: 'ezzy',
            text: currentComm?.detailPrompt || currentComm?.tickerText,
          },
          {
            speaker: 'user',
            text: trimmed,
          },
        ],
      };

      if (onSaveThought) {
        const savedData = await onSaveThought(trimmed, {
          linkedEventId: currentComm?.linkedEventId,
          eventTitle: currentComm?.eventTitle || currentComm?.detailTitle,
          isCaptureFlow: true,
          contextEnvelope,
        });
        savedMemoryId = savedData?.memory?.id || savedData?.memories?.[0]?.id || savedData?.id || null;
      } else {
        const tz = prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';
        const res = await fetch('/api/memories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originalText: trimmed,
            clientNow: new Date().toISOString(),
            clientTimeZone: tz,
            clientLanguage: prefs.language || 'en-AU',
            clientRegion: prefs.region || 'AU',
            linkedEventId: currentComm?.linkedEventId,
            eventTitle: currentComm?.eventTitle || currentComm?.detailTitle,
            isCaptureFlow: true,
            contextEnvelope,
          }),
        });
        const resJson = await res.json().catch(() => ({}));
        savedMemoryId = resJson?.memory?.id || resJson?.memories?.[0]?.id || resJson?.id || null;
      }

      // Record authoritative interaction provenance linking communication -> response -> memory
      await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          communicationId: currentComm?.id,
          evaluationId: currentComm?.evaluation?.id,
          opportunity: currentComm?.evaluation?.opportunity,
          promptHeadline: currentComm?.detailTitle,
          promptQuestion: currentComm?.detailPrompt,
          userResponse: trimmed,
          capturedMemoryId: savedMemoryId,
        }),
      }).catch(() => {
        // Fallback to /api/shadow/interactions
        return fetch('/api/shadow/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            communicationId: currentComm?.id,
            evaluationId: currentComm?.evaluation?.id,
            opportunity: currentComm?.evaluation?.opportunity,
            promptHeadline: currentComm?.detailTitle,
            promptQuestion: currentComm?.detailPrompt,
            userResponse: trimmed,
            capturedMemoryId: savedMemoryId,
          }),
        }).catch((err) => console.warn('[Today Card] Interaction provenance error:', err));
      });

      setSaveSuccess('Saved to Ezzy');
      setResponseText('');
      setTimeout(() => {
        setIsDetailOpen(false);
        setSaveSuccess(null);
      }, 1100);

      await fetchTodayState();
    } catch (err) {
      console.error('[Today Card] Error saving response:', err);
    } finally {
      setIsSavingResponse(false);
    }
  };

  if (isLoading && communications.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-white border border-emerald-200/60 rounded-xl text-xs text-zinc-400">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[10px] font-semibold text-emerald-800 uppercase tracking-wide">
          TODAY
        </span>
        <span className="text-zinc-300">·</span>
        <span className="text-zinc-400 italic">Checking today...</span>
      </div>
    );
  }

  if (!currentComm) {
    return null;
  }

  return (
    <div id="today-engine-container" className="space-y-2">
      {/* CANONICAL TODAY TICKER BAR */}
      <div
        id="today-ticker-bar"
        role="button"
        tabIndex={0}
        onClick={handleTickerTap}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleTickerTap();
          }
        }}
        title="Tap to respond or view details"
        className="group relative flex items-center justify-between gap-2 px-3 py-1.5 bg-white hover:bg-emerald-50/40 border border-emerald-200/90 rounded-xl shadow-2xs text-xs cursor-pointer transition-all duration-300 select-none animate-in fade-in"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden transition-opacity duration-300 motion-reduce:transition-none">
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-emerald-900 text-emerald-300 shrink-0 text-[9px] font-bold">
            ●
          </span>

          <span className="text-[10px] sm:text-[11px] font-semibold text-emerald-800 uppercase tracking-wide shrink-0">
            TODAY
          </span>

          <span className="text-zinc-300 shrink-0">·</span>

          <ScrollingTickerText text={currentComm.tickerText} />
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {communications.length > 1 && (
            <span className="text-[10px] text-zinc-400 font-mono">
              {communicationIndex + 1}/{communications.length}
            </span>
          )}
        </div>
      </div>

      {/* DROPDOWN / DETAIL TRAY */}
      {isDetailOpen && (
        <div
          ref={detailTrayRef}
          id="today-detail-tray"
          className="bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-xl p-3 space-y-2.5 shadow-sm animate-in fade-in"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-lg bg-emerald-950 text-emerald-400 shrink-0 mt-0.5 border border-emerald-800/60">
                <Sparkles className="w-3 h-3 text-emerald-400" />
              </span>
              <div>
                <div className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">
                  {currentComm.isRestrained ? 'Restraint' : 'Today'}
                </div>
                <div className="text-xs sm:text-sm font-medium text-zinc-100 mt-0.5 leading-snug">
                  {currentComm.detailPrompt}
                </div>
              </div>
            </div>

            <button
              id="close-today-detail-btn"
              type="button"
              onClick={() => setIsDetailOpen(false)}
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
              title="Close tray"
              aria-label="Close tray"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {currentComm.isRestrained ? (
            <div className="text-xs text-zinc-400 bg-zinc-800/60 rounded-lg p-2.5 border border-zinc-700/60">
              Ezzymigo evaluated your personal world and chose restraint. Outstanding tasks remain safely stored without being repeated every morning.
            </div>
          ) : null}

          {saveSuccess ? (
            <div
              id="today-save-success"
              className="flex items-center gap-2 py-2 px-3 bg-emerald-950/60 border border-emerald-700/50 rounded-lg text-emerald-300 text-xs font-medium animate-in fade-in"
            >
              <Check className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{saveSuccess}</span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="relative flex items-center bg-zinc-800/90 border border-zinc-700 rounded-lg focus-within:border-emerald-400/80 focus-within:ring-1 focus-within:ring-emerald-400/40 transition-all">
                <input
                  ref={detailInputRef}
                  id="today-response-input"
                  type="text"
                  value={responseText}
                  onChange={(e) => setResponseText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSaveResponse();
                    }
                  }}
                  disabled={isSavingResponse}
                  placeholder={currentComm.placeholder}
                  className="w-full bg-transparent px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-400 focus:outline-none disabled:opacity-50"
                />
                <div className="flex items-center gap-1 pr-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={toggleListening}
                    disabled={isSavingResponse}
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
                    id="save-today-response-btn"
                    type="button"
                    onClick={handleSaveResponse}
                    disabled={!responseText.trim() || isSavingResponse}
                    className="px-2.5 py-1 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-700 disabled:text-zinc-400 text-zinc-950 text-xs font-semibold rounded-md cursor-pointer transition-colors flex items-center gap-1"
                  >
                    {isSavingResponse ? (
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
                <p className="text-[10px] text-emerald-400/90 pl-1">{speechNotice}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

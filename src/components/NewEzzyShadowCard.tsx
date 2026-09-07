import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, Mic, MicOff, Send, Loader2, Check, X, FlaskConical, ChevronDown, ChevronUp } from 'lucide-react';
import { getUserPreferences } from '../utils/userPreferences';
import { useSpeechDictation } from '../utils/useSpeechDictation';

export type FeedbackVerdict =
  | 'OLD_BETTER'
  | 'NEW_BETTER'
  | 'BOTH_OK'
  | 'NEITHER'
  | 'USEFUL'
  | 'NOT_USEFUL';

export interface ShadowEvaluation {
  id: string;
  ezzy_id: string;
  timestamp: string;
  opportunity: string;
  trigger_name: string;
  old_ezzy_outcome: any;
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
  verdict: FeedbackVerdict | null;
  verdict_comment: string | null;
}

export interface CommunicationItem {
  id: string;
  evaluation: ShadowEvaluation;
  tickerText: string;
  detailTitle: string;
  detailPrompt: string;
  placeholder: string;
  isRestrained?: boolean;
  linkedEventId?: string;
  eventTitle?: string;
}

interface NewEzzyShadowCardProps {
  onSaveThought?: (
    text: string,
    context?: { linkedEventId?: string; eventTitle?: string; subject?: string; isCaptureFlow?: boolean }
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
// Helper to extract user-facing communication items from shadow evaluations
// -------------------------------------------------------------
function extractCommunications(
  todayEval: ShadowEvaluation | null,
  checkInEval: ShadowEvaluation | null,
  recentEvals: ShadowEvaluation[]
): CommunicationItem[] {
  const items: CommunicationItem[] = [];
  const seenTexts = new Set<string>();

  const allEvals = [todayEval, checkInEval, ...(recentEvals || [])].filter(
    (ev): ev is ShadowEvaluation => Boolean(ev && ev.new_ezzy_decision)
  );

  // Deduplicate evaluations by ID
  const uniqueEvals: ShadowEvaluation[] = [];
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

    // For TODAY_ORIENT opportunities
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

      // If there is also a distinct, informative question
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
      // For non-TODAY_ORIENT opportunities (POST_EVENT, PRE_EVENT, OCCASION, etc.)
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

  // Restrained state if no proactive communication is warranted
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
        old_ezzy_outcome: null,
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
        model_name: 'gemini-3.8-flash',
        latency_ms: 0,
        verdict: null,
        verdict_comment: null,
      } as any),
      tickerText: 'Nothing needs your attention right now.',
      detailTitle: 'New Ezzy · Restraint',
      detailPrompt: 'Nothing needs your attention right now.',
      placeholder: 'Anything you want Ezzy to remember or update?',
      isRestrained: true,
    });
  }

  return items;
}

// -------------------------------------------------------------
// NEW EZZY · TODAY 🧪 Ticker & Interaction Component
// -------------------------------------------------------------
export function NewEzzyShadowCard({ onSaveThought }: NewEzzyShadowCardProps) {
  const [todayEvaluation, setTodayEvaluation] = useState<ShadowEvaluation | null>(null);
  const [checkInEvaluation, setCheckInEvaluation] = useState<ShadowEvaluation | null>(null);
  const [recentEvaluations, setRecentEvaluations] = useState<ShadowEvaluation[]>([]);
  const [attentionReview, setAttentionReview] = useState<any>(null);
  const [isCuratingAttention, setIsCuratingAttention] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Cycling ticker state
  const [communicationIndex, setCommunicationIndex] = useState(0);

  // Detail Tray (dropdown on tap)
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [responseText, setResponseText] = useState('');
  const [isSavingResponse, setIsSavingResponse] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  // Inspect Modal / Drawer (collapsible comparison & verdicts)
  const [showInspect, setShowInspect] = useState(false);
  const [selectedVerdict, setSelectedVerdict] = useState<FeedbackVerdict | null>(null);
  const [commentText, setCommentText] = useState('');
  const [isSavingFeedback, setIsSavingFeedback] = useState(false);
  const [feedbackSavedNotice, setFeedbackSavedNotice] = useState(false);
  const [isReEvaluating, setIsReEvaluating] = useState(false);

  const detailInputRef = useRef<HTMLInputElement>(null);
  const detailTrayRef = useRef<HTMLDivElement>(null);
  const inspectTrayRef = useRef<HTMLDivElement>(null);
  const prefs = getUserPreferences();

  // Fetch shadow state
  const fetchShadowState = useCallback(async () => {
    try {
      const tz = prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';
      const now = new Date().toISOString();
      const res = await fetch(`/api/shadow/today?clientNow=${encodeURIComponent(now)}&clientTimeZone=${encodeURIComponent(tz)}`);
      if (res.ok) {
        const data = await res.json();
        const todayEval = data.todayEvaluation || data.evaluation || null;
        const checkInEval = data.checkInEvaluation || null;
        const recents = data.recentEvaluations || [];

        setTodayEvaluation(todayEval);
        setCheckInEvaluation(checkInEval);
        setRecentEvaluations(recents);
        setAttentionReview(data.attentionReview || null);

        // Pre-fill verdict if inspecting
        const activeEval = checkInEval || todayEval;
        if (activeEval?.verdict) {
          setSelectedVerdict(activeEval.verdict);
        }
        if (activeEval?.verdict_comment) {
          setCommentText(activeEval.verdict_comment);
        }
      }
    } catch (err) {
      console.warn('[New Ezzy Shadow] Error fetching shadow state:', err);
    } finally {
      setIsLoading(false);
    }
  }, [prefs.timezone]);

  useEffect(() => {
    fetchShadowState();
  }, [fetchShadowState]);

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
              old_ezzy_outcome: null,
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
              verdict: null,
              verdict_comment: null,
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
              old_ezzy_outcome: null,
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
              verdict: null,
              verdict_comment: null,
            } as any),
            tickerText: 'Ezzymigo is quietly holding your context.',
            detailTitle: 'Quiet Context',
            detailPrompt: attentionReview.overall_rationale || 'No proactive alerts needed right now.',
            placeholder: 'Add anything on your mind...',
            isRestrained: true,
          },
        ];
      }
    }
    return extractCommunications(todayEvaluation, checkInEvaluation, recentEvaluations);
  }, [attentionReview, todayEvaluation, checkInEvaluation, recentEvaluations]);

  // Bound index safely
  const currentComm = communications[communicationIndex] || communications[0];

  // Cycling logic matching Old Ezzy
  useEffect(() => {
    if (communications.length <= 1 || isDetailOpen || showInspect) return;

    const currentText = currentComm?.tickerText || '';
    const intervalMs = Math.max(5000, Math.min(9500, 3500 + currentText.length * 60));

    const timer = setTimeout(() => {
      setCommunicationIndex((prev) => (prev + 1) % communications.length);
    }, intervalMs);

    return () => clearTimeout(timer);
  }, [communications, communicationIndex, currentComm, isDetailOpen, showInspect]);

  // Speech dictation for detail tray
  const handleAppendSpeech = useCallback((phrase: string) => {
    setResponseText((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed} ${phrase}` : phrase;
    });
  }, []);

  const { isListening, speechNotice, toggleListening, stopListening } = useSpeechDictation({
    onAppendText: handleAppendSpeech,
    language: prefs.language,
  });

  // Focus input when detail opens
  useEffect(() => {
    if (isDetailOpen && !currentComm?.isRestrained) {
      setTimeout(() => {
        detailInputRef.current?.focus();
      }, 80);
    }
  }, [isDetailOpen, currentComm?.isRestrained]);

  // Ticker tap handler: Opens dropdown/detail view
  const handleTickerTap = () => {
    setIsDetailOpen((prev) => !prev);
    setShowInspect(false);
    setSaveSuccess(null);
  };

  // Inspect toggle
  const handleInspectToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowInspect((prev) => !prev);
    setIsDetailOpen(false);
  };

  // Save response through authoritative production capture pipeline
  const handleSaveResponse = async () => {
    const trimmed = responseText.trim();
    if (!trimmed || isSavingResponse) return;

    setIsSavingResponse(true);
    try {
      let savedMemoryId: string | null = null;
      if (onSaveThought) {
        const savedData = await onSaveThought(trimmed, {
          linkedEventId: currentComm?.linkedEventId,
          eventTitle: currentComm?.eventTitle || currentComm?.detailTitle,
          isCaptureFlow: true,
        });
        savedMemoryId = savedData?.memory?.id || savedData?.memories?.[0]?.id || savedData?.id || null;
      } else {
        // Direct POST to /api/memories if onSaveThought was not passed
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
          }),
        });
        const resJson = await res.json().catch(() => ({}));
        savedMemoryId = resJson?.memory?.id || resJson?.memories?.[0]?.id || resJson?.id || null;
      }

      // Record authoritative interaction provenance linking communication -> response -> memory
      await fetch('/api/shadow/interactions', {
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
      }).catch((err) => console.warn('[New Ezzy Ticker] Interaction provenance error:', err));

      setSaveSuccess('Saved to Ezzy');
      setResponseText('');
      setTimeout(() => {
        setIsDetailOpen(false);
        setSaveSuccess(null);
      }, 1100);

      // Immediately refresh shadow state to show updated Attention Channel
      await fetchShadowState();
    } catch (err) {
      console.error('[New Ezzy Ticker] Error saving response:', err);
    } finally {
      setIsSavingResponse(false);
    }
  };

  // Save verdict/feedback for evaluation
  const handleSaveVerdict = async (verdictChoice: FeedbackVerdict) => {
    setSelectedVerdict(verdictChoice);
    const targetEval = currentComm?.evaluation || checkInEvaluation || todayEvaluation;
    if (!targetEval?.id) return;

    try {
      await fetch('/api/shadow/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evaluationId: targetEval.id,
          verdict: verdictChoice,
          verdictComment: commentText.trim() || undefined,
        }),
      });
      setFeedbackSavedNotice(true);
      setTimeout(() => setFeedbackSavedNotice(false), 2500);
    } catch (err) {
      console.error('[New Ezzy Ticker] Error saving verdict:', err);
    }
  };

  // Trigger manual shadow re-evaluation
  const handleTriggerReEvaluation = async () => {
    setIsReEvaluating(true);
    try {
      const tz = prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';
      await fetch('/api/shadow/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunity: 'TODAY_ORIENT',
          trigger: 'manual_shadow_inspect',
          clientNow: new Date().toISOString(),
          clientTimeZone: tz,
        }),
      });
      await fetchShadowState();
    } catch (err) {
      console.warn('[New Ezzy Ticker] Re-evaluation error:', err);
    } finally {
      setIsReEvaluating(false);
    }
  };

  // Trigger manual attention review
  const handleTriggerAttentionReview = async () => {
    if (isCuratingAttention) return;
    setIsCuratingAttention(true);
    try {
      const tz = prefs.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';
      const now = new Date().toISOString();
      const res = await fetch('/api/shadow/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'manual_inspect_refresh',
          clientNow: now,
          clientTimeZone: tz,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.review) {
          setAttentionReview(data.review);
        }
      }
    } catch (err) {
      console.warn('[New Ezzy Ticker] Attention Review error:', err);
    } finally {
      setIsCuratingAttention(false);
    }
  };

  if (isLoading && communications.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-white border border-emerald-200/60 rounded-xl text-xs text-zinc-400">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[10px] font-semibold text-emerald-800 uppercase tracking-wide">
          NEW EZZY · TODAY 🧪
        </span>
        <span className="text-zinc-300">·</span>
        <span className="text-zinc-400 italic">Thinking...</span>
      </div>
    );
  }

  if (!currentComm) {
    return null;
  }

  const activeEvaluation = currentComm.evaluation;

  return (
    <div id="new-ezzy-engine-container" className="space-y-2">
      {/* COMPACT TICKER BAR: NEW EZZY · TODAY 🧪 */}
      <div
        id="new-ezzy-ticker-bar"
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
          {/* Dot indicator */}
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-emerald-900 text-emerald-300 shrink-0 text-[9px] font-bold">
            ●
          </span>

          {/* Contextual indicator: NEW EZZY · TODAY 🧪 */}
          <span className="text-[10px] sm:text-[11px] font-semibold text-emerald-800 uppercase tracking-wide shrink-0">
            NEW EZZY · TODAY 🧪
          </span>

          <span className="text-zinc-300 shrink-0">·</span>

          {/* Cycling text with marquee scrolling */}
          <ScrollingTickerText text={currentComm.tickerText} />
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Multi-communication counter (e.g. 1/2) */}
          {communications.length > 1 && (
            <span className="text-[10px] text-zinc-400 font-mono">
              {communicationIndex + 1}/{communications.length}
            </span>
          )}

          {/* Small Experimental Inspect Toggle */}
          <button
            type="button"
            id="new-ezzy-inspect-toggle-btn"
            onClick={handleInspectToggle}
            className={`px-1.5 py-0.5 text-[10px] font-medium rounded border transition-colors cursor-pointer flex items-center gap-1 ${
              showInspect
                ? 'bg-emerald-800 text-white border-emerald-800'
                : 'bg-emerald-50/80 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
            }`}
            title="Inspect shadow evaluation, rationale and verdicts"
          >
            <FlaskConical className="w-3 h-3" />
            <span>Inspect</span>
          </button>
        </div>
      </div>

      {/* DROPDOWN / DETAIL TRAY (Preserved tap interaction pattern) */}
      {isDetailOpen && (
        <div
          ref={detailTrayRef}
          id="new-ezzy-detail-tray"
          className="bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-xl p-3 space-y-2.5 shadow-sm animate-in fade-in"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-lg bg-emerald-950 text-emerald-400 shrink-0 mt-0.5 border border-emerald-800/60">
                <Sparkles className="w-3 h-3 text-emerald-400" />
              </span>
              <div>
                <div className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">
                  {currentComm.isRestrained ? 'New Ezzy · Restraint' : 'New Ezzy · Today'}
                </div>
                <div className="text-xs sm:text-sm font-medium text-zinc-100 mt-0.5 leading-snug">
                  {currentComm.detailPrompt}
                </div>
              </div>
            </div>

            <button
              id="close-new-ezzy-detail-btn"
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
              New Ezzy evaluated your personal world and chose restraint. Outstanding tasks remain safely stored without being repeated every morning.
            </div>
          ) : null}

          {saveSuccess ? (
            <div
              id="new-ezzy-save-success"
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
                  id="new-ezzy-response-input"
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
                    id="save-new-ezzy-response-btn"
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

      {/* INSPECT TRAY (Evaluation, Rationale, and Comparative Verdicts) */}
      {showInspect && activeEvaluation && (
        <div
          ref={inspectTrayRef}
          id="new-ezzy-inspect-tray"
          className="bg-white border border-emerald-200 rounded-xl p-3.5 space-y-3 shadow-sm text-xs text-zinc-800 animate-in fade-in"
        >
          <div className="flex items-center justify-between gap-2 border-b border-zinc-100 pb-2">
            <div className="flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-emerald-600" />
              <span className="font-semibold text-zinc-900">Shadow Reasoning Inspection</span>
              <span className="text-[10px] px-1.5 py-0.5 bg-emerald-50 text-emerald-700 font-mono rounded border border-emerald-200">
                {activeEvaluation.model_name || 'gemini-3.8-flash'}
              </span>
              <span className="text-[10px] text-zinc-400 font-mono">
                {activeEvaluation.latency_ms ? `${activeEvaluation.latency_ms}ms` : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleTriggerReEvaluation}
                disabled={isReEvaluating}
                className="text-[11px] text-emerald-700 hover:text-emerald-900 flex items-center gap-1 cursor-pointer font-medium disabled:opacity-50"
                title="Run new reasoning pass"
              >
                <Loader2 className={`w-3 h-3 ${isReEvaluating ? 'animate-spin' : 'hidden'}`} />
                <span>Re-evaluate</span>
              </button>
              <button
                type="button"
                onClick={() => setShowInspect(false)}
                className="p-1 rounded text-zinc-400 hover:text-zinc-700 cursor-pointer"
                title="Close inspect panel"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Rationale */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase font-semibold text-zinc-400 tracking-wider">
              Reasoning Rationale
            </div>
            <p className="text-xs text-zinc-700 bg-zinc-50 border border-zinc-200/70 rounded-lg p-2.5 leading-relaxed font-sans">
              {activeEvaluation.new_ezzy_rationale || 'No rationale available'}
            </p>
          </div>

          {/* Comparison */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            <div className="p-2 bg-zinc-50 border border-zinc-200 rounded-lg space-y-0.5">
              <div className="text-[10px] font-semibold text-zinc-400 uppercase">Old Ezzy Production</div>
              <div className="text-xs font-medium text-zinc-800">
                {activeEvaluation.old_ezzy_outcome?.topCandidate?.display_text || 'No candidates'}
              </div>
            </div>
            <div className="p-2 bg-emerald-50/60 border border-emerald-200 rounded-lg space-y-0.5">
              <div className="text-[10px] font-semibold text-emerald-700 uppercase">New Ezzy Unified Loop</div>
              <div className="text-xs font-medium text-emerald-950">
                {activeEvaluation.new_ezzy_decision?.communication?.headline ||
                  activeEvaluation.new_ezzy_decision?.communication?.question ||
                  'Restrained (Silent)'}
              </div>
            </div>
          </div>

          {/* Verdict Feedback Buttons */}
          <div className="space-y-1.5 pt-1 border-t border-zinc-100">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold text-zinc-600">Old vs New Evaluation Verdict:</span>
              {feedbackSavedNotice && (
                <span className="text-emerald-600 font-semibold text-[10px] animate-in fade-in">
                  Verdict saved!
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {(['OLD_BETTER', 'NEW_BETTER', 'BOTH_OK', 'NEITHER'] as FeedbackVerdict[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => handleSaveVerdict(v)}
                  className={`px-2 py-1.5 rounded-lg border text-xs font-medium text-center transition-colors cursor-pointer ${
                    selectedVerdict === v
                      ? 'bg-emerald-600 border-emerald-700 text-white font-semibold shadow-2xs'
                      : 'bg-white hover:bg-zinc-50 border-zinc-200 text-zinc-700'
                  }`}
                >
                  {v.replace('_', ' ')}
                </button>
              ))}
            </div>

            {/* Optional Comment */}
            <div className="flex items-center gap-1.5 pt-1">
              <input
                type="text"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Optional notes or why one was better..."
                className="flex-1 px-2.5 py-1.5 text-xs bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:border-emerald-500"
              />
              <button
                type="button"
                onClick={() => selectedVerdict && handleSaveVerdict(selectedVerdict)}
                disabled={!selectedVerdict || isSavingFeedback}
                className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-900 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>

          {/* UNIFIED ATTENTION REVIEW (EXECUTIVE LAYER) */}
          <div className="space-y-2 pt-2 border-t border-zinc-200/80">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-[11px] font-semibold text-zinc-900">Unified Attention Review</span>
                {attentionReview?.model_name && (
                  <span className="text-[9px] px-1.5 py-0.5 bg-zinc-100 text-zinc-600 font-mono rounded border border-zinc-200">
                    {attentionReview.model_name}
                  </span>
                )}
                {attentionReview?.latency_ms && (
                  <span className="text-[9px] text-zinc-400 font-mono">
                    {attentionReview.latency_ms}ms
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={handleTriggerAttentionReview}
                disabled={isCuratingAttention}
                className="text-[10px] text-emerald-700 hover:text-emerald-900 flex items-center gap-1 cursor-pointer font-medium disabled:opacity-50"
                title="Run new attention review pass"
              >
                <Loader2 className={`w-3 h-3 ${isCuratingAttention ? 'animate-spin' : 'hidden'}`} />
                <span>Re-curate</span>
              </button>
            </div>

            {attentionReview ? (
              <div className="space-y-2">
                {/* Executive Rationale */}
                <div className="text-[11px] text-zinc-700 bg-emerald-50/50 border border-emerald-200/60 rounded-lg p-2 leading-relaxed">
                  <span className="font-semibold text-emerald-900 block mb-0.5">Executive Curation Rationale:</span>
                  {attentionReview.overall_rationale}
                </div>

                {/* Candidate Resolutions List */}
                {attentionReview.candidate_resolutions && attentionReview.candidate_resolutions.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                      Candidate Resolutions ({attentionReview.candidate_resolutions.length})
                    </div>
                    <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                      {attentionReview.candidate_resolutions.map((res: any, idx: number) => {
                        const statusColors: Record<string, string> = {
                          ACTIVE: 'bg-emerald-100 text-emerald-800 border-emerald-200',
                          SATISFIED: 'bg-blue-100 text-blue-800 border-blue-200',
                          SUPERSEDED: 'bg-zinc-100 text-zinc-700 border-zinc-200',
                          STALE: 'bg-amber-100 text-amber-800 border-amber-200',
                          RESTRAINED: 'bg-purple-100 text-purple-800 border-purple-200',
                          DISMISSED: 'bg-rose-100 text-rose-800 border-rose-200',
                        };
                        const badgeClass = statusColors[res.status] || 'bg-zinc-100 text-zinc-700 border-zinc-200';
                        return (
                          <div
                            key={res.candidateId || idx}
                            className="p-1.5 bg-zinc-50 border border-zinc-200/80 rounded-md text-[11px] flex items-start gap-1.5"
                          >
                            <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded border shrink-0 ${badgeClass}`}>
                              {res.status}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-zinc-700 leading-snug">{res.reason}</div>
                              {res.satisfiedByInteractionId && (
                                <div className="text-[9px] text-blue-600 font-mono mt-0.5">
                                  Satisfied by interaction: {res.satisfiedByInteractionId}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[11px] text-zinc-400 italic">
                No attention review recorded yet. Tap Re-curate to run executive curation.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Named alias
export const NewEzzyTicker = NewEzzyShadowCard;

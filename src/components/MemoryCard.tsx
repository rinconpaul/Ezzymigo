import React, { useState } from 'react';
import { 
  CheckCircle2, 
  Circle, 
  Trash2, 
  Edit3, 
  Check, 
  X, 
  Loader2, 
  Tag, 
  Users, 
  MapPin, 
  Clock, 
  Code2, 
  ChevronDown, 
  ChevronUp, 
  FileText, 
  Sparkles, 
  Search, 
  ExternalLink, 
  AlertCircle,
  ShoppingBag,
  BookOpen,
  Store,
  ListFilter,
  List
} from 'lucide-react';
import { MemoryItem, LookupResult } from '../types';
import { formatDateTime, getUserPreferences } from '../utils/userPreferences';

interface MemoryCardProps {
  memory: MemoryItem;
  onToggleDone: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onEdit?: (id: string, newText: string) => Promise<void>;
}

export const MemoryCard: React.FC<MemoryCardProps> = ({
  memory,
  onToggleDone,
  onDelete,
  onEdit,
}) => {
  const [showJson, setShowJson] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Suggested action lookup state
  const [isLoadingLookup, setIsLoadingLookup] = useState(false);
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [showLookupBox, setShowLookupBox] = useState(false);
  const [isApplyingCorrection, setIsApplyingCorrection] = useState(false);

  const { originalText, isDone, createdAt, interpretation } = memory;
  const { content, kind, people = [], places = [], topics = [], resurfacing, suggested_action, subject } = interpretation || {};

  const handleToggle = async () => {
    setIsToggling(true);
    try {
      await onToggleDone(memory.id);
    } finally {
      setIsToggling(false);
    }
  };

  const handleDelete = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      await onDelete(memory.id);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleStartEdit = () => {
    setEditText(content || originalText || '');
    setEditError(null);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    const trimmed = editText.trim();
    if (!trimmed) {
      setEditError('Memory text cannot be empty.');
      return;
    }
    if (!onEdit) return;

    setIsSavingEdit(true);
    setEditError(null);
    try {
      await onEdit(memory.id, trimmed);
      setIsEditing(false);
    } catch (err: any) {
      console.error('Error saving memory edit:', err);
      setEditError(err?.message || 'Failed to re-interpret and save memory.');
    } finally {
      setIsSavingEdit(false);
    }
  };

  // Trigger contextual lookup
  const handleTriggerLookup = async () => {
    if (!suggested_action?.query && !content) return;
    
    // If already showing result for this query, just toggle display
    if (lookupResult && showLookupBox) {
      setShowLookupBox(false);
      return;
    }

    setIsLoadingLookup(true);
    setLookupError(null);
    setShowLookupBox(true);

    try {
      const prefs = getUserPreferences();
      const res = await fetch(`/api/memories/${memory.id}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: suggested_action?.query || content,
          memoryContent: content || originalText,
          clientRegion: prefs.region || 'AU',
          clientLanguage: prefs.language || 'en-AU',
        }),
      });

      if (!res.ok) {
        throw new Error(`Lookup failed (${res.status})`);
      }

      const data = await res.json();
      if (data.lookup) {
        setLookupResult(data.lookup);
      } else {
        throw new Error('No lookup details returned.');
      }
    } catch (err: any) {
      console.error('Error triggering lookup:', err);
      setLookupError(err?.message || 'Failed to complete web lookup.');
    } finally {
      setIsLoadingLookup(false);
    }
  };

  // Apply suggested correction
  const handleApplyCorrection = async (correctedText: string) => {
    if (!onEdit || !correctedText) return;
    setIsApplyingCorrection(true);
    try {
      await onEdit(memory.id, correctedText);
      setShowLookupBox(false);
      setLookupResult(null);
    } catch (err: any) {
      console.error('Error applying correction:', err);
      setLookupError(err?.message || 'Failed to apply memory correction.');
    } finally {
      setIsApplyingCorrection(false);
    }
  };

  const formattedDate = formatDateTime(createdAt, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      id={`memory-${memory.id}`}
      className={`rounded-xl border transition-all duration-150 p-4 sm:p-5 bg-white shadow-xs ${
        isDone ? 'border-zinc-200 bg-zinc-50/70 opacity-80' : 'border-zinc-300 hover:border-zinc-400'
      }`}
    >
      {/* Top row: Kind, Status, Date, Actions */}
      <div className="flex items-center justify-between gap-3 mb-3 pb-3 border-b border-zinc-100 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-md uppercase tracking-wider ${
            isDone 
              ? 'bg-zinc-200 text-zinc-700' 
              : 'bg-zinc-900 text-white'
          }`}>
            {kind || 'thought'}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded font-medium ${
            isDone ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'
          }`}>
            {isDone ? 'Done' : 'Active'}
          </span>
          <span className="text-xs text-zinc-600 font-mono">
            {formattedDate}
          </span>
          {subject && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-900 bg-indigo-50 border border-indigo-200/90 px-2 py-0.5 rounded-md">
              <List className="w-3 h-3 text-indigo-700" />
              <span>{subject}</span>
            </span>
          )}
        </div>

        {/* Action Buttons: Edit, Done & Delete */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {onEdit && (
            <button
              id={`edit-btn-${memory.id}`}
              type="button"
              onClick={isEditing ? handleCancelEdit : handleStartEdit}
              disabled={isDeleting || isToggling || isSavingEdit}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer disabled:opacity-50 ${
                isEditing
                  ? 'bg-zinc-200 text-zinc-900 border-zinc-300'
                  : 'text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100 border-zinc-200'
              }`}
              title={isEditing ? 'Cancel editing' : 'Edit memory text and re-interpret'}
            >
              <Edit3 className="w-3.5 h-3.5 text-zinc-600" />
              <span>{isEditing ? 'Cancel' : 'Edit'}</span>
            </button>
          )}

          <button
            id={`done-btn-${memory.id}`}
            type="button"
            onClick={handleToggle}
            disabled={isToggling || isSavingEdit}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer disabled:opacity-50 ${
              isDone
                ? 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700 border-zinc-300'
                : 'bg-emerald-600 hover:bg-emerald-700 text-white border-transparent'
            }`}
            title={isDone ? 'Mark as Active' : 'Mark as Done'}
          >
            {isDone ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>Mark Active</span>
              </>
            ) : (
              <>
                <Circle className="w-3.5 h-3.5" />
                <span>Done</span>
              </>
            )}
          </button>

          <button
            id={`delete-btn-${memory.id}`}
            type="button"
            onClick={handleDelete}
            disabled={isDeleting || isSavingEdit}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-rose-600 hover:text-rose-700 hover:bg-rose-50 border border-rose-200 transition-colors cursor-pointer disabled:opacity-50"
            title="Delete memory"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete</span>
          </button>
        </div>
      </div>

      {/* In-place Edit Form if isEditing is true */}
      {isEditing ? (
        <div className="space-y-3 p-3.5 bg-zinc-50 border border-zinc-300 rounded-xl mb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
              <Edit3 className="w-3.5 h-3.5 text-zinc-700" />
              <span>Edit Memory Content</span>
            </div>
            <span className="text-[11px] text-zinc-500 flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-amber-600" />
              <span>Will re-run interpretation & tagging</span>
            </span>
          </div>

          <textarea
            id={`edit-textarea-${memory.id}`}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            disabled={isSavingEdit}
            rows={3}
            className="w-full p-2.5 bg-white border border-zinc-300 rounded-lg text-xs sm:text-sm text-zinc-900 font-medium leading-relaxed focus:outline-hidden focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 disabled:opacity-50"
            placeholder="Edit memory content..."
            autoFocus
          />

          {editError && (
            <p className="text-xs text-rose-600 font-medium">{editError}</p>
          )}

          <div className="flex items-center justify-between gap-2 pt-1 flex-wrap">
            <p className="text-[11px] text-zinc-500 italic">
              Original captured text will be preserved in provenance.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCancelEdit}
                disabled={isSavingEdit}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-700 hover:text-zinc-900 bg-white border border-zinc-200 hover:bg-zinc-100 transition-colors cursor-pointer disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" />
                <span>Cancel</span>
              </button>
              <button
                id={`save-edit-btn-${memory.id}`}
                type="button"
                onClick={handleSaveEdit}
                disabled={isSavingEdit || !editText.trim()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-zinc-900 hover:bg-zinc-800 transition-colors cursor-pointer shadow-xs disabled:opacity-50"
              >
                {isSavingEdit ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Re-interpreting…</span>
                  </>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>Save & Re-interpret</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Main Content: Distilled Interpretation & Original Text */}
      <div className="space-y-3">
        <div>
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">
            Interpreted Content
          </div>
          <p className={`text-sm sm:text-base font-medium leading-relaxed ${isDone ? 'text-zinc-500 line-through' : 'text-zinc-900'}`}>
            {content || originalText}
          </p>
        </div>

        {/* Prerequisite / Dependency Banner */}
        {interpretation.prerequisite && interpretation.prerequisite.condition && (
          <div className="p-3 bg-amber-50/90 border border-amber-200/90 rounded-lg text-xs space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-amber-950 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                <span>Prerequisite Dependency</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider bg-amber-200/90 text-amber-900 border border-amber-300">
                {interpretation.prerequisite.status || 'pending'}
              </span>
            </div>
            <p className="text-amber-900 font-medium leading-relaxed pl-5">
              {interpretation.prerequisite.condition}
              {interpretation.prerequisite.expected_time_expression && (
                <span className="ml-1.5 text-amber-800 font-normal italic">
                  (Expected: {interpretation.prerequisite.expected_time_expression})
                </span>
              )}
            </p>
          </div>
        )}

        {/* Structured Items List if Collection/List */}
        {Array.isArray(interpretation.items) && interpretation.items.length > 0 && (
          <div className="p-3 bg-zinc-50 border border-zinc-200 rounded-lg space-y-1.5">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
              <ListFilter className="w-3.5 h-3.5 text-zinc-600" />
              <span>Items ({interpretation.items.length})</span>
            </div>
            <ul className="space-y-1 text-xs text-zinc-800 font-medium pl-1">
              {interpretation.items.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-zinc-400 select-none">•</span>
                  <span className="leading-snug">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Suggested Action Bar (User-Triggered Contextual Lookup) */}
        {suggested_action && (
          <div className="pt-1">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                id={`action-btn-${memory.id}`}
                type="button"
                onClick={handleTriggerLookup}
                disabled={isLoadingLookup}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-50 text-sky-800 hover:bg-sky-100 border border-sky-200 transition-colors cursor-pointer shadow-2xs"
                title={`Look up online: ${suggested_action.query}`}
              >
                {isLoadingLookup ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-600" />
                ) : (
                  <Search className="w-3.5 h-3.5 text-sky-600" />
                )}
                <span>{isLoadingLookup ? 'Looking up…' : suggested_action.label}</span>
                {lookupResult && (
                  <span className="text-[10px] bg-sky-200/80 text-sky-900 px-1.5 py-0.2 rounded font-mono ml-1">
                    {showLookupBox ? 'Hide' : 'View'}
                  </span>
                )}
              </button>
            </div>

            {/* Collapsible Lookup Results Tray */}
            {showLookupBox && (
              <div className="mt-2.5 p-3.5 sm:p-4 bg-sky-50/70 border border-sky-200 rounded-xl space-y-3 text-xs text-sky-950 shadow-xs">
                {/* Tray Header */}
                <div className="flex items-center justify-between gap-2 border-b border-sky-200/80 pb-2.5">
                  <div className="flex items-center gap-1.5 font-semibold text-sky-900">
                    <Search className="w-3.5 h-3.5 text-sky-700" />
                    <span>Lookup: &ldquo;{suggested_action.query}&rdquo;</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowLookupBox(false)}
                    className="text-sky-700 hover:text-sky-950 p-1 rounded hover:bg-sky-100 transition-colors cursor-pointer"
                    title="Close lookup findings"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                {isLoadingLookup && (
                  <div className="flex items-center gap-2 text-sky-800 py-2 font-medium">
                    <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
                    <span>Searching Google for verified purchase & destination details…</span>
                  </div>
                )}

                {lookupError && (
                  <p className="text-rose-600 font-medium bg-rose-50 p-2.5 rounded-lg border border-rose-200">
                    {lookupError}
                  </p>
                )}

                {lookupResult && (
                  <div className="space-y-3">
                    {/* Item & Creator Attribution Banner */}
                    {(lookupResult.item_title || lookupResult.creator) && (
                      <div className="p-3 bg-white border border-sky-200/90 rounded-lg shadow-2xs">
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-0.5">
                            {lookupResult.item_title && (
                              <h4 className="font-bold text-zinc-900 text-sm leading-snug">
                                {lookupResult.item_title}
                              </h4>
                            )}
                            {lookupResult.creator && (
                              <p className="text-xs font-semibold text-sky-900 flex items-center gap-1">
                                <span>By {lookupResult.creator}</span>
                              </p>
                            )}
                          </div>
                          {lookupResult.category && (
                            <span className="shrink-0 px-2 py-0.5 bg-sky-100 text-sky-800 rounded font-medium text-[11px] capitalize">
                              {lookupResult.category}
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Explanatory Summary */}
                    {lookupResult.summary && (
                      <div className="text-zinc-700 leading-relaxed font-normal bg-white/60 p-2.5 rounded-lg border border-sky-100">
                        {lookupResult.summary}
                      </div>
                    )}

                    {/* Actionable Destination / Purchase Results */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span className="text-xs font-bold text-zinc-800 flex items-center gap-1.5">
                          <ShoppingBag className="w-3.5 h-3.5 text-sky-700" />
                          <span>Direct Links & Retailers</span>
                        </span>
                        <span className="text-[11px] text-zinc-500 font-medium">
                          Verified via Google Search
                        </span>
                      </div>

                      {lookupResult.actionable_results && lookupResult.actionable_results.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {lookupResult.actionable_results.map((res, idx) => {
                            const isClickable = Boolean(res.url && res.url.startsWith('http'));
                            return (
                              <div
                                key={idx}
                                className="p-2.5 bg-white border border-sky-200 rounded-lg shadow-2xs flex flex-col justify-between gap-2 hover:border-sky-300 transition-colors"
                              >
                                <div className="space-y-1">
                                  <div className="flex items-start justify-between gap-1.5">
                                    <span className="font-bold text-zinc-900 text-xs flex items-center gap-1 truncate">
                                      <Store className="w-3 h-3 text-sky-600 shrink-0" />
                                      <span className="truncate">{res.source_name}</span>
                                    </span>
                                    {res.price && (
                                      <span className="shrink-0 px-1.5 py-0.5 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded text-[10px] font-semibold font-mono">
                                        {res.price}
                                      </span>
                                    )}
                                  </div>

                                  <p className="text-[11px] text-zinc-600 line-clamp-2 leading-tight">
                                    {res.title}
                                  </p>

                                  {res.availability && (
                                    <p className="text-[10px] text-zinc-500 font-medium">
                                      Status: <span className="text-zinc-700">{res.availability}</span>
                                    </p>
                                  )}
                                </div>

                                {isClickable ? (
                                  <a
                                    id={`lookup-link-${memory.id}-${idx}`}
                                    href={res.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center justify-center gap-1.5 w-full py-1.5 px-2 bg-sky-600 hover:bg-sky-700 text-white font-semibold rounded-md text-xs transition-colors cursor-pointer shadow-2xs"
                                  >
                                    <span>Open on {res.source_name}</span>
                                    <ExternalLink className="w-3 h-3 opacity-90" />
                                  </a>
                                ) : (
                                  <span className="text-[10px] text-zinc-400 italic text-center py-1">
                                    Link not provided in search grounding
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-zinc-600 italic bg-white/60 p-2.5 rounded-lg border border-sky-100 text-xs">
                          No direct purchase or product destination links were returned by Google Search grounding for this item.
                        </p>
                      )}
                    </div>

                    {/* Additional Grounding Sources */}
                    {lookupResult.sources && lookupResult.sources.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-sky-200/60">
                        <span className="text-[11px] font-semibold text-zinc-500">Sources:</span>
                        {lookupResult.sources.map((src, idx) => (
                          <a
                            key={idx}
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-sky-200 rounded-md text-[11px] text-sky-700 hover:text-sky-900 hover:bg-sky-50 transition-colors font-medium"
                          >
                            <span className="truncate max-w-[130px]">{src.title}</span>
                            <ExternalLink className="w-2.5 h-2.5 opacity-70" />
                          </a>
                        ))}
                      </div>
                    )}

                    {/* Correction Offer (Explicit Confirmation Required) */}
                    {lookupResult.correction && lookupResult.correction.full_corrected_text && (
                      <div className="mt-2.5 p-3 bg-amber-50 border border-amber-300/80 rounded-lg space-y-2">
                        <div className="flex items-start gap-2 text-amber-900">
                          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                          <div>
                            <p className="font-semibold text-xs">
                              {lookupResult.correction.explanation || 'Verified entity discrepancy detected.'}
                            </p>
                            <p className="text-[11px] text-amber-800 mt-0.5">
                              Update stored memory to: <span className="font-medium italic text-zinc-900">&ldquo;{lookupResult.correction.full_corrected_text}&rdquo;</span>?
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 pt-1">
                          <button
                            id={`apply-correction-btn-${memory.id}`}
                            type="button"
                            onClick={() => handleApplyCorrection(lookupResult.correction!.full_corrected_text)}
                            disabled={isApplyingCorrection}
                            className="inline-flex items-center gap-1 px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-md text-xs font-semibold transition-colors cursor-pointer shadow-2xs disabled:opacity-50"
                          >
                            {isApplyingCorrection ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                <span>Updating…</span>
                              </>
                            ) : (
                              <>
                                <Check className="w-3 h-3" />
                                <span>Update Memory</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Original Text Section (Provenance) */}
        <div className="bg-zinc-50 rounded-lg p-3 border border-zinc-200">
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 mb-1">
            <FileText className="w-3.5 h-3.5" />
            <span>Original Stored Thought</span>
          </div>
          <p className="text-xs text-zinc-700 italic leading-normal">
            &ldquo;{originalText}&rdquo;
          </p>
        </div>

        {/* Structured Tags / Metadata Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 text-xs">
          {/* Resurfacing Timing & Mode */}
          {resurfacing && (resurfacing.mode || resurfacing.timing) && (
            <div className="flex items-start gap-2 bg-blue-50/70 border border-blue-200/70 rounded-lg p-2.5">
              <Clock className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-blue-900">Resurfacing</div>
                <div className="text-blue-800 font-medium">
                  {resurfacing.timing || 'Unspecified'}
                  {resurfacing.mode && resurfacing.mode !== 'none' && (
                    <span className="ml-1 text-[11px] text-blue-700 opacity-80">
                      ({resurfacing.mode.replace('_', ' ')})
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* People & Places */}
          <div className="space-y-2">
            {people && people.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <Users className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="font-medium text-zinc-600">People:</span>
                {people.map((person, idx) => (
                  <span key={idx} className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded text-[11px] font-medium">
                    {person}
                  </span>
                ))}
              </div>
            )}

            {places && places.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <MapPin className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="font-medium text-zinc-600">Places:</span>
                {places.map((place, idx) => (
                  <span key={idx} className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-[11px] font-medium">
                    {place}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Topics */}
        {topics && topics.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            <Tag className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            <span className="text-xs font-medium text-zinc-600">Topics:</span>
            {topics.map((topic, idx) => (
              <span key={idx} className="bg-zinc-100 text-zinc-700 border border-zinc-200 px-2 py-0.5 rounded-full text-[11px] font-medium">
                #{topic}
              </span>
            ))}
          </div>
        )}

        {/* JSON Viewer Toggle */}
        <div className="pt-2 border-t border-zinc-100">
          <button
            type="button"
            onClick={() => setShowJson(!showJson)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 transition-colors cursor-pointer"
          >
            <Code2 className="w-3 h-3" />
            <span>{showJson ? 'Hide Structured JSON' : 'View Structured JSON'}</span>
            {showJson ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>

          {showJson && (
            <div className="mt-2 p-3 bg-zinc-900 text-zinc-100 rounded-lg text-xs font-mono overflow-x-auto">
              <pre>{JSON.stringify({ ...interpretation, originalText, id: memory.id, isDone }, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

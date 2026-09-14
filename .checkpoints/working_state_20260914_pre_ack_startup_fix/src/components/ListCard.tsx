import React, { useState } from 'react';
import {
  List,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Circle,
  Edit3,
  Check,
  X,
  Loader2,
  FileText,
  Clock,
  Users,
  MapPin,
  Tag,
  Code2,
  AlertCircle,
  Share2,
  Copy,
} from 'lucide-react';
import { MemoryItem } from '../types';
import { formatDateTime } from '../utils/userPreferences';

interface ListCardProps {
  subject: string;
  memories: MemoryItem[];
  onToggleDone: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onEdit?: (id: string, newText: string) => Promise<void>;
  onAddItem: (subject: string) => void;
  onDeleteList: (subject: string) => Promise<void>;
}

export const ListCard: React.FC<ListCardProps> = ({
  subject,
  memories,
  onToggleDone,
  onDelete,
  onEdit,
  onAddItem,
  onDeleteList,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(new Set());
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isDeletingList, setIsDeletingList] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [togglingItemId, setTogglingItemId] = useState<string | null>(null);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const [jsonViewerId, setJsonViewerId] = useState<string | null>(null);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);

  // Capture order: oldest to newest for a natural list experience
  const sortedMemories = React.useMemo(() => {
    return [...memories].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [memories]);

  const activeCount = memories.filter((m) => !m.isDone).length;
  const doneCount = memories.filter((m) => m.isDone).length;
  const allDone = memories.length > 0 && activeCount === 0;

  // Build clean plain-text list representation (faithfully as stored/displayed)
  const buildShareText = () => {
    const itemLines = sortedMemories.map((m) => {
      const text = m.interpretation?.content || m.originalText || '';
      return text.trim();
    }).filter(Boolean);

    return `${subject.trim()}\n\n${itemLines.join('\n')}`;
  };

  const handleShareList = async () => {
    const shareText = buildShareText();

    // Check if Web Share API is supported and usable
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({
          title: subject,
          text: shareText,
        });
        return;
      } catch (err: any) {
        // User aborted share sheet or unsupported platform error -> fall back to clipboard
        if (err?.name === 'AbortError') {
          return;
        }
        console.warn('Native share failed, falling back to clipboard:', err);
      }
    }

    // Fallback: Copy to clipboard
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(shareText);
        setShareFeedback('Copied to clipboard');
        setTimeout(() => setShareFeedback(null), 2500);
      } else {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = shareText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setShareFeedback('Copied to clipboard');
        setTimeout(() => setShareFeedback(null), 2500);
      }
    } catch (clipErr) {
      console.error('Clipboard copy failed:', clipErr);
      setShareFeedback('Failed to copy');
      setTimeout(() => setShareFeedback(null), 2500);
    }
  };

  const handleToggleItemDone = async (id: string) => {
    setTogglingItemId(id);
    try {
      await onToggleDone(id);
    } finally {
      setTogglingItemId(null);
    }
  };

  const handleDeleteItem = async (id: string) => {
    setDeletingItemId(id);
    try {
      await onDelete(id);
    } finally {
      setDeletingItemId(null);
    }
  };

  const handleStartEdit = (memory: MemoryItem) => {
    setEditingItemId(memory.id);
    setEditText(memory.interpretation?.content || memory.originalText || '');
  };

  const handleCancelEdit = () => {
    setEditingItemId(null);
    setEditText('');
  };

  const handleSaveEdit = async (id: string) => {
    if (!onEdit || !editText.trim()) return;
    setIsSavingEdit(true);
    try {
      await onEdit(id, editText.trim());
      setEditingItemId(null);
      setEditText('');
    } catch (err) {
      console.error('Failed to edit list item:', err);
    } finally {
      setIsSavingEdit(false);
    }
  };

  const toggleItemExpanded = (id: string) => {
    setExpandedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleConfirmDeleteList = async () => {
    setIsDeletingList(true);
    try {
      await onDeleteList(subject);
      setShowDeleteConfirm(false);
    } catch (err) {
      console.error('Failed to delete list:', err);
    } finally {
      setIsDeletingList(false);
    }
  };

  return (
    <div
      id={`list-card-${subject.replace(/\s+/g, '-').toLowerCase()}`}
      className={`rounded-xl border transition-all duration-150 p-4 sm:p-5 bg-white shadow-xs ${
        allDone ? 'border-zinc-200 bg-zinc-50/60 opacity-90' : 'border-zinc-300 hover:border-zinc-400'
      }`}
    >
      {/* Header: LIST Badge, Subject Title, Count, and Top Actions */}
      <div className="flex items-center justify-between gap-2.5 pb-3 border-b border-zinc-100 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-indigo-950 bg-indigo-50 border border-indigo-200/90 px-2 py-0.5 rounded-md">
            <List className="w-3 h-3 text-indigo-700" />
            <span>List</span>
          </span>
          <h3 className="font-bold text-sm sm:text-base text-zinc-900 leading-snug">
            {subject}
          </h3>
          <span className="text-xs text-zinc-600 font-medium bg-zinc-100 px-2 py-0.5 rounded-full border border-zinc-200">
            {memories.length} {memories.length === 1 ? 'item' : 'items'}
            {doneCount > 0 && activeCount > 0 && ` (${doneCount} done)`}
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Share list */}
          <div className="relative">
            <button
              id={`share-list-btn-${subject.replace(/\s+/g, '-').toLowerCase()}`}
              type="button"
              onClick={handleShareList}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-zinc-700 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200 rounded-lg text-xs font-semibold transition-colors cursor-pointer border border-zinc-200/80"
              title={`Share or copy ${subject}`}
            >
              <Share2 className="w-3 h-3 text-zinc-600" />
              <span>Share</span>
            </button>
            {shareFeedback && (
              <span className="absolute -top-7 right-0 whitespace-nowrap text-[10px] font-bold bg-zinc-900 text-white px-2 py-0.5 rounded shadow-sm animate-in fade-in">
                {shareFeedback}
              </span>
            )}
          </div>

          {/* Add item to list */}
          <button
            id={`add-to-list-btn-${subject.replace(/\s+/g, '-').toLowerCase()}`}
            type="button"
            onClick={() => onAddItem(subject)}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-900 border border-indigo-200/90 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
            title={`Add item to ${subject}`}
          >
            <Plus className="w-3 h-3 text-indigo-700" />
            <span>Add item</span>
          </button>

          {/* Expand/Collapse inspection */}
          <button
            id={`toggle-inspect-list-btn-${subject.replace(/\s+/g, '-').toLowerCase()}`}
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="inline-flex items-center gap-1 px-2 py-1 text-zinc-600 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200 rounded-lg text-xs font-medium transition-colors cursor-pointer border border-zinc-200/80"
            title={isExpanded ? 'Collapse item details' : 'Inspect item details'}
          >
            <span>{isExpanded ? 'Collapse' : 'Inspect'}</span>
            {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>

          {/* Delete List */}
          <button
            id={`delete-list-btn-${subject.replace(/\s+/g, '-').toLowerCase()}`}
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isDeletingList}
            className="inline-flex items-center justify-center p-1.5 text-zinc-400 hover:text-rose-700 hover:bg-rose-50 rounded-lg border border-transparent hover:border-rose-200 transition-colors cursor-pointer disabled:opacity-50"
            title="Delete this entire list"
            aria-label="Delete list"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Delete List Confirmation Dialog */}
      {showDeleteConfirm && (
        <div
          id="delete-list-confirmation-dialog"
          className="mt-3 p-3 bg-rose-50 border border-rose-200 rounded-xl space-y-2 animate-in fade-in"
        >
          <div className="flex items-start gap-2 text-rose-900">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-xs">
                Delete &ldquo;{subject}&rdquo; and its {memories.length}{' '}
                {memories.length === 1 ? 'item' : 'items'}?
              </p>
              <p className="text-[11px] text-rose-700 mt-0.5">
                This will permanently delete this list and all its saved memories.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              id="confirm-delete-list-btn"
              type="button"
              onClick={handleConfirmDeleteList}
              disabled={isDeletingList}
              className="inline-flex items-center gap-1 px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer shadow-2xs disabled:opacity-50"
            >
              {isDeletingList ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Deleting…</span>
                </>
              ) : (
                <span>Delete List</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeletingList}
              className="px-3 py-1 bg-white hover:bg-zinc-100 text-zinc-700 border border-zinc-200 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* List Items Container */}
      <div className="mt-3 divide-y divide-zinc-100">
        {sortedMemories.map((mem) => {
          const isItemDone = mem.isDone;
          const isItemEditing = editingItemId === mem.id;
          const isItemExpanded = isExpanded || expandedItemIds.has(mem.id);
          const formattedDate = formatDateTime(mem.createdAt, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });

          const content = mem.interpretation?.content || mem.originalText;
          const resurfacing = mem.interpretation?.resurfacing;
          const people = mem.interpretation?.people || [];
          const places = mem.interpretation?.places || [];
          const topics = mem.interpretation?.topics || [];
          const isToggling = togglingItemId === mem.id;
          const isDeleting = deletingItemId === mem.id;

          return (
            <div
              key={mem.id}
              id={`list-item-${mem.id}`}
              className={`py-2.5 first:pt-1 last:pb-0 transition-colors ${
                isItemDone ? 'opacity-75' : ''
              }`}
            >
              {/* Main Item Row */}
              <div className="flex items-start justify-between gap-2.5">
                {/* Left: Checkbox & Content */}
                <div className="flex items-start gap-2.5 flex-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => handleToggleItemDone(mem.id)}
                    disabled={isToggling}
                    className="mt-0.5 text-zinc-400 hover:text-zinc-700 disabled:opacity-50 cursor-pointer shrink-0 transition-colors"
                    title={isItemDone ? 'Mark as active' : 'Mark as done'}
                  >
                    {isItemDone ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 fill-emerald-50" />
                    ) : (
                      <Circle className="w-4 h-4 text-zinc-300 hover:text-zinc-500" />
                    )}
                  </button>

                  <div className="flex-1 min-w-0">
                    {isItemEditing ? (
                      /* Inline item editor */
                      <div className="space-y-1.5">
                        <input
                          type="text"
                          autoFocus
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleSaveEdit(mem.id);
                            } else if (e.key === 'Escape') {
                              handleCancelEdit();
                            }
                          }}
                          className="w-full text-xs sm:text-sm text-zinc-900 bg-white border border-zinc-300 rounded px-2 py-1 focus:outline-hidden focus:ring-1 focus:ring-zinc-900"
                        />
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleSaveEdit(mem.id)}
                            disabled={isSavingEdit || !editText.trim()}
                            className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-zinc-900 hover:bg-zinc-800 text-white rounded text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-50"
                          >
                            {isSavingEdit ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Check className="w-3 h-3" />
                            )}
                            <span>Save</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleCancelEdit}
                            disabled={isSavingEdit}
                            className="px-2 py-0.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 rounded text-[11px] font-medium transition-colors cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span
                          className={`text-xs sm:text-sm leading-snug break-words ${
                            isItemDone
                              ? 'line-through text-zinc-400 font-normal'
                              : 'text-zinc-900 font-medium'
                          }`}
                        >
                          {content}
                        </span>
                        <span className="text-[10px] text-zinc-400 font-mono">
                          {formattedDate}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: Item Action Buttons */}
                {!isItemEditing && (
                  <div className="flex items-center gap-1 shrink-0">
                    {onEdit && (
                      <button
                        type="button"
                        onClick={() => handleStartEdit(mem)}
                        disabled={isDeleting || isToggling}
                        className="p-1 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded cursor-pointer transition-colors"
                        title="Edit item"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => toggleItemExpanded(mem.id)}
                      className="p-1 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded cursor-pointer transition-colors"
                      title={isItemExpanded ? 'Hide item details' : 'View item details'}
                    >
                      {isItemExpanded ? (
                        <ChevronUp className="w-3 h-3" />
                      ) : (
                        <ChevronDown className="w-3 h-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteItem(mem.id)}
                      disabled={isDeleting || isToggling}
                      className="p-1 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 rounded cursor-pointer transition-colors disabled:opacity-50"
                      title="Delete item"
                    >
                      {isDeleting ? (
                        <Loader2 className="w-3 h-3 animate-spin text-rose-600" />
                      ) : (
                        <Trash2 className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* Expanded Item Details (Provenance, Tags, JSON) */}
              {isItemExpanded && (
                <div className="mt-2 pl-6 pr-1 space-y-2 text-xs border-l-2 border-indigo-100 animate-in fade-in">
                  {/* Original Stored Thought (Provenance) */}
                  <div className="bg-zinc-50 rounded-lg p-2.5 border border-zinc-200">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-600 mb-0.5">
                      <FileText className="w-3 h-3" />
                      <span>Original Stored Thought</span>
                    </div>
                    <p className="text-[11px] text-zinc-700 italic leading-normal">
                      &ldquo;{mem.originalText}&rdquo;
                    </p>
                  </div>

                  {/* Resurfacing Timing / Structured Tags */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                    {resurfacing && (resurfacing.mode || resurfacing.timing) && (
                      <div className="flex items-start gap-1.5 bg-blue-50/70 border border-blue-200/70 rounded-md p-2">
                        <Clock className="w-3.5 h-3.5 text-blue-700 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-semibold text-blue-900">Resurfacing</div>
                          <div className="text-blue-800">
                            {resurfacing.timing || 'Unspecified'}
                          </div>
                        </div>
                      </div>
                    )}

                    {(people.length > 0 || places.length > 0) && (
                      <div className="space-y-1 bg-zinc-50 border border-zinc-200 rounded-md p-2">
                        {people.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            <Users className="w-3 h-3 text-zinc-500 shrink-0" />
                            <span className="font-medium text-zinc-600">People:</span>
                            {people.map((p, idx) => (
                              <span
                                key={idx}
                                className="bg-purple-100 text-purple-800 px-1.5 py-0.2 rounded text-[10px] font-medium"
                              >
                                {p}
                              </span>
                            ))}
                          </div>
                        )}
                        {places.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            <MapPin className="w-3 h-3 text-zinc-500 shrink-0" />
                            <span className="font-medium text-zinc-600">Places:</span>
                            {places.map((pl, idx) => (
                              <span
                                key={idx}
                                className="bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded text-[10px] font-medium"
                              >
                                {pl}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Topics */}
                  {topics.length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap pt-0.5">
                      <Tag className="w-3 h-3 text-zinc-500 shrink-0" />
                      <span className="text-[11px] font-medium text-zinc-600">Topics:</span>
                      {topics.map((topic, idx) => (
                        <span
                          key={idx}
                          className="bg-zinc-100 text-zinc-700 border border-zinc-200 px-1.5 py-0.2 rounded-full text-[10px] font-medium"
                        >
                          #{topic}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* JSON Toggle */}
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() =>
                        setJsonViewerId(jsonViewerId === mem.id ? null : mem.id)
                      }
                      className="inline-flex items-center gap-1 text-[10px] font-medium text-zinc-500 hover:text-zinc-800 transition-colors cursor-pointer"
                    >
                      <Code2 className="w-2.5 h-2.5" />
                      <span>
                        {jsonViewerId === mem.id ? 'Hide Structured JSON' : 'View Structured JSON'}
                      </span>
                    </button>

                    {jsonViewerId === mem.id && (
                      <div className="mt-1.5 p-2.5 bg-zinc-900 text-zinc-100 rounded-lg text-[10px] font-mono overflow-x-auto">
                        <pre>
                          {JSON.stringify(
                            {
                              ...mem.interpretation,
                              originalText: mem.originalText,
                              id: mem.id,
                              isDone: mem.isDone,
                            },
                            null,
                            2
                          )}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

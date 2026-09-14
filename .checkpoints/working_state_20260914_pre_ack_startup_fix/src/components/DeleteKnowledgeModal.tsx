import React from 'react';
import { AlertTriangle, Trash2, UserX } from 'lucide-react';
import { MemoryItem, UserRelationship } from '../types';

export interface LearnedKnowledgeDeletePrompt {
  memory: MemoryItem;
  associatedRelationships: UserRelationship[];
}

interface DeleteKnowledgeModalProps {
  prompt: LearnedKnowledgeDeletePrompt | null;
  isDeleting: boolean;
  onConfirmDeleteMemoryOnly: () => Promise<void>;
  onConfirmDeleteAndForget: (personName: string) => Promise<void>;
  onCancel: () => void;
}

export const DeleteKnowledgeModal: React.FC<DeleteKnowledgeModalProps> = ({
  prompt,
  isDeleting,
  onConfirmDeleteMemoryOnly,
  onConfirmDeleteAndForget,
  onCancel,
}) => {
  if (!prompt) return null;

  const { memory, associatedRelationships } = prompt;
  const memoryKind = (memory.interpretation?.kind || 'thought').toLowerCase();
  const kindLabel =
    memoryKind === 'reminder'
      ? 'reminder'
      : memoryKind === 'task'
      ? 'task'
      : memoryKind === 'fact'
      ? 'fact'
      : 'memory';

  const memoryTitle = memory.interpretation?.content || memory.originalText;
  const truncatedTitle =
    memoryTitle.length > 50 ? `${memoryTitle.slice(0, 47)}…` : memoryTitle;

  // Distinct people with learned knowledge in this memory
  const distinctPeople: string[] = Array.from(
    new Set(associatedRelationships.map((r) => r.person))
  );
  const primaryPerson: string = distinctPeople[0] || 'this person';

  // Format explanation of learned relationships (e.g. "Bill is your cousin")
  const relationshipSummaries = associatedRelationships.map(
    (r) => `${r.person} is your ${r.role}`
  );
  const relationshipText =
    relationshipSummaries.length > 0
      ? relationshipSummaries.join(' and ')
      : `${primaryPerson}'s details`;

  return (
    <div
      id="delete-knowledge-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in"
    >
      <div
        id="delete-knowledge-modal"
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md bg-white rounded-2xl border border-zinc-200 shadow-xl p-5 sm:p-6 space-y-4 animate-in zoom-in-95"
      >
        <div className="flex items-start gap-3">
          <div className="p-2.5 bg-amber-50 rounded-xl border border-amber-200 text-amber-600 shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm sm:text-base font-bold text-zinc-900 leading-snug">
              Delete “{truncatedTitle}”?
            </h3>
            <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
              This {kindLabel} will be deleted. Ezzy will still remember that{' '}
              <span className="font-semibold text-zinc-900">{relationshipText}</span>.
            </p>
          </div>
        </div>

        <div className="pt-2 border-t border-zinc-100 space-y-2">
          {/* Option 1: Delete memory only */}
          <button
            type="button"
            id="modal-delete-memory-only-btn"
            onClick={onConfirmDeleteMemoryOnly}
            disabled={isDeleting}
            className="w-full flex items-center justify-center gap-2 py-2 px-3.5 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl text-xs sm:text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50 shadow-xs"
          >
            <Trash2 className="w-4 h-4 text-zinc-300" />
            <span>Delete {kindLabel}</span>
          </button>

          {/* Option 2: Delete memory and forget learned entity/relationship */}
          {distinctPeople.map((person) => (
            <button
              key={`forget-${person}`}
              type="button"
              id={`modal-delete-and-forget-${person.toLowerCase().replace(/[^a-z0-9]/g, '-')}-btn`}
              onClick={() => onConfirmDeleteAndForget(person)}
              disabled={isDeleting}
              className="w-full flex items-center justify-center gap-2 py-2 px-3.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-xl text-xs sm:text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50"
            >
              <UserX className="w-4 h-4 text-rose-600" />
              <span>Delete & forget {person}</span>
            </button>
          ))}

          {/* Option 3: Cancel */}
          <button
            type="button"
            id="modal-cancel-delete-btn"
            onClick={onCancel}
            disabled={isDeleting}
            className="w-full py-2 px-3.5 bg-white hover:bg-zinc-100 text-zinc-700 border border-zinc-200 rounded-xl text-xs sm:text-sm font-medium transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

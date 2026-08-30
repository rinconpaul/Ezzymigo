import React, { useState } from 'react';
import { 
  CheckCircle2, 
  Circle, 
  Trash2, 
  Tag, 
  Users, 
  MapPin, 
  Clock, 
  Code2, 
  ChevronDown, 
  ChevronUp,
  FileText
} from 'lucide-react';
import { MemoryItem } from '../types';

interface MemoryCardProps {
  memory: MemoryItem;
  onToggleDone: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export const MemoryCard: React.FC<MemoryCardProps> = ({
  memory,
  onToggleDone,
  onDelete,
}) => {
  const [showJson, setShowJson] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  const { originalText, isDone, createdAt, interpretation } = memory;
  const { content, kind, people = [], places = [], topics = [], resurfacing } = interpretation || {};

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

  const formattedDate = new Date(createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      id={`memory-${memory.id}`}
      className={`rounded-xl border transition-all duration-150 p-5 bg-white shadow-xs ${
        isDone ? 'border-zinc-200 bg-zinc-50/70 opacity-80' : 'border-zinc-300 hover:border-zinc-400'
      }`}
    >
      {/* Top row: Kind, Status, Date, Actions */}
      <div className="flex items-center justify-between gap-3 mb-3 pb-3 border-b border-zinc-100">
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
        </div>

        {/* Action Buttons: Done & Delete */}
        <div className="flex items-center gap-2">
          <button
            id={`done-btn-${memory.id}`}
            type="button"
            onClick={handleToggle}
            disabled={isToggling}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
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
            disabled={isDeleting}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-rose-600 hover:text-rose-700 hover:bg-rose-50 border border-rose-200 transition-colors cursor-pointer disabled:opacity-50"
            title="Delete memory"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete</span>
          </button>
        </div>
      </div>

      {/* Main Content: Distilled Interpretation & Original Text */}
      <div className="space-y-3">
        <div>
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">
            Interpreted Content
          </div>
          <p className={`text-base font-medium leading-relaxed ${isDone ? 'text-zinc-500 line-through' : 'text-zinc-900'}`}>
            {content || originalText}
          </p>
        </div>

        {/* Original Text Section */}
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

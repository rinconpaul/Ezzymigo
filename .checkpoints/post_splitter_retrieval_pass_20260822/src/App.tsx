import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { ThoughtInput } from './components/ThoughtInput';
import { MemoryCard } from './components/MemoryCard';
import { AskEzzymigoPanel } from './components/AskEzzymigoPanel';
import { MemoryItem } from './types';
import { Database, AlertCircle, RefreshCw, Search } from 'lucide-react';

export default function App() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'done'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch memories from persistent backend storage on mount
  const fetchMemories = async () => {
    setIsFetching(true);
    setError(null);
    try {
      const res = await fetch('/api/memories');
      if (!res.ok) {
        throw new Error(`Failed to load memories (HTTP ${res.status})`);
      }
      const data = await res.json();
      setMemories(data.memories || []);
    } catch (err: any) {
      console.error('Fetch error:', err);
      setError(err?.message || 'Could not connect to storage server.');
    } finally {
      setIsFetching(false);
    }
  };

  useEffect(() => {
    fetchMemories();
  }, []);

  // Save new thought
  const handleSaveThought = async (text: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalText: text,
          clientNow: new Date().toISOString(),
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error: ${res.statusText}`);
      }

      const data = await res.json();
      if (data.memories && Array.isArray(data.memories)) {
        setMemories((prev) => [...data.memories, ...prev]);
      } else if (data.memory) {
        setMemories((prev) => [data.memory, ...prev]);
      }
    } catch (err: any) {
      console.error('Save error:', err);
      setError(err?.message || 'Failed to interpret and save thought.');
    } finally {
      setIsLoading(false);
    }
  };

  // Toggle Done / Active
  const handleToggleDone = async (id: string) => {
    try {
      const res = await fetch(`/api/memories/${id}/toggle`, {
        method: 'PATCH',
      });
      if (!res.ok) throw new Error('Failed to update status');
      const data = await res.json();
      
      setMemories((prev) =>
        prev.map((item) => (item.id === id ? data.memory : item))
      );
    } catch (err: any) {
      console.error('Toggle error:', err);
      setError('Failed to update memory status.');
    }
  };

  // Delete Memory
  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/memories/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete memory');
      setMemories((prev) => prev.filter((item) => item.id !== id));
    } catch (err: any) {
      console.error('Delete error:', err);
      setError('Failed to delete memory.');
    }
  };

  // Filter & Search Logic
  const filteredMemories = memories.filter((item) => {
    const matchesFilter =
      filter === 'all'
        ? true
        : filter === 'active'
        ? !item.isDone
        : item.isDone;

    if (!matchesFilter) return false;

    if (!searchQuery.trim()) return true;

    const q = searchQuery.toLowerCase();
    const orig = item.originalText?.toLowerCase() || '';
    const content = item.interpretation?.content?.toLowerCase() || '';
    const kind = item.interpretation?.kind?.toLowerCase() || '';
    const people = (item.interpretation?.people || []).join(' ').toLowerCase();
    const places = (item.interpretation?.places || []).join(' ').toLowerCase();
    const topics = (item.interpretation?.topics || []).join(' ').toLowerCase();

    return (
      orig.includes(q) ||
      content.includes(q) ||
      kind.includes(q) ||
      people.includes(q) ||
      places.includes(q) ||
      topics.includes(q)
    );
  });

  const activeCount = memories.filter((m) => !m.isDone).length;
  const doneCount = memories.filter((m) => m.isDone).length;

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900 flex flex-col font-sans">
      <Header />

      <main className="flex-1 max-w-4xl w-full mx-auto p-4 sm:p-6 md:py-8 space-y-6">
        {/* Error Notification */}
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 px-4 py-3 rounded-xl flex items-start justify-between gap-3 text-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-xs font-semibold underline text-rose-700 hover:text-rose-900 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Primary Input Box Section */}
        <section>
          <ThoughtInput onSave={handleSaveThought} isLoading={isLoading} />
        </section>

        {/* Stored Memories Section */}
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-zinc-200">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-zinc-600" />
              <h2 className="text-base font-bold text-zinc-900">Stored Intention Memories</h2>
              <span className="text-xs bg-zinc-200 text-zinc-700 font-semibold px-2 py-0.5 rounded-full">
                {memories.length}
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
              {/* Filter Tabs */}
              <div className="flex rounded-lg bg-zinc-200/80 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setFilter('all')}
                  className={`px-3 py-1 rounded-md transition-colors cursor-pointer ${
                    filter === 'all' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  All ({memories.length})
                </button>
                <button
                  type="button"
                  onClick={() => setFilter('active')}
                  className={`px-3 py-1 rounded-md transition-colors cursor-pointer ${
                    filter === 'active' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  Active ({activeCount})
                </button>
                <button
                  type="button"
                  onClick={() => setFilter('done')}
                  className={`px-3 py-1 rounded-md transition-colors cursor-pointer ${
                    filter === 'done' ? 'bg-white text-zinc-900 shadow-2xs font-semibold' : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  Done ({doneCount})
                </button>
              </div>

              {/* Refresh button */}
              <button
                type="button"
                onClick={fetchMemories}
                disabled={isFetching}
                title="Refresh memories from persistent storage"
                className="p-1.5 rounded-md bg-white border border-zinc-200 text-zinc-600 hover:text-zinc-900 transition-colors disabled:opacity-50 cursor-pointer shadow-2xs"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* Search bar if there are memories */}
          {memories.length > 2 && (
            <div className="relative">
              <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search memories by keyword, person, place, or topic..."
                className="w-full pl-9 pr-4 py-2 bg-white rounded-lg border border-zinc-200 text-xs text-zinc-800 placeholder:text-zinc-400 focus:outline-hidden focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900"
              />
            </div>
          )}

          {/* Ask Ezzymigo Panel */}
          <AskEzzymigoPanel />

          {/* List of Memories */}
          {isFetching && memories.length === 0 ? (
            <div className="bg-white rounded-xl border border-zinc-200 p-8 text-center text-sm text-zinc-500">
              Loading stored memories from persistent storage...
            </div>
          ) : filteredMemories.length === 0 ? (
            <div className="bg-white rounded-xl border border-dashed border-zinc-300 p-10 text-center space-y-2">
              <p className="text-sm font-semibold text-zinc-700">
                {searchQuery ? 'No matching intention memories found' : 'No memories stored yet'}
              </p>
              <p className="text-xs text-zinc-500 max-w-sm mx-auto">
                {searchQuery
                  ? 'Try clearing your search query to view all memories.'
                  : 'Type any thought or intention into the box above and press Save to let Ezzymigo structure and store it.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3.5">
              {filteredMemories.map((memory) => (
                <MemoryCard
                  key={memory.id}
                  memory={memory}
                  onToggleDone={handleToggleDone}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

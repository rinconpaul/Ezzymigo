import React, { useState } from 'react';
import { HelpCircle, Send, Loader2, Sparkles, AlertCircle } from 'lucide-react';

export const AskEzzymigoPanel: React.FC = () => {
  const [question, setQuestion] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAsk = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || isLoading) return;

    setIsLoading(true);
    setError(null);
    setAnswer(null);

    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to retrieve answer from memories.');
      }

      setAnswer(data.answer || "I couldn't find anything relevant in your saved memories.");
    } catch (err: any) {
      console.error('[Ask Ezzymigo] Error:', err);
      setError(err?.message || 'Something went wrong while searching your memories.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };

  return (
    <div
      id="ask-ezzymigo-panel"
      className="bg-white rounded-xl border border-zinc-200 p-4 sm:p-5 shadow-xs space-y-3"
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <HelpCircle className="w-4 h-4 text-zinc-800" />
          <h3 className="text-sm font-bold text-zinc-900">Ask Ezzymigo</h3>
        </div>
        <p className="text-xs text-zinc-500">
          Ask naturally about anything you’ve saved.
        </p>
      </div>

      <form onSubmit={handleAsk} className="flex items-center gap-2">
        <input
          id="ask-ezzymigo-input"
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          placeholder="What did Barb want me to buy?"
          className="flex-1 px-3.5 py-2 bg-zinc-50 rounded-lg border border-zinc-200 text-xs sm:text-sm text-zinc-800 placeholder:text-zinc-400 focus:outline-hidden focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900 focus:bg-white disabled:opacity-60 transition-colors"
        />
        <button
          id="ask-ezzymigo-button"
          type="submit"
          disabled={isLoading || !question.trim()}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 text-white rounded-lg text-xs sm:text-sm font-medium transition-colors cursor-pointer shadow-xs shrink-0"
        >
          {isLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Send className="w-3.5 h-3.5" />
          )}
          <span>{isLoading ? 'Searching...' : 'Ask'}</span>
        </button>
      </form>

      {/* Answer Display */}
      {answer && (
        <div
          id="ask-ezzymigo-answer"
          className="mt-3 p-3.5 bg-zinc-50 border border-zinc-200 rounded-lg text-zinc-800 text-xs sm:text-sm space-y-1.5 animate-in fade-in"
        >
          <div className="flex items-center gap-1.5 text-zinc-500 font-medium text-xs">
            <Sparkles className="w-3.5 h-3.5 text-zinc-700" />
            <span>Ezzymigo</span>
          </div>
          <p className="leading-relaxed text-zinc-900 font-normal">
            {answer}
          </p>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div
          id="ask-ezzymigo-error"
          className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

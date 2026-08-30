import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2, Lightbulb, Mic, MicOff } from 'lucide-react';

interface ThoughtInputProps {
  onSave: (text: string) => Promise<void>;
  isLoading: boolean;
}

const EXAMPLE_HINTS = [
  {
    label: 'Appointment',
    text: 'Dentist Tuesday at 2pm — remind me Monday evening.',
  },
  {
    label: 'Reminder',
    text: 'Put the bins out tomorrow — remind me at 7pm.',
  },
  {
    label: 'Remember',
    text: 'Barb wants milk from Woolies — remind me Saturday morning.',
  },
];

export const ThoughtInput: React.FC<ThoughtInputProps> = ({ onSave, isLoading }) => {
  const [thought, setThought] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore cleanup abort
        }
      }
    };
  }, []);

  const toggleListening = () => {
    setSpeechNotice(null);

    const SpeechRecognitionAPI =
      typeof window !== 'undefined'
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;

    if (!SpeechRecognitionAPI) {
      setSpeechNotice('Speech recognition is not supported in this browser. Please use keyboard entry.');
      return;
    }

    if (isListening) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          setIsListening(false);
        }
      }
      return;
    }

    try {
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = navigator.language || 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
        setSpeechNotice(null);
      };

      recognition.onresult = (event: any) => {
        let finalPhrase = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const result = event.results[i];
          if (result && result.isFinal) {
            const transcript = result[0]?.transcript || '';
            if (transcript) {
              finalPhrase += (finalPhrase ? ' ' : '') + transcript.trim();
            }
          }
        }

        if (finalPhrase) {
          setThought((prev) => {
            const trimmedBase = prev.trim();
            if (!trimmedBase) {
              return finalPhrase;
            }
            return `${trimmedBase} ${finalPhrase}`;
          });
        }
      };

      recognition.onerror = (event: any) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setSpeechNotice('Microphone permission denied. Please allow microphone access in your browser.');
        } else if (event.error !== 'no-speech') {
          setSpeechNotice(`Dictation notice: ${event.error}`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err: any) {
      console.error('Speech recognition error:', err);
      setSpeechNotice('Could not start speech recognition.');
      setIsListening(false);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!thought.trim() || isLoading) return;

    if (isListening && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }

    const current = thought;
    await onSave(current);
    setThought('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="bg-white rounded-xl border border-zinc-200 p-4 sm:p-5 shadow-xs">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div>
          <label htmlFor="thought-input" className="text-sm font-semibold text-zinc-800 flex items-center justify-between">
            <span>Type or dictate your thought</span>
            <span className="hidden sm:inline text-xs font-normal text-zinc-500">Press <kbd className="px-1.5 py-0.5 bg-zinc-100 border border-zinc-300 rounded text-[11px] font-mono">⌘/Ctrl+Enter</kbd> to save</span>
          </label>
          <p className="text-xs text-zinc-500 mt-0.5 leading-normal">
            Just say it naturally. Include when it’s happening and when you’d like reminding.
          </p>
        </div>
        
        <textarea
          id="thought-input"
          value={thought}
          onChange={(e) => setThought(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="What's on your mind? (e.g. 'Dentist Tuesday at 2pm — remind me Monday evening.')"
          rows={3}
          disabled={isLoading}
          className="w-full px-3.5 py-2.5 rounded-lg border border-zinc-300 text-zinc-900 placeholder:text-zinc-400 focus:outline-hidden focus:ring-2 focus:ring-zinc-900 focus:border-transparent resize-y text-base font-normal leading-relaxed disabled:bg-zinc-50"
        />

        {/* Non-blocking Speech Notice / Listening State */}
        {(speechNotice || isListening) && (
          <div className="text-xs flex items-center justify-between gap-2">
            {isListening ? (
              <div className="flex items-center gap-1.5 text-red-600 font-medium animate-pulse">
                <span className="w-2 h-2 rounded-full bg-red-600"></span>
                <span>Listening... Speak into your microphone. Tap mic again to stop.</span>
              </div>
            ) : null}
            {speechNotice ? (
              <span className="text-amber-800 bg-amber-50 px-2 py-1 rounded border border-amber-200">
                {speechNotice}
              </span>
            ) : null}
          </div>
        )}

        {/* Action Row: Examples & Buttons */}
        <div className="flex flex-col gap-3 pt-1">
          {/* Action Buttons Row */}
          <div className="flex items-center justify-end gap-2">
            {/* Microphone Dictation Button */}
            <button
              id="mic-dictate-btn"
              type="button"
              onClick={toggleListening}
              disabled={isLoading}
              title={isListening ? 'Stop microphone dictation' : 'Start microphone dictation'}
              aria-label={isListening ? 'Stop microphone dictation' : 'Start microphone dictation'}
              className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg font-medium text-sm border transition-all cursor-pointer shadow-xs ${
                isListening
                  ? 'bg-red-50 text-red-700 border-red-300 ring-2 ring-red-400 ring-offset-1'
                  : 'bg-zinc-100 text-zinc-800 hover:bg-zinc-200 border-zinc-300 active:scale-95'
              }`}
            >
              {isListening ? (
                <>
                  <MicOff className="w-4 h-4 text-red-600 animate-pulse" />
                  <span>Stop</span>
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4 text-zinc-700" />
                  <span>Dictate</span>
                </>
              )}
            </button>

            {/* Existing Save Button */}
            <button
              id="save-thought-btn"
              type="submit"
              disabled={!thought.trim() || isLoading}
              className="inline-flex items-center justify-center gap-2 px-6 py-2 rounded-lg bg-zinc-900 text-white font-medium text-sm hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-xs shrink-0 cursor-pointer"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Interpreting &amp; Saving...</span>
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  <span>Save</span>
                </>
              )}
            </button>
          </div>

          {/* Example Hints with responsive wrapping */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500 pt-1 border-t border-zinc-100">
            <div className="flex items-center gap-1 text-zinc-400 shrink-0 font-medium">
              <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
              <span>Try:</span>
            </div>
            {EXAMPLE_HINTS.map((hint, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setThought(hint.text)}
                className="text-left text-zinc-600 hover:text-zinc-900 bg-zinc-50 hover:bg-zinc-100 px-2.5 py-1 rounded-md border border-zinc-200 transition-colors cursor-pointer leading-snug"
              >
                <span className="font-semibold text-zinc-700">{hint.label}:</span> “{hint.text}”
              </button>
            ))}
          </div>
        </div>
      </form>
    </div>
  );
};

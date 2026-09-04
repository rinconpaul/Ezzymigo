import { useState, useRef, useEffect, useCallback } from 'react';
import { getUserPreferences } from './userPreferences';

interface UseSpeechDictationOptions {
  onAppendText: (text: string) => void;
  onStop?: () => void;
  language?: string;
}

export function useSpeechDictation({ onAppendText, onStop, language }: UseSpeechDictationOptions) {
  const [isListening, setIsListening] = useState(false);
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const isExplicitlyActiveRef = useRef<boolean>(false);
  const onAppendTextRef = useRef(onAppendText);
  const onStopRef = useRef(onStop);
  const languageRef = useRef(language);
  const restartTimerRef = useRef<any>(null);
  const instanceIdRef = useRef<string>(Math.random().toString(36).substring(2, 9));

  useEffect(() => {
    onAppendTextRef.current = onAppendText;
  }, [onAppendText]);

  useEffect(() => {
    onStopRef.current = onStop;
  }, [onStop]);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  // Clean up restart timer
  const clearRestartTimer = () => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  };

  const stopListening = useCallback((): Promise<void> => {
    isExplicitlyActiveRef.current = false;
    clearRestartTimer();

    return new Promise<void>((resolve) => {
      const recognition = recognitionRef.current;
      if (!recognition) {
        setIsListening(false);
        if (onStopRef.current) {
          onStopRef.current();
        }
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          setIsListening(false);
          recognitionRef.current = null;
          if (onStopRef.current) {
            onStopRef.current();
          }
          resolve();
        }
      };

      // Set a short safety timeout so UI never hangs (150ms)
      const timeoutId = setTimeout(finish, 150);

      const prevOnEnd = recognition.onend;
      recognition.onend = () => {
        clearTimeout(timeoutId);
        if (prevOnEnd) {
          try {
            prevOnEnd();
          } catch {}
        }
        finish();
      };

      try {
        recognition.stop();
      } catch {
        clearTimeout(timeoutId);
        finish();
      }
    });
  }, []);

  const createAndStartRecognition = useCallback(() => {
    const SpeechRecognitionAPI =
      typeof window !== 'undefined'
        ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        : null;

    if (!SpeechRecognitionAPI) {
      setSpeechNotice('Speech recognition is not supported in this browser. Please use keyboard entry.');
      isExplicitlyActiveRef.current = false;
      setIsListening(false);
      return;
    }

    try {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
        recognitionRef.current = null;
      }

      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = true;
      recognition.interimResults = false;
      const configuredLang = languageRef.current || getUserPreferences().language || navigator.language || 'en-AU';
      recognition.lang = configuredLang;

      recognition.onstart = () => {
        if (isExplicitlyActiveRef.current) {
          setIsListening(true);
          setSpeechNotice(null);
        }
      };

      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            transcript += event.results[i][0].transcript;
          }
        }
        const trimmed = transcript.trim();
        if (trimmed) {
          onAppendTextRef.current(trimmed);
        }
      };

      recognition.onerror = (event: any) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          isExplicitlyActiveRef.current = false;
          setSpeechNotice('Microphone permission denied. Please allow microphone access in your browser settings.');
          setIsListening(false);
        } else if (event.error === 'network') {
          isExplicitlyActiveRef.current = false;
          setSpeechNotice('Speech recognition network error. Please try again.');
          setIsListening(false);
        } else if (event.error === 'no-speech') {
          // Normal thinking pause - do not abort session
        } else if (event.error !== 'aborted') {
          console.warn('Speech recognition warning:', event.error);
        }
      };

      recognition.onend = () => {
        // If user has not explicitly stopped, smoothly restart recognition to tolerate thinking pauses
        if (isExplicitlyActiveRef.current) {
          clearRestartTimer();
          restartTimerRef.current = setTimeout(() => {
            if (isExplicitlyActiveRef.current) {
              try {
                createAndStartRecognition();
              } catch (err) {
                console.warn('Dictation auto-resume retry:', err);
              }
            }
          }, 150);
        } else {
          setIsListening(false);
          if (onStopRef.current) {
            onStopRef.current();
          }
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err: any) {
      console.error('Speech recognition start error:', err);
      if (isExplicitlyActiveRef.current) {
        setSpeechNotice('Could not start microphone dictation.');
        isExplicitlyActiveRef.current = false;
      }
      setIsListening(false);
    }
  }, []);

  const startListening = useCallback(() => {
    isExplicitlyActiveRef.current = true;
    setSpeechNotice(null);
    setIsListening(true);

    // Notify any other active mic instance in window to stop so only one mic is capturing at a time
    const myId = instanceIdRef.current;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ezzymigo-mic-activate', { detail: { senderId: myId } }));
    }

    createAndStartRecognition();
  }, [createAndStartRecognition]);

  const toggleListening = useCallback(() => {
    setSpeechNotice(null);
    if (isListening || isExplicitlyActiveRef.current) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  // Listen for other mic instances starting to prevent overlapping recordings
  useEffect(() => {
    const handleOtherMicActivated = (e: any) => {
      const myId = instanceIdRef.current;
      if (e?.detail?.senderId && e.detail.senderId !== myId) {
        if (isExplicitlyActiveRef.current) {
          stopListening();
        }
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('ezzymigo-mic-activate', handleOtherMicActivated);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('ezzymigo-mic-activate', handleOtherMicActivated);
      }
      isExplicitlyActiveRef.current = false;
      clearRestartTimer();
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
        recognitionRef.current = null;
      }
    };
  }, [stopListening]);

  return {
    isListening,
    speechNotice,
    startListening,
    toggleListening,
    stopListening,
    setSpeechNotice,
  };
}

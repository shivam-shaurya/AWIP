import { useEffect, useRef, useState } from "react";

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

// Pure browser Web Speech API — no server round-trip, no new dependency.
// Chrome/Edge only (no Firefox/Safari support) and requires a secure
// context, so callers should hide the mic entirely when isSupported is false
// rather than show a button that will silently fail.
export function useSpeechRecognition(onResult: (transcript: string) => void) {
  const [isSupported] = useState(() => !!getRecognitionCtor() && (typeof window === "undefined" || window.isSecureContext));
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    return () => recognitionRef.current?.stop();
  }, []);

  const start = () => {
    if (!isSupported || isListening) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-IN";
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results as ArrayLike<any>)
        .map((r: any) => r[0].transcript)
        .join(" ");
      onResultRef.current(transcript);
    };
    recognition.onerror = (event: any) => {
      setError(event.error === "not-allowed" ? "Microphone access denied." : "Voice input failed — try again.");
      setIsListening(false);
    };
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    setError(null);
    setIsListening(true);
    recognition.start();
  };

  const stop = () => {
    recognitionRef.current?.stop();
    setIsListening(false);
  };

  return { isSupported, isListening, error, start, stop };
}

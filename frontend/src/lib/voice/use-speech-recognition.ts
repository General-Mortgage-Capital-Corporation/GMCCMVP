"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState, useRef, useCallback, useEffect } from "react";

// Web Speech API types (not in all TS libs)
declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
  }
}

interface SpeechRecognitionHook {
  isListening: boolean;
  transcript: string;
  start: () => void;
  stop: () => void;
  isSupported: boolean;
}

/**
 * Hook wrapping the browser Web Speech API for speech-to-text.
 * Works in Chrome, Edge, Safari. Returns isSupported=false in Firefox.
 *
 * @param onFinalTranscript - called when speech recognition produces a final result
 */
export function useSpeechRecognition(
  onFinalTranscript: (text: string) => void,
): SpeechRecognitionHook {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [isSupported, setIsSupported] = useState(false);
  const recognitionRef = useRef<any>(null);
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;

  // Check support after mount to avoid hydration mismatch
  useEffect(() => {
    setIsSupported(
      "SpeechRecognition" in window || "webkitSpeechRecognition" in window,
    );
  }, []);

  const start = useCallback(() => {
    if (!isSupported || recognitionRef.current) return;

    const SpeechRecognition =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      if (final) {
        setTranscript("");
        onFinalRef.current(final.trim());
      } else {
        setTranscript(interim);
      }
    };

    recognition.onerror = (event: any) => {
      console.warn("[stt] Error:", event.error);
      if (event.error !== "no-speech") {
        setIsListening(false);
        recognitionRef.current = null;
      }
    };

    recognition.onend = () => {
      // Restart if still supposed to be listening (browser auto-stops after silence)
      if (recognitionRef.current) {
        try {
          recognition.start();
        } catch {
          setIsListening(false);
          recognitionRef.current = null;
        }
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
    setTranscript("");
  }, [isSupported]);

  const stop = useCallback(() => {
    const r = recognitionRef.current;
    if (r) {
      recognitionRef.current = null;
      r.stop();
      setIsListening(false);
      setTranscript("");
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  return { isListening, transcript, start, stop, isSupported };
}

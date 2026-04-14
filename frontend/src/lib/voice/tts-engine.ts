/**
 * Text-to-speech engine powered by ElevenLabs streaming TTS (via backend proxy).
 * Falls back to browser speechSynthesis if the proxy is unavailable.
 */

export interface TTSEngine {
  speak: (text: string) => void;
  stop: () => void;
  setEnabled: (on: boolean) => void;
  isEnabled: () => boolean;
  isSpeaking: () => boolean;
  onSpeakingChange: (cb: (speaking: boolean) => void) => void;
}

export function createTTSEngine(): TTSEngine {
  let enabled = true;
  let currentAudio: HTMLAudioElement | null = null;
  let currentUrl: string | null = null; // track for cleanup
  let queue: string[] = [];
  let playing = false;
  let speakingChangeCallback: ((speaking: boolean) => void) | null = null;

  function setSpeaking(val: boolean) {
    speakingChangeCallback?.(val);
  }

  function cleanupAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
  }

  async function playNext() {
    if (playing || queue.length === 0 || !enabled) return;
    playing = true;
    setSpeaking(true);
    const text = queue.shift()!;

    try {
      await playViaProxy(text);
    } catch (err) {
      console.warn("[tts] Proxy TTS failed, trying browser fallback:", err);
      try { await playBrowserTTS(text); } catch { /* give up */ }
    }

    playing = false;
    if (queue.length === 0) setSpeaking(false);
    // Use queueMicrotask to avoid recursive stack buildup
    if (enabled && queue.length > 0) queueMicrotask(playNext);
  }

  async function playViaProxy(text: string): Promise<void> {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`TTS proxy ${res.status}: ${errText.slice(0, 100)}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    return new Promise<void>((resolve, reject) => {
      const audio = new Audio(url);
      currentAudio = audio;
      currentUrl = url;

      const cleanup = () => {
        currentAudio = null;
        currentUrl = null;
        URL.revokeObjectURL(url);
      };

      audio.onended = () => { cleanup(); resolve(); };
      audio.onerror = () => { cleanup(); reject(new Error("Audio playback failed")); };
      audio.play().catch((err) => { cleanup(); reject(err); });
    });
  }

  function playBrowserTTS(text: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!window.speechSynthesis) { reject(new Error("No speechSynthesis")); return; }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.1;
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error("Speech synthesis error"));
      window.speechSynthesis.speak(utterance);
    });
  }

  return {
    speak(text: string) {
      if (!enabled || !text.trim()) return;
      queue.push(text);
      playNext();
    },
    stop() {
      queue = [];
      playing = false;
      setSpeaking(false);
      cleanupAudio();
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    },
    setEnabled(on: boolean) {
      enabled = on;
      if (!on) this.stop();
    },
    isEnabled() { return enabled; },
    isSpeaking() { return playing; },
    onSpeakingChange(cb: (speaking: boolean) => void) { speakingChangeCallback = cb; },
  };
}

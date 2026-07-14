type CaptionHandler = (text: string, isFinal: boolean) => void;

type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type BrowserSpeechRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

/**
 * Web Speech captions. When muted/stopped, no results are emitted
 * (critical on Mac so TTS from speakers cannot become a user caption).
 */
export class BrowserCaption {
  private recognition: BrowserSpeechRecognition | null = null;
  private handler: CaptionHandler | null = null;
  private wanted = false;
  private muted = false;
  private lang = "vi-VN";

  onCaption(handler: CaptionHandler): void {
    this.handler = handler;
  }

  get supported(): boolean {
    return Boolean(getSpeechRecognitionConstructor());
  }

  get isActive(): boolean {
    return this.wanted && !this.muted && this.recognition != null;
  }

  start(lang = "vi-VN"): void {
    this.lang = lang;
    this.muted = false;
    this.wanted = true;
    this.boot(lang);
  }

  /** Soft mute — keep instance but drop every result (no UI / no transport). */
  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  /**
   * Hard stop: abort recognition and detach handlers so late finals
   * from speaker audio cannot fire into the UI.
   */
  stop(): void {
    this.wanted = false;
    this.muted = true;
    this.teardown();
  }

  private boot(lang: string): void {
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) {
      throw new Error(
        "Trình duyệt không hỗ trợ Web Speech API (thử Chrome/Edge).",
      );
    }

    this.teardown();
    this.wanted = true;
    this.muted = false;

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      if (!this.wanted || this.muted) return;

      let interim = "";
      let finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const piece = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += piece;
        else interim += piece;
      }

      if (finalText.trim()) {
        this.handler?.(finalText.trim(), true);
      }
      if (interim.trim()) {
        this.handler?.(interim.trim(), false);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.wanted = false;
      }
    };

    recognition.onend = () => {
      if (!this.wanted || this.muted) return;
      try {
        recognition.start();
      } catch {
        // ignore restart races
      }
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch {
      // already started
    }
  }

  private teardown(): void {
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    }
  }
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

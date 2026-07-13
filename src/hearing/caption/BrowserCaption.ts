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
 * Live mic captions via Web Speech API (temporary until real STT provider).
 * Display-only — PCM still goes to backend through Microphone + Transport.
 */
export class BrowserCaption {
  private recognition: BrowserSpeechRecognition | null = null;
  private handler: CaptionHandler | null = null;
  private wanted = false;

  onCaption(handler: CaptionHandler): void {
    this.handler = handler;
  }

  get supported(): boolean {
    return Boolean(getSpeechRecognitionConstructor());
  }

  start(lang = "vi-VN"): void {
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) {
      throw new Error(
        "Trình duyệt không hỗ trợ Web Speech API (thử Chrome/Edge).",
      );
    }

    this.stop();
    this.wanted = true;

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
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
      // `no-speech` / `aborted` are normal; keep listening if still wanted.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.wanted = false;
      }
    };

    recognition.onend = () => {
      if (!this.wanted) return;
      try {
        recognition.start();
      } catch {
        // ignore restart races
      }
    };

    this.recognition = recognition;
    recognition.start();
  }

  stop(): void {
    this.wanted = false;
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      try {
        recognition.abort();
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

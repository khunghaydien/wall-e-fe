/** Tiny looping silent WAV so Android keeps STREAM_MUSIC / A2DP (YouTube path). */
function silentWavDataUri(): string {
  const sampleRate = 48_000;
  const seconds = 0.4;
  const channels = 2;
  const samples = Math.floor(sampleRate * seconds);
  const dataBytes = samples * channels * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/**
 * Holds the OS on media/A2DP playback (same class as YouTube) so opening the
 * mic is less likely to switch Android into HFP/SCO and drop the speaker.
 */
export class MediaRouteHold {
  private audio: HTMLAudioElement | null = null;

  async start(): Promise<void> {
    if (typeof window === "undefined") return;
    this.stop();
    const el = new Audio();
    el.src = silentWavDataUri();
    el.loop = true;
    el.preload = "auto";
    el.volume = 0.001;
    el.setAttribute("playsinline", "true");
    el.setAttribute("webkit-playsinline", "true");
    this.audio = el;
    try {
      await el.play();
    } catch (error) {
      console.warn("[audio] media route hold failed to play", error);
    }
  }

  stop(): void {
    if (!this.audio) return;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.audio = null;
  }
}

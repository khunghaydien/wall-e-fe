const CAPTION_IDLE_MS = 1200;

/**
 * End-of-utterance from meaningful caption gap.
 * Mic noise / junk captions must NEVER trigger a reply.
 */
export class UtteranceDetector {
  private armed = false;
  private lastCaptionAt = 0;
  private lastCaptionText = "";

  noteCaption(text: string, now = performance.now()): void {
    if (!isMeaningfulCaption(text)) return;

    this.armed = true;
    this.lastCaptionAt = now;
    this.lastCaptionText = text.trim();
  }

  /**
   * @returns true when a meaningful caption went idle long enough.
   * Caller must `reset()` after handling.
   */
  tick(now = performance.now()): boolean {
    if (!this.armed) return false;
    if (now - this.lastCaptionAt < CAPTION_IDLE_MS) return false;
    return isMeaningfulCaption(this.lastCaptionText);
  }

  reset(): void {
    this.armed = false;
    this.lastCaptionAt = 0;
    this.lastCaptionText = "";
  }

  get active(): boolean {
    return this.armed;
  }

  get lastText(): string {
    return this.lastCaptionText;
  }
}

/**
 * "Câu có nghĩa" theo cấu trúc — không dùng blacklist từ.
 * - Ít nhất 2 từ khác nhau (vd. "xin chào"), hoặc
 * - 1 từ đủ dài (>= 6 chữ) (vd. "Jarvis")
 * - Loại lặp rác kiểu "Phẩy. Phẩy."
 */
export function isMeaningfulCaption(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;

  const words = (trimmed.toLocaleLowerCase("vi").match(/\p{L}+/gu) ?? []).filter(
    Boolean,
  );
  if (words.length === 0) return false;

  const unique = [...new Set(words)];
  const letterCount = words.join("").length;

  // Same word repeated → noise loop, not a sentence.
  if (words.length >= 2 && unique.length === 1) return false;

  // Phrase / sentence: ≥ 2 distinct words and some substance.
  if (unique.length >= 2 && letterCount >= 5) return true;

  // Single wake-word style token.
  if (words.length === 1 && words[0]!.length >= 6) return true;

  return false;
}

export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

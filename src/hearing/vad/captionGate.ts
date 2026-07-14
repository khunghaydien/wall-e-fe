/**
 * Caption quality gate + mic energy helpers.
 */

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

  if (words.length >= 2 && unique.length === 1) return false;
  if (unique.length >= 2 && letterCount >= 5) return true;
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

/**
 * Mac speaker → mic bleed helpers.
 * Only drop captions that are clearly the local TTS voice,
 * not normal user questions that share topic words (e.g. "con voi").
 */

function normalize(text: string): string {
  return text
    .toLocaleLowerCase("vi")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordsOf(text: string): string[] {
  return text.match(/\p{L}{2,}/gu) ?? [];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) row[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** ASR often garbles short tokens (ai→rx). Allow small edits. */
function wordsClose(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  const maxDist = a.length <= 3 ? 1 : Math.max(1, Math.floor(a.length / 4));
  return levenshtein(a, b) <= maxDist;
}

function fuzzyOverlapRatio(captionWords: string[], assistantWords: string[]): number {
  if (captionWords.length === 0) return 0;
  let matched = 0;
  for (const w of captionWords) {
    if (assistantWords.some((bw) => wordsClose(w, bw))) matched += 1;
  }
  return matched / captionWords.length;
}

/**
 * Ordered coverage: how many caption words appear in-order in assistant
 * (tolerates ASR typos via wordsClose).
 */
function orderedCoverage(captionWords: string[], assistantWords: string[]): number {
  if (captionWords.length === 0) return 0;
  let bi = 0;
  let hit = 0;
  for (const w of captionWords) {
    while (bi < assistantWords.length) {
      if (wordsClose(w, assistantWords[bi]!)) {
        hit += 1;
        bi += 1;
        break;
      }
      bi += 1;
    }
  }
  return hit / captionWords.length;
}

/**
 * True when caption is (mostly) the assistant TTS leaking in.
 * Conservative: shared topic words alone are NOT enough.
 */
export function looksLikeAssistantEcho(
  caption: string,
  assistant: string,
): boolean {
  const a = normalize(caption);
  const b = normalize(assistant);
  if (!a || !b) return false;
  if (a.length <= 2) return true;

  // Exact / near-exact containment of the whole caption in the reply.
  if (a.length >= 6 && b.includes(a)) return true;
  if (b.length >= 8 && a.includes(b)) return true;

  // Caption is a long contiguous slice of the assistant reply.
  if (a.length >= 12) {
    for (let i = 0; i + a.length <= b.length; i += 1) {
      if (b.slice(i, i + a.length) === a) return true;
    }
  }

  const aWords = wordsOf(a);
  const bWords = wordsOf(b);
  if (aWords.length === 0 || bWords.length === 0) return false;

  const ratio = fuzzyOverlapRatio(aWords, bWords);
  const ordered = orderedCoverage(aWords, bWords);

  // Almost all caption words match assistant (ASR-tolerant).
  // Short topic questions like "con voi ăn gì" must NOT match a long reply
  // that merely repeats "con voi" / "gì".
  if (aWords.length >= 5 && ratio >= 0.75 && a.length >= 16) return true;
  if (aWords.length >= 4 && ratio >= 0.85 && ordered >= 0.75) return true;
  if (aWords.length >= 3 && ratio >= 0.9 && ordered >= 0.9 && a.length >= 14) {
    return true;
  }
  if (aWords.length === 2 && ratio === 1 && ordered === 1 && a.length >= 10) {
    return true;
  }

  // Trailing bleed: mic often catches only the last clause, ASR-garbled.
  // Only for SHORT captions — longer utterances are real user turns.
  if (aWords.length <= 5 && looksLikeTailEcho(aWords, bWords)) return true;

  return false;
}

/**
 * Caption overlaps the ending of the assistant reply (common Mac speaker bleed).
 * Looser than full-reply match — only safe right after TTS.
 */
function looksLikeTailEcho(captionWords: string[], assistantWords: string[]): boolean {
  if (captionWords.length < 2 || assistantWords.length < 3) return false;

  const tailLen = Math.min(
    assistantWords.length,
    Math.max(10, captionWords.length + 6),
  );
  const tail = assistantWords.slice(-tailLen);
  const ratio = fuzzyOverlapRatio(captionWords, tail);
  const ordered = orderedCoverage(captionWords, tail);

  if (captionWords.length >= 2 && ratio >= 0.65 && ordered >= 0.5) return true;
  if (captionWords.length >= 3 && ratio >= 0.6) return true;
  return false;
}

/**
 * Remove assistant phrases from a caption so "user + Chào bạn" → "user".
 */
export function stripAssistantEcho(
  caption: string,
  assistant: string,
): string {
  if (!assistant.trim()) return caption.trim();

  let out = caption;
  const chunks = assistant
    .split(/[.!?…,\n]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
    .sort((x, y) => y.length - x.length);

  for (const chunk of chunks) {
    const re = new RegExp(escapeRegExp(chunk), "giu");
    out = out.replace(re, " ");
  }

  // Drop long fuzzy n-gram spans that still look like assistant bleed
  // (e.g. "một trợ giảng rx giúp bạn" vs "...trợ giảng AI giúp bạn...").
  const assistantWords = wordsOf(normalize(assistant));
  const tokens = out.match(/\S+/gu) ?? [];
  if (tokens.length >= 3 && assistantWords.length >= 3) {
    const keep = tokens.map(() => true);
    const tokenWords = tokens.map((t) => wordsOf(normalize(t))[0] ?? "");

    for (let i = 0; i < tokens.length; i += 1) {
      for (let len = tokens.length - i; len >= 3; len -= 1) {
        const span = tokenWords.slice(i, i + len).filter(Boolean);
        if (span.length < 3) continue;
        if (orderedCoverage(span, assistantWords) < 0.75) continue;
        for (let k = i; k < i + len; k += 1) keep[k] = false;
        break;
      }
    }

    out = tokens.filter((_, i) => keep[i]).join(" ");
  }

  return out.replace(/\s+/g, " ").trim();
}

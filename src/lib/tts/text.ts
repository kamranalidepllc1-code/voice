// Text utilities shared by the browser and the server.
// Kept dependency-free (no imports) so it can be unit-tested directly with Node.

const hasSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";

/** Normalizes line endings and strips control characters (except tab/newline). */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

/**
 * Counts words. Uses Intl.Segmenter when available so languages written
 * without spaces (Chinese, Japanese, Thai...) are counted sensibly; falls back
 * to whitespace splitting otherwise.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (hasSegmenter) {
    let count = 0;
    for (const seg of new Intl.Segmenter(undefined, { granularity: "word" }).segment(trimmed)) {
      if (seg.isWordLike) count++;
    }
    return count;
  }
  return trimmed.split(/\s+/).length;
}

/** Character count in Unicode code points (what users perceive as characters). */
export function countChars(text: string): number {
  let n = 0;
  for (const _ of text) n++; // eslint-disable-line @typescript-eslint/no-unused-vars
  return n;
}

function splitSentences(paragraph: string): string[] {
  if (hasSegmenter) {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(paragraph),
      (s) => s.segment,
    );
  }
  return paragraph.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’)\]]*\s*|$)/g) ?? [paragraph];
}

/** Hard-splits a single oversized piece, preferring whitespace, never mid code point. */
function splitOversized(piece: string, maxChars: number): string[] {
  const out: string[] = [];
  const words = piece.split(/(?<=\s)/); // keep whitespace attached to the preceding word
  let current = "";
  for (const word of words) {
    if (countChars(current + word) <= maxChars) {
      current += word;
      continue;
    }
    if (current) out.push(current);
    current = "";
    if (countChars(word) <= maxChars) {
      current = word;
    } else {
      const cps = Array.from(word);
      for (let i = 0; i < cps.length; i += maxChars) {
        const slice = cps.slice(i, i + maxChars).join("");
        if (countChars(slice) === maxChars) out.push(slice);
        else current = slice;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Splits text into chunks of at most `maxChars` code points, preferring
 * paragraph boundaries, then sentence boundaries, then word boundaries.
 * Order is preserved and no non-whitespace content is ever dropped.
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  if (maxChars < 1) throw new Error("maxChars must be positive");
  const normalized = normalizeText(text);
  if (!normalized) return [];

  // Break the text into the smallest "units" needed so each fits in maxChars.
  const units: { text: string; paragraphStart: boolean }[] = [];
  for (const paragraph of normalized.split(/\n\s*\n/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (countChars(p) <= maxChars) {
      units.push({ text: p, paragraphStart: true });
      continue;
    }
    let first = true;
    for (const sentence of splitSentences(p)) {
      if (!sentence.trim()) continue;
      const pieces = countChars(sentence) <= maxChars ? [sentence] : splitOversized(sentence, maxChars);
      for (const piece of pieces) {
        units.push({ text: piece, paragraphStart: first });
        first = false;
      }
    }
  }

  // Greedily pack units into chunks.
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const sep = current ? (unit.paragraphStart ? "\n\n" : "") : "";
    const candidate = current + sep + unit.text;
    if (countChars(candidate.trim()) <= maxChars) {
      current = candidate;
    } else {
      if (current.trim()) chunks.push(current.trim());
      current = unit.text;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

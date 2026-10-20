import {
  CHUNK_CHARS,
  ESTIMATED_CHARS_PER_SECOND,
  MAX_CHARS,
  MAX_WORDS,
  estimatePaidCostUsd,
  type TtsPlanResponse,
} from "@/lib/tts/config";
import { countChars, countWords, normalizeText, splitIntoChunks } from "@/lib/tts/text";
import { TtsError, assertSameOrigin, clientIp, errorResponse, readJsonBody } from "@/lib/tts/server/http";
import { checkRequestRate } from "@/lib/tts/server/rate-limit";

// Worst case: MAX_CHARS of 4-byte characters, JSON-escaped, plus options.
const MAX_BODY_BYTES = MAX_CHARS * 6 + 4096;

/**
 * Validates the full text server-side (word/char limits) and splits it into
 * ordered chunks at paragraph/sentence boundaries. No provider call is made.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    checkRequestRate(clientIp(request));

    const body = (await readJsonBody(request, MAX_BODY_BYTES)) as { text?: unknown };
    if (typeof body?.text !== "string") throw new TtsError("invalid_input", 400, "Please enter some text.");

    const text = normalizeText(body.text);
    if (!text) throw new TtsError("invalid_input", 400, "Please enter some text.");

    const words = countWords(text);
    const chars = countChars(text);
    if (words > MAX_WORDS) {
      throw new TtsError("too_long", 413, `Text is ${words.toLocaleString("en-US")} words; the limit is ${MAX_WORDS.toLocaleString("en-US")}.`);
    }
    if (chars > MAX_CHARS) {
      throw new TtsError("too_long", 413, `Text is ${chars.toLocaleString("en-US")} characters; the limit is ${MAX_CHARS.toLocaleString("en-US")}.`);
    }

    const chunks = splitIntoChunks(text, CHUNK_CHARS);
    const plan: TtsPlanResponse = {
      chunks,
      words,
      chars,
      estimatedPaidCostUsd: estimatePaidCostUsd(chars),
      estimatedSeconds: Math.round(chars / ESTIMATED_CHARS_PER_SECOND),
    };
    return Response.json(plan, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

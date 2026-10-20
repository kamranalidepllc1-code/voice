import { AUDIO_MIME, CHUNK_CHARS, findVoice } from "@/lib/tts/config";
import { countChars, normalizeText } from "@/lib/tts/text";
import { TtsError, assertSameOrigin, clientIp, errorResponse, readJsonBody } from "@/lib/tts/server/http";
import { reserveSynthesis } from "@/lib/tts/server/rate-limit";
import { synthesize } from "@/lib/tts/server/gemini";

// One request synthesizes one ≤3,000-char part (~3–4 min of audio). Generation
// can take a while, so allow up to 5 minutes; long texts are a sequence of these.
export const maxDuration = 300;

const MAX_BODY_BYTES = 32 * 1024;

export async function POST(request: Request) {
  let release: ((opts?: { refund?: boolean }) => void) | undefined;
  try {
    assertSameOrigin(request);
    const body = (await readJsonBody(request, MAX_BODY_BYTES)) as Record<string, unknown>;

    if (typeof body.text !== "string") throw new TtsError("invalid_input", 400, "Text is required.");
    const text = normalizeText(body.text);
    if (!text) throw new TtsError("invalid_input", 400, "Text is required.");
    const chars = countChars(text);
    if (chars > CHUNK_CHARS) {
      throw new TtsError("too_long", 413, "This section is too long. Please generate again.");
    }

    const voice = findVoice(typeof body.voice === "string" ? body.voice : "");
    if (!voice) throw new TtsError("invalid_voice", 400, "The selected voice is not available.");

    release = reserveSynthesis(clientIp(request), chars);
    let wav: Uint8Array;
    try {
      wav = await synthesize(text, voice.id, request.signal);
    } catch (err) {
      release({ refund: true });
      throw err;
    }
    release();

    return new Response(wav as BodyInit, {
      headers: {
        "Content-Type": AUDIO_MIME,
        "Content-Length": String(wav.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    release?.();
    return errorResponse(err);
  }
}

import "server-only";
import { mergeWav, pcm16ToWav } from "../audio";
import { TtsError } from "./http";

// Official endpoint: POST {base}/models/{model}:generateContent with AUDIO output.
// Docs: https://ai.google.dev/gemini-api/docs/speech-generation
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-3.8-flash-tts";

/** A provider 429 asking us to wait longer than this is treated as a quota (daily) limit. */
const MAX_TRANSIENT_RETRY_AFTER_S = 120;

function baseUrl(): string {
  return (process.env.GEMINI_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function model(): string {
  return process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL;
}

export function isConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("[tts] GEMINI_API_KEY is not set");
    throw new TtsError("not_configured", 503, "Text-to-speech is not configured on this server.");
  }
  return key;
}

function timeoutMs(): number {
  const v = Number(process.env.GEMINI_TTS_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 240_000;
}

interface GoogleErrorDetail {
  "@type"?: string;
  reason?: string;
  retryDelay?: string;
  violations?: { quotaId?: string }[];
}

interface GoogleError {
  error?: { code?: number; status?: string; message?: string; details?: GoogleErrorDetail[] };
}

function minutes(s: number): string {
  if (s < 90) return `${s} seconds`;
  if (s < 5400) return `${Math.ceil(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

/** Turns an upstream failure into a safe, user-facing error (no provider details leak). */
async function mapProviderError(res: Response): Promise<TtsError> {
  let err: GoogleError["error"] = {};
  try {
    err = ((await res.json()) as GoogleError).error ?? {};
  } catch {
    /* non-JSON error body */
  }
  const details = err.details ?? [];
  const reason = details.find((d) => d.reason)?.reason ?? "";
  // Log status + error status/reason only; messages can echo user input.
  console.error(`[tts] Gemini responded ${res.status} ${err.status ?? ""} ${reason}`.trim());

  if (reason === "API_KEY_INVALID" || /api key not valid/i.test(err.message ?? "")) {
    return new TtsError("not_configured", 503, "The voice service API key is invalid. Please check GEMINI_API_KEY.");
  }
  if (/location is not supported/i.test(err.message ?? "")) {
    return new TtsError("not_configured", 503, "The Gemini API is not available in this server's region.");
  }

  if (res.status === 429) {
    const delay = details.find((d) => d.retryDelay)?.retryDelay;
    const retryAfter = delay ? Math.max(1, Math.ceil(parseFloat(delay))) : undefined;
    const quotaIds = details.flatMap((d) => d.violations ?? []).map((v) => v.quotaId ?? "");
    const daily = quotaIds.some((id) => /PerDay/i.test(id));
    if (daily || (retryAfter && retryAfter > MAX_TRANSIENT_RETRY_AFTER_S)) {
      return new TtsError(
        "provider_quota",
        429,
        `The Gemini daily quota for this API key has been used up. Completed parts are kept — try again ${
          retryAfter && !daily ? `in about ${minutes(retryAfter)}` : "tomorrow (quotas reset at midnight Pacific time)"
        }, or enable billing for higher limits.`,
        false,
        retryAfter,
      );
    }
    return new TtsError("rate_limited", 429, "The voice service is busy. Waiting to retry…", true, retryAfter ?? 20);
  }

  switch (res.status) {
    case 400:
      return new TtsError("provider_rejected", 400, "The voice service could not process this text.");
    case 401:
    case 403:
      return new TtsError("not_configured", 503, "The voice service rejected the API key. Please check GEMINI_API_KEY and that the Gemini API is enabled.");
    case 404:
      return new TtsError("not_configured", 503, "The configured Gemini TTS model is not available for this API key.");
    case 504:
      return new TtsError("timeout", 504, "The voice service took too long to respond. Please try again.", true);
    default:
      return new TtsError("provider_error", 502, "The voice service had a problem. Please try again.", true);
  }
}

interface GenerateContentResponse {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
  }[];
  promptFeedback?: { blockReason?: string };
}

/** Normalizes one inline audio part (WAV or raw L16 PCM) to WAV. */
function toWav(mimeType: string, bytes: Uint8Array): Uint8Array {
  const type = mimeType.toLowerCase();
  const isRiff = bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF";
  if (type.includes("wav") || isRiff) return bytes;
  if (type.includes("l16") || type.includes("pcm")) {
    const rate = Number(type.match(/rate=(\d+)/)?.[1]) || 24000;
    return pcm16ToWav(bytes, rate);
  }
  throw new TtsError("provider_error", 502, "The voice service returned an unsupported audio format.", true);
}

/** Synthesizes one chunk; returns a complete WAV file. */
export async function synthesize(text: string, voice: string, signal?: AbortSignal): Promise<Uint8Array> {
  const key = apiKey();
  const timeout = AbortSignal.timeout(timeoutMs());
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res: Response;
  let json: GenerateContentResponse;
  try {
    res = await fetch(`${baseUrl()}/models/${encodeURIComponent(model())}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
      signal: combined,
      cache: "no-store",
    });
    if (!res.ok) throw await mapProviderError(res);
    json = (await res.json()) as GenerateContentResponse;
  } catch (err) {
    if (err instanceof TtsError) throw err;
    throw toNetworkError(err, timeout);
  }

  if (json.promptFeedback?.blockReason) {
    console.error(`[tts] Gemini blocked prompt: ${json.promptFeedback.blockReason}`);
    throw new TtsError("provider_rejected", 400, "The voice service declined to read part of this text.");
  }
  const candidate = json.candidates?.[0];
  const parts = (candidate?.content?.parts ?? []).filter((p) => p.inlineData?.data);
  if (!parts.length) {
    const reason = candidate?.finishReason ?? "none";
    console.error(`[tts] Gemini returned no audio (finishReason=${reason})`);
    if (/SAFETY|PROHIBITED|BLOCKLIST|SPII/i.test(reason)) {
      throw new TtsError("provider_rejected", 400, "The voice service declined to read part of this text.");
    }
    // Occasional empty/"OTHER" responses are transient; let the client retry.
    throw new TtsError("provider_error", 502, "The voice service returned no audio. Retrying may help.", true);
  }

  const wavs = parts.map((p) => toWav(p.inlineData!.mimeType ?? "", new Uint8Array(Buffer.from(p.inlineData!.data!, "base64"))));
  return wavs.length === 1 ? wavs[0] : mergeWav(wavs);
}

function toNetworkError(err: unknown, timeout: AbortSignal): TtsError {
  if (timeout.aborted) {
    return new TtsError("timeout", 504, "The voice service took too long to respond. Please try again.", true);
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new TtsError("internal_error", 499, "Request cancelled.", false);
  }
  console.error("[tts] network error:", err instanceof Error ? err.message : typeof err);
  return new TtsError("provider_error", 502, "Could not reach the voice service. Please try again.", true);
}

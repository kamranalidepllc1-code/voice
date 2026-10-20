// Shared (client + server) TTS configuration for the Gemini API text-to-speech models.
// Verified against https://ai.google.dev/gemini-api/docs/speech-generation (Oct 2026).

/** Product limit for one generation. */
export const MAX_WORDS = 4000;
/** Safety cap on characters so 4,000 very long "words" can't explode cost. */
export const MAX_CHARS = 40_000;

/**
 * Gemini TTS models accept 8,192 input tokens and 16,384 output tokens per
 * request (audio is ~25 tokens/s, so ~10 min max). 3,000 chars ≈ 3–4 min of
 * speech keeps each request comfortably inside both limits while using few
 * requests — important because free-tier daily request quotas are small.
 */
export const CHUNK_CHARS = 3000;

/** Merged output: 24 kHz, 16-bit, mono WAV (Gemini's native TTS output). */
export const AUDIO_MIME = "audio/wav";

/** Rough narration speed used only for duration estimates. */
export const ESTIMATED_CHARS_PER_SECOND = 15;

/** Paid-tier pricing for gemini-3.8-flash-tts through Dec 31, 2026 (USD per 1M tokens). */
export const PRICE_INPUT_PER_MILLION_TOKENS = 0.5;
export const PRICE_AUDIO_OUTPUT_PER_MILLION_TOKENS = 9;
const AUDIO_TOKENS_PER_SECOND = 25;
const CHARS_PER_TEXT_TOKEN = 4;

export interface Voice {
  id: string;
  /** Google's one-word descriptor for the voice. */
  style: string;
}

/** Prebuilt voices listed in the Gemini speech-generation docs. */
export const VOICES: Voice[] = [
  { id: "Kore", style: "Firm" },
  { id: "Puck", style: "Upbeat" },
  { id: "Charon", style: "Informative" },
  { id: "Zephyr", style: "Bright" },
  { id: "Fenrir", style: "Excitable" },
  { id: "Leda", style: "Youthful" },
  { id: "Orus", style: "Firm" },
  { id: "Aoede", style: "Breezy" },
  { id: "Callirrhoe", style: "Easy-going" },
  { id: "Autonoe", style: "Bright" },
  { id: "Enceladus", style: "Breathy" },
  { id: "Iapetus", style: "Clear" },
  { id: "Umbriel", style: "Easy-going" },
  { id: "Algieba", style: "Smooth" },
  { id: "Despina", style: "Smooth" },
  { id: "Erinome", style: "Clear" },
  { id: "Algenib", style: "Gravelly" },
  { id: "Rasalgethi", style: "Informative" },
  { id: "Laomedeia", style: "Upbeat" },
  { id: "Achernar", style: "Soft" },
  { id: "Alnilam", style: "Firm" },
  { id: "Schedar", style: "Even" },
  { id: "Gacrux", style: "Mature" },
  { id: "Pulcherrima", style: "Forward" },
  { id: "Achird", style: "Friendly" },
  { id: "Zubenelgenubi", style: "Casual" },
  { id: "Vindemiatrix", style: "Gentle" },
  { id: "Sadachbia", style: "Lively" },
  { id: "Sadaltager", style: "Knowledgeable" },
  { id: "Sulafat", style: "Warm" },
];
export const DEFAULT_VOICE = "Kore";

export function findVoice(id: string): Voice | undefined {
  const lower = id.toLowerCase();
  return VOICES.find((v) => v.id.toLowerCase() === lower);
}

/** Estimated cost on the paid tier (the free tier charges nothing, within its quotas). */
export function estimatePaidCostUsd(chars: number): number {
  const inputTokens = chars / CHARS_PER_TEXT_TOKEN;
  const outputTokens = (chars / ESTIMATED_CHARS_PER_SECOND) * AUDIO_TOKENS_PER_SECOND;
  return (inputTokens * PRICE_INPUT_PER_MILLION_TOKENS + outputTokens * PRICE_AUDIO_OUTPUT_PER_MILLION_TOKENS) / 1_000_000;
}

/** Error codes returned by the API routes (stable, safe to show). */
export type TtsErrorCode =
  | "invalid_input"
  | "too_long"
  | "invalid_voice"
  | "payload_too_large"
  | "forbidden"
  | "rate_limited"
  | "provider_quota"
  | "daily_budget_exceeded"
  | "not_configured"
  | "provider_rejected"
  | "provider_error"
  | "timeout"
  | "internal_error";

export interface TtsErrorBody {
  error: { code: TtsErrorCode; message: string; retryable: boolean };
}

export interface TtsPlanResponse {
  chunks: string[];
  words: number;
  chars: number;
  estimatedPaidCostUsd: number;
  estimatedSeconds: number;
}

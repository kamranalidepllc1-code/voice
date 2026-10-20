# Text to Speech (Gemini TTS)

Next.js 16 (App Router, TypeScript, Tailwind) app that turns up to **4,000 words** into narration with the
Google Gemini API text-to-speech models (`gemini-3.8-flash-tts` by default), with playback and download.

## Setup

```bash
npm install
cp .env.example .env.local   # then set GEMINI_API_KEY (from https://aistudio.google.com/apikey)
npm run dev                  # http://localhost:3000
```

`GEMINI_API_KEY` is read only on the server. Never prefix it with `NEXT_PUBLIC_`, and never commit `.env.local`
(`.gitignore` already excludes `.env*` except `.env.example`). See `.env.example` for optional settings.

## How it works

```
Browser                                   Next.js server                    Gemini API
───────                                   ──────────────                    ──────────
POST /api/tts/plan {text}  ─────────────▶ validate ≤4,000 words / 40k chars,
                           ◀───────────── split at paragraph → sentence → word
                                          boundaries into ≤4,500-char parts
for each part (one at a time, ≥21 s apart):
POST /api/tts {text, voice} ────────────▶ validate, rate-limit ──▶ POST models/{model}:generateContent
                           ◀──────────── WAV (PCM wrapped)    ◀── base64 audio (L16 PCM or WAV)
merge parts in the browser → one WAV → <audio> player + Download
```

- **Few, large requests:** Gemini TTS accepts 8,192 input tokens and returns up to 16,384 audio tokens
  (~10 min) per request. Parts of ≤4,500 chars (~5 min of audio) stay safely inside both, so a typical
  4,000-word text needs about 6 requests. This matters because free-tier daily request quotas are small.
- **Model fallback:** free-tier quotas are counted per model. When one model's daily quota is used up, the
  server switches to the next model in `GEMINI_TTS_MODELS` (default: `gemini-3.8-flash-tts` →
  `gemini-3.8-flash-lite-tts` → `gemini-2.5-flash-preview-tts`). It skips exhausted or unavailable models
  until the quota resets. Different models can sound slightly different, even with the same voice.
- **Merging:** each part becomes a 24 kHz mono 16-bit WAV, and the parts are joined under one RIFF header.
- **Reliability:** per-minute rate limits (429 with a short `retryDelay`) are waited out automatically, with a
  countdown in the UI. 5xx errors, timeouts and the occasional empty response are retried with backoff. A
  **daily quota** error stops the job, keeps finished parts, and **Retry failed parts** continues later.
  Safety-blocked text is reported, not retried.
- **Never truncates:** text over the limit is rejected with a clear message.

| Route | Purpose |
|---|---|
| `GET /api/tts/voices` | The 30 documented prebuilt voices + whether a key is configured |
| `POST /api/tts/plan` | Authoritative validation + chunking; also returns a paid-tier cost estimate |
| `POST /api/tts` | Synthesizes one part; returns `audio/wav` |

**Security and abuse protection:** same-origin check, JSON-only bodies with byte caps, server-side validation
of text and voice, and per-IP limits (requests/min, concurrent requests, characters/hour) plus a global daily
character budget. Provider errors map to safe messages. Logs record only status codes, never text or keys.

## Testing

```bash
npm test                                   # unit: chunking, word counts, WAV merging, PCM→WAV
npm run test:mock-gemini                   # terminal 1: mock Gemini API on :4012
npm run build
GEMINI_API_KEY=test-key GEMINI_API_BASE_URL=http://127.0.0.1:4012/v1beta GEMINI_TTS_TIMEOUT_MS=3000 npx next start -p 3100   # terminal 2
npm run test:integration -- http://localhost:3100                                                                              # terminal 3
```

The integration suite covers:
- short, ~1,000-word and 4,000-word texts, plus over-limit, empty and whitespace input;
- Unicode, punctuation and numbers;
- L16 and WAV responses;
- invalid voices, oversized bodies and cross-origin requests;
- empty and safety-blocked responses;
- provider 500, per-minute 429, daily quota and timeout;
- retry after partial failure, and rate limiting.

## Deployment (e.g. Vercel)

1. Set `GEMINI_API_KEY` (and any optional limits) in the project's environment variables.
2. `/api/tts` declares `maxDuration = 300`; each part usually takes well under a minute.
3. **Response size:** a 4,500-char part is ~5 min of WAV (~14 MB). Platforms with a small response-body
   cap (Vercel: 4.5 MB for non-streamed responses) need a smaller `CHUNK_CHARS` in `src/lib/tts/config.ts`
   (e.g. 1,200), at the cost of more requests.
4. The rate limits are **in memory, per instance**. On multi-instance/serverless hosting, move them to a shared
   store (e.g. Upstash Redis) for strict enforcement.

## Gemini API facts used (verified October 2026)

- `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent`, header
  `x-goog-api-key`. Body: `contents[].parts[].text` and
  `generationConfig.responseModalities: ["AUDIO"]`.
  Voice goes in `generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
- 30 prebuilt voices (Kore, Puck, Charon, Zephyr, …). The language is detected automatically, and the model
  supports 130 languages.
- **Free tier:** input and output are free, **but Google may use free-tier data to improve its products**, and
  the daily request quotas are small (per model). Check yours in AI Studio. A 4,000-word text takes ~6 requests.
- **Paid tier** (gemini-3.8-flash-tts, through Dec 31, 2026): $0.50 per 1M input tokens and $9.00 per 1M audio
  output tokens (~25 tokens per second). 4,000 words ≈ 27 min of audio ≈ **$0.37**.

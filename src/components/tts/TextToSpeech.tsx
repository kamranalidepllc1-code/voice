"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AUDIO_MIME,
  CHUNK_CHARS,
  DEFAULT_VOICE,
  ESTIMATED_CHARS_PER_SECOND,
  MAX_CHARS,
  MAX_WORDS,
  VOICES,
  estimatePaidCostUsd,
  type TtsErrorBody,
  type TtsPlanResponse,
} from "@/lib/tts/config";
import { countChars, countWords, normalizeText, splitIntoChunks } from "@/lib/tts/text";
import { mergeWav } from "@/lib/tts/audio";

type SegmentStatus = "pending" | "working" | "done" | "failed";
interface Segment {
  text: string;
  status: SegmentStatus;
  error?: string;
  url?: string;
  blob?: Blob;
}
type JobStatus = "idle" | "planning" | "generating" | "merging" | "done" | "partial" | "error";
interface Options {
  voice: string;
}

/**
 * Gemini's free tier allows 3 requests per minute per model, and rejected
 * requests still count toward the 10-per-day quota. So requests go one at a
 * time and at least 21 s apart, instead of bursting and hitting the limit.
 */
const CONCURRENCY = 1;
const MIN_REQUEST_INTERVAL_MS = 21_000;
/** Attempts for transient failures (5xx, timeouts, network). */
const MAX_ATTEMPTS = 3;
/** Provider rate-limit waits allowed per part before giving up (each ≤ ~2 min). */
const MAX_RATE_LIMIT_WAITS = 15;
/** Errors where continuing with the remaining parts is pointless. */
const FATAL_CODES = new Set([
  "not_configured",
  "provider_quota",
  "invalid_voice",
  "daily_budget_exceeded",
  "forbidden",
  "invalid_input",
]);

class RequestError extends Error {
  constructor(message: string, public code: string, public retryable: boolean, public retryAfter?: number) {
    super(message);
  }
}

async function toRequestError(res: Response): Promise<RequestError> {
  const retryAfter = Number(res.headers.get("retry-after")) || undefined;
  try {
    const body = (await res.json()) as TtsErrorBody;
    if (body?.error?.message) return new RequestError(body.error.message, body.error.code, body.error.retryable, retryAfter);
  } catch {
    /* non-JSON error (e.g. platform timeout page) */
  }
  const retryable = res.status === 429 || res.status >= 500;
  return new RequestError(
    res.status === 504 ? "The request timed out. Please try again." : `Request failed (${res.status}).`,
    res.status === 504 ? "timeout" : "http_error",
    retryable,
    retryAfter,
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))), { once: true });
  });
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUsd(n: number): string {
  return n < 0.01 ? "< $0.01" : `$${n.toFixed(2)}`;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export default function TextToSpeech() {
  const [text, setText] = useState("");
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  const [options, setOptions] = useState<Options>({ voice: DEFAULT_VOICE });
  const [status, setStatus] = useState<JobStatus>("idle");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [waitReason, setWaitReason] = useState("");
  const [now, setNow] = useState(0);
  const [result, setResult] = useState<{ url: string; size: number } | null>(null);
  const [showParts, setShowParts] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const jobOptionsRef = useRef<Options | null>(null);
  // Generated audio keyed by (options + chunk text): avoids paying twice for identical requests.
  const cacheRef = useRef(new Map<string, Blob>());
  const urlsRef = useRef<string[]>([]);
  // When the last /api/tts request started (for client-side pacing).
  const lastRequestAtRef = useRef(0);

  const busy = status === "planning" || status === "generating" || status === "merging";

  // ---- live counters / estimates -------------------------------------------------
  const deferredText = useDeferredValue(text);
  const stats = useMemo(() => {
    const normalized = normalizeText(deferredText);
    const chars = countChars(normalized);
    return {
      chars,
      parts: normalized ? splitIntoChunks(normalized, CHUNK_CHARS).length : 0,
      paidCost: estimatePaidCostUsd(chars),
      seconds: chars / ESTIMATED_CHARS_PER_SECOND,
    };
  }, [deferredText]);
  const liveWords = useMemo(() => countWords(text), [text]);
  const liveChars = useMemo(() => countChars(text), [text]);
  const overLimit = liveWords > MAX_WORDS || liveChars > MAX_CHARS;
  const empty = !text.trim();

  // ---- configuration status -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    fetch("/api/tts/voices")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { configured: boolean }) => {
        if (!cancelled && !data.configured) {
          setConfigNotice("Text-to-speech is not configured on this server (missing GEMINI_API_KEY).");
        }
      })
      .catch(() => {
        /* non-critical: errors surface when generating */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Countdown ticker while waiting on a provider rate limit.
  useEffect(() => {
    if (!waitUntil) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waitUntil]);

  // ---- object URL hygiene ---------------------------------------------------------
  const trackUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    return url;
  };
  const revokeAll = () => {
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
  };
  useEffect(() => () => {
    abortRef.current?.abort();
    revokeAll();
  }, []);

  // ---- generation -----------------------------------------------------------------
  const synthesizeChunk = useCallback(async (chunk: string, opts: Options, signal: AbortSignal): Promise<Blob> => {
    const key = JSON.stringify([opts, chunk]);
    const cached = cacheRef.current.get(key);
    if (cached) return cached;

    const wait = async (ms: number, reason: string) => {
      setNow(Date.now());
      setWaitUntil(Date.now() + ms);
      setWaitReason(reason);
      try {
        await sleep(ms, signal);
      } finally {
        setWaitUntil(null);
      }
    };

    let attempts = 0;
    let rateLimitWaits = 0;
    for (;;) {
      // Pace requests to stay under the provider's per-minute limit.
      const gap = lastRequestAtRef.current + MIN_REQUEST_INTERVAL_MS - Date.now();
      if (gap > 0) await wait(gap, "pacing for the 3-requests-per-minute limit");
      lastRequestAtRef.current = Date.now();
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: chunk, ...opts }),
          signal,
        });
        if (!res.ok) throw await toRequestError(res);
        const type = res.headers.get("content-type") ?? "";
        if (!type.startsWith("audio/")) throw new RequestError("Unexpected response from server.", "bad_response", true);
        const blob = await res.blob();
        if (blob.size === 0) throw new RequestError("Received empty audio.", "bad_response", true);
        cacheRef.current.set(key, blob);
        return blob;
      } catch (err) {
        if (signal.aborted) throw err;
        const e =
          err instanceof RequestError ? err : new RequestError("Network error. Check your connection.", "network", true);
        if (!e.retryable) throw e;

        // Rate limits are expected with long texts: wait as instructed, without
        // counting it as a failed attempt.
        if (e.code === "rate_limited" && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
          rateLimitWaits++;
          await wait(Math.min((e.retryAfter ?? 20) * 1000, 120_000) + Math.random() * 1000, "rate limit reached");
          continue;
        }
        if (++attempts >= MAX_ATTEMPTS) throw e;
        await sleep(1500 * 2 ** (attempts - 1) + Math.random() * 500, signal);
      }
    }
  }, []);

  const finish = useCallback(async (segs: Segment[]) => {
    if (segs.some((s) => s.status !== "done")) {
      setStatus("partial");
      return;
    }
    setStatus("merging");
    try {
      const buffers = await Promise.all(segs.map(async (s) => new Uint8Array(await s.blob!.arrayBuffer())));
      const blob = new Blob([mergeWav(buffers) as BlobPart], { type: AUDIO_MIME });
      setResult({ url: trackUrl(blob), size: blob.size });
      setStatus("done");
    } catch {
      // Merging failed (unexpected format) — the individual parts remain playable/downloadable.
      setError("Couldn't combine the audio parts into one file. You can play or download each part below.");
      setShowParts(true);
      setStatus("partial");
    }
  }, []);

  const runSegments = useCallback(
    async (initial: Segment[], indices: number[], opts: Options) => {
      const controller = new AbortController();
      abortRef.current = controller;
      const segs = initial.map((s) => ({ ...s }));
      const update = (i: number, patch: Partial<Segment>) => {
        segs[i] = { ...segs[i], ...patch };
        setSegments([...segs]);
      };
      for (const i of indices) segs[i] = { ...segs[i], status: "pending", error: undefined };
      setSegments([...segs]);
      setStatus("generating");

      const queue = [...indices];
      let fatal: string | null = null;
      const worker = async () => {
        while (queue.length && !fatal && !controller.signal.aborted) {
          const i = queue.shift()!;
          update(i, { status: "working" });
          try {
            const blob = await synthesizeChunk(segs[i].text, opts, controller.signal);
            update(i, { status: "done", blob, url: trackUrl(blob) });
          } catch (err) {
            if (controller.signal.aborted) {
              update(i, { status: "failed", error: "Cancelled" });
              return;
            }
            const e = err instanceof RequestError ? err : new RequestError("Generation failed.", "unknown", true);
            update(i, { status: "failed", error: e.message });
            if (FATAL_CODES.has(e.code)) fatal = e.message;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, indices.length) }, worker));

      // Anything never started (fatal error / cancel) is marked failed so it can be retried.
      for (let i = 0; i < segs.length; i++) {
        if (segs[i].status === "pending" || segs[i].status === "working") {
          segs[i] = { ...segs[i], status: "failed", error: controller.signal.aborted ? "Cancelled" : "Not generated" };
        }
      }
      setSegments([...segs]);
      abortRef.current = null;

      if (controller.signal.aborted) {
        setError("Generation cancelled. Completed parts are kept — retry to finish the rest.");
        setStatus("partial");
        return;
      }
      const failed = segs.filter((s) => s.status === "failed").length;
      if (failed) {
        setError(
          fatal ??
            `${failed} of ${segs.length} part${segs.length > 1 ? "s" : ""} failed. Completed parts are kept — retry to generate only the missing ones.`,
        );
      }
      await finish(segs);
    },
    [finish, synthesizeChunk],
  );

  const generate = useCallback(async () => {
    if (busyRef.current || empty || overLimit) return;
    busyRef.current = true;
    try {
      setError(null);
      setResult(null);
      setShowParts(false);
      revokeAll();
      setStatus("planning");

      const opts = { ...options };
      jobOptionsRef.current = opts;
      const res = await fetch("/api/tts/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => null);
      if (!res) throw new RequestError("Network error. Check your connection.", "network", true);
      if (!res.ok) throw await toRequestError(res);
      const plan = (await res.json()) as TtsPlanResponse;

      // Keep only cached audio that this job can reuse, so memory stays bounded.
      const keep = new Set(plan.chunks.map((c) => JSON.stringify([opts, c])));
      for (const key of cacheRef.current.keys()) if (!keep.has(key)) cacheRef.current.delete(key);

      const segs: Segment[] = plan.chunks.map((t) => ({ text: t, status: "pending" }));
      await runSegments(segs, segs.map((_, i) => i), opts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    } finally {
      busyRef.current = false;
    }
  }, [empty, overLimit, options, runSegments, text]);

  const retryFailed = useCallback(async () => {
    const opts = jobOptionsRef.current;
    if (busyRef.current || !opts) return;
    busyRef.current = true;
    try {
      setError(null);
      const failed = segments.map((s, i) => (s.status === "done" ? -1 : i)).filter((i) => i >= 0);
      await runSegments(segments, failed, opts);
    } finally {
      busyRef.current = false;
    }
  }, [runSegments, segments]);

  const cancel = () => abortRef.current?.abort();

  const reset = () => {
    abortRef.current?.abort();
    revokeAll();
    setSegments([]);
    setResult(null);
    setError(null);
    setStatus("idle");
  };

  // ---- render ---------------------------------------------------------------------
  const doneCount = segments.filter((s) => s.status === "done").length;
  const progress = segments.length ? Math.round((doneCount / segments.length) * 100) : 0;
  const canRetry = (status === "partial" || status === "error") && segments.some((s) => s.status !== "done");
  const waitSeconds = waitUntil ? Math.max(0, Math.ceil((waitUntil - now) / 1000)) : 0;

  const fieldClass =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400/40 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
  const primaryBtn =
    "inline-flex h-11 items-center justify-center gap-2 rounded-full bg-foreground px-6 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-[#ccc]";
  const secondaryBtn =
    "inline-flex h-11 items-center justify-center gap-2 rounded-full border border-black/[.08] px-5 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-[#1a1a1a]";

  return (
    <section className="flex w-full flex-col gap-6">
      {configNotice && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
          {configNotice}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor="tts-text" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Text
        </label>
        <textarea
          id="tts-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          rows={14}
          placeholder="Paste or type up to 4,000 words…"
          aria-describedby="tts-counter"
          aria-invalid={overLimit}
          dir="auto"
          className={`${fieldClass} min-h-64 resize-y text-base leading-7 ${overLimit ? "border-red-500 focus:border-red-500" : ""}`}
        />
        <div id="tts-counter" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
          <span className={overLimit ? "font-medium text-red-600 dark:text-red-400" : ""}>
            {liveWords.toLocaleString("en-US")} / {MAX_WORDS.toLocaleString("en-US")} words · {liveChars.toLocaleString("en-US")} characters
            {liveChars > MAX_CHARS && ` (max ${MAX_CHARS.toLocaleString("en-US")})`}
          </span>
          {!empty && !overLimit && (
            <span>
              ≈ {formatDuration(stats.seconds)} audio · {stats.parts} request{stats.parts === 1 ? "" : "s"} · free tier: $0 (paid tier ≈{" "}
              {formatUsd(stats.paidCost)})
            </span>
          )}
        </div>
        {overLimit && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            Text exceeds the {MAX_WORDS.toLocaleString("en-US")}-word limit. Please shorten it — nothing is truncated automatically.
          </p>
        )}
      </div>

      <fieldset disabled={busy} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <legend className="sr-only">Voice options</legend>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-800 dark:text-zinc-200">Voice</span>
          <select className={fieldClass} value={options.voice} onChange={(e) => setOptions({ voice: e.target.value })}>
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id} ({v.style})
              </option>
            ))}
          </select>
        </label>
        <p className="self-end pb-2 text-xs text-zinc-500 sm:pb-2.5">
          Language is detected automatically from your text (Gemini supports 100+ languages).
        </p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={generate} disabled={busy || empty || overLimit} className={primaryBtn}>
          {busy && <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
          {status === "planning" ? "Preparing…" : status === "generating" ? "Generating…" : status === "merging" ? "Combining…" : "Generate Voice"}
        </button>
        {status === "generating" && (
          <button type="button" onClick={cancel} className={secondaryBtn}>
            Cancel
          </button>
        )}
        {canRetry && (
          <button type="button" onClick={retryFailed} className={secondaryBtn}>
            Retry failed parts
          </button>
        )}
        {!busy && (segments.length > 0 || error) && (
          <button type="button" onClick={reset} className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400">
            Clear result
          </button>
        )}
      </div>

      <div aria-live="polite" className="flex flex-col gap-4">
        {(status === "generating" || status === "merging" || (segments.length > 0 && status !== "done")) && (
          <div className="flex flex-col gap-2">
            <div className="flex justify-between gap-3 text-sm text-zinc-700 dark:text-zinc-300">
              <span>
                {status === "merging"
                  ? "Combining audio…"
                  : `Generated ${doneCount} of ${segments.length} part${segments.length === 1 ? "" : "s"}`}
                {waitUntil && status === "generating" && ` · ${waitReason}, next request in ${waitSeconds}s`}
              </span>
              <span>{progress}%</span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <div className="h-full rounded-full bg-zinc-900 transition-all duration-500 dark:bg-zinc-100" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-200">
            {error}
            {status === "error" && !segments.length && (
              <button type="button" onClick={generate} className="ml-2 font-medium underline underline-offset-4">
                Try again
              </button>
            )}
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-3 rounded-xl border border-black/[.08] bg-zinc-50 p-4 dark:border-white/[.145] dark:bg-zinc-900/60">
            {/* Native controls provide play/pause, seek, volume and playback in all modern browsers. */}
            <audio controls preload="metadata" src={result.url} className="w-full">
              Your browser does not support audio playback.
            </audio>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-zinc-600 dark:text-zinc-400">WAV · {formatBytes(result.size)}</span>
              <a href={result.url} download={`speech-${timestamp()}.wav`} className={primaryBtn}>
                Download Audio
              </a>
            </div>
          </div>
        )}

        {segments.length > 1 && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setShowParts((v) => !v)}
              aria-expanded={showParts}
              className="self-start text-sm font-medium text-zinc-700 underline-offset-4 hover:underline dark:text-zinc-300"
            >
              {showParts ? "Hide" : "Show"} individual parts ({segments.length})
            </button>
            {showParts && (
              <ol className="flex flex-col gap-2">
                {segments.map((s, i) => (
                  <li key={i} className="flex flex-col gap-2 rounded-lg border border-black/[.08] p-3 text-sm dark:border-white/[.145]">
                    <div className="flex items-start justify-between gap-3">
                      <span className="line-clamp-2 text-zinc-700 dark:text-zinc-300" dir="auto">
                        <span className="font-medium">Part {i + 1}.</span> {s.text}
                      </span>
                      <span
                        className={`shrink-0 text-xs font-medium ${
                          s.status === "done"
                            ? "text-emerald-700 dark:text-emerald-400"
                            : s.status === "failed"
                              ? "text-red-600 dark:text-red-400"
                              : "text-zinc-500"
                        }`}
                      >
                        {s.status === "done" ? "Ready" : s.status === "failed" ? s.error ?? "Failed" : s.status === "working" ? "Generating…" : "Queued"}
                      </span>
                    </div>
                    {s.url && (
                      <div className="flex items-center gap-3">
                        <audio controls preload="none" src={s.url} className="h-9 w-full" />
                        <a
                          href={s.url}
                          download={`speech-part-${String(i + 1).padStart(3, "0")}.wav`}
                          className="shrink-0 text-xs font-medium underline underline-offset-4"
                        >
                          Download
                        </a>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

import "server-only";
import { TtsError } from "./http";

// In-memory limits. They're per server instance: good basic abuse protection for
// a single Node server; on multi-instance/serverless deployments, back these with
// a shared store (e.g. Redis/Upstash) for strict enforcement.

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

const LIMITS = {
  requestsPerMinute: () => envInt("TTS_MAX_REQUESTS_PER_MINUTE", 120),
  charsPerHour: () => envInt("TTS_MAX_CHARS_PER_HOUR", 120_000),
  concurrentPerIp: () => envInt("TTS_MAX_CONCURRENT_PER_IP", 3),
  globalCharsPerDay: () => envInt("TTS_GLOBAL_MAX_CHARS_PER_DAY", 2_000_000),
};

type Entry = { at: number; amount: number };
const requestLog = new Map<string, Entry[]>();
const charLog = new Map<string, Entry[]>();
const inFlight = new Map<string, number>();
let globalDay = { day: "", chars: 0 };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function prune(log: Map<string, Entry[]>, key: string, windowMs: number, now: number): Entry[] {
  const entries = (log.get(key) ?? []).filter((e) => now - e.at < windowMs);
  if (entries.length) log.set(key, entries);
  else log.delete(key);
  return entries;
}

function sum(entries: Entry[]): number {
  return entries.reduce((s, e) => s + e.amount, 0);
}

function retryAfter(entries: Entry[], windowMs: number, now: number): number {
  const oldest = entries[0]?.at ?? now;
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

// Periodically drop idle keys so memory stays bounded.
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < 5 * MINUTE) return;
  lastSweep = now;
  for (const key of requestLog.keys()) prune(requestLog, key, MINUTE, now);
  for (const key of charLog.keys()) prune(charLog, key, HOUR, now);
}

/** Simple per-IP request rate limit (used by cheap endpoints). */
export function checkRequestRate(ip: string): void {
  const now = Date.now();
  sweep(now);
  const reqs = prune(requestLog, ip, MINUTE, now);
  if (reqs.length >= LIMITS.requestsPerMinute()) {
    throw new TtsError("rate_limited", 429, "Too many requests. Please wait a moment and try again.", true, retryAfter(reqs, MINUTE, now));
  }
  reqs.push({ at: now, amount: 1 });
  requestLog.set(ip, reqs);
}

/**
 * Reserves a synthesis slot: enforces request rate, per-IP concurrency, per-IP
 * hourly character budget and a global daily character budget (cost cap).
 * Returns a release function that must be called when the request finishes;
 * pass `refund: true` when nothing was billed (provider error) so retries are free.
 */
export function reserveSynthesis(ip: string, chars: number): (opts?: { refund?: boolean }) => void {
  checkRequestRate(ip);
  const now = Date.now();

  const active = inFlight.get(ip) ?? 0;
  if (active >= LIMITS.concurrentPerIp()) {
    throw new TtsError("rate_limited", 429, "Too many generations in progress. Please wait.", true, 2);
  }

  const used = prune(charLog, ip, HOUR, now);
  if (sum(used) + chars > LIMITS.charsPerHour()) {
    throw new TtsError(
      "rate_limited",
      429,
      "Hourly generation limit reached. Please try again later.",
      true,
      retryAfter(used, HOUR, now),
    );
  }

  const today = new Date(now).toISOString().slice(0, 10);
  if (globalDay.day !== today) globalDay = { day: today, chars: 0 };
  if (globalDay.chars + chars > LIMITS.globalCharsPerDay()) {
    throw new TtsError("daily_budget_exceeded", 503, "The service has reached its daily generation limit. Please try again tomorrow.");
  }

  const entry: Entry = { at: now, amount: chars };
  used.push(entry);
  charLog.set(ip, used);
  globalDay.chars += chars;
  inFlight.set(ip, active + 1);

  let released = false;
  return (opts) => {
    if (released) return;
    released = true;
    if (opts?.refund) {
      entry.amount = 0;
      if (globalDay.day === today) globalDay.chars = Math.max(0, globalDay.chars - chars);
    }
    const n = (inFlight.get(ip) ?? 1) - 1;
    if (n > 0) inFlight.set(ip, n);
    else inFlight.delete(ip);
  };
}

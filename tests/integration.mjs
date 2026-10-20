// End-to-end API test against a running Next server backed by tests/mock-gemini.mjs.
// Usage: node tests/integration.mjs [baseUrl]
import assert from "node:assert/strict";
import { mergeWav } from "../src/lib/tts/audio.ts";

const BASE = process.argv[2] ?? "http://localhost:3000";
let ipCounter = 0;
// Each case uses its own client IP so rate limits don't interfere (unless intended).
const freshIp = () => `10.0.0.${++ipCounter}`;
const stats = { rateLimitWaits: 0 };

async function post(path, body, { ip = freshIp(), headers = {} } = {}) {
  return fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const opts = { voice: "Kore" };
const words = (n) => {
  const s = [];
  for (let i = 0; i < n; i++) s.push(`word${i}${i % 15 === 14 ? "." : ""}${i % 90 === 89 ? "\n\n" : ""}`);
  return s.join(" ") + ".";
};
/** Mock returns 100 samples (200 bytes) of PCM per input character. */
const mockBytes = (chunks) => chunks.reduce((s, c) => s + c.length * 200, 0);

/** Simulates the browser flow: plan → synthesize each chunk (2 at a time) → merge. */
async function fullJob(text, o = opts) {
  const ip = freshIp();
  const planRes = await post("/api/tts/plan", { text }, { ip });
  assert.equal(planRes.status, 200, await planRes.clone().text());
  const plan = await planRes.json();
  const parts = new Array(plan.chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < plan.chunks.length) {
      const i = next++;
      let r;
      // Like the browser: wait out retryable rate limits using Retry-After.
      for (;;) {
        r = await post("/api/tts", { ...o, text: plan.chunks[i] }, { ip });
        if (r.status !== 429 || !(await r.clone().json()).error.retryable) break;
        stats.rateLimitWaits++;
        await new Promise((res) => setTimeout(res, Number(r.headers.get("retry-after") ?? 1) * 1000));
      }
      assert.equal(r.status, 200, await r.clone().text());
      assert.equal(r.headers.get("content-type"), "audio/wav");
      parts[i] = new Uint8Array(await r.arrayBuffer());
    }
  };
  await Promise.all([worker(), worker()]);
  return { plan, parts, merged: mergeWav(parts) };
}

const dataBytes = (wav) => new DataView(wav.buffer, wav.byteOffset).getUint32(40, true);

const results = [];
async function run(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (e) {
    results.push(["FAIL", name, e.message]);
  }
}

await run("voices endpoint returns documented voices and configured=true", async () => {
  const r = await fetch(BASE + "/api/tts/voices", { headers: { "X-Forwarded-For": freshIp() } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.configured, true);
  assert.equal(j.voices.length, 30);
  assert.ok(j.voices.some((v) => v.id === "Kore"));
  assert.ok(!JSON.stringify(j).includes("test-key"));
});

await run("short text → single part, L16 PCM converted to valid WAV", async () => {
  const text = "Hello there! This is a short test.";
  const { plan, merged } = await fullJob(text);
  assert.equal(plan.chunks.length, 1);
  assert.equal(Buffer.from(merged.subarray(0, 4)).toString(), "RIFF");
  assert.equal(dataBytes(merged), text.length * 200);
});

await run("~1,000 words → ≤4,500-char parts merged losslessly in order", async () => {
  const { plan, merged } = await fullJob(words(1000));
  assert.equal(plan.words, 1000);
  assert.ok(plan.chunks.length >= 2 && plan.chunks.every((c) => c.length <= 4500));
  assert.equal(dataBytes(merged), mockBytes(plan.chunks));
});

await run("4,000 words → accepted, packed into near-minimal number of requests", async () => {
  const { plan, merged } = await fullJob(words(4000));
  assert.equal(plan.words, 4000);
  assert.ok(plan.chunks.length <= Math.ceil(plan.chars / 4500) + 2, `parts=${plan.chunks.length} chars=${plan.chars}`);
  assert.ok(plan.estimatedPaidCostUsd > 0.2 && plan.estimatedPaidCostUsd < 1.5, String(plan.estimatedPaidCostUsd));
  assert.equal(dataBytes(merged), mockBytes(plan.chunks));
});

await run("Gemini WAV-format response is passed through as WAV", async () => {
  const r = await post("/api/tts", { ...opts, text: "WAVMODE hello" });
  assert.equal(r.status, 200);
  const b = new Uint8Array(await r.arrayBuffer());
  assert.equal(Buffer.from(b.subarray(0, 4)).toString(), "RIFF");
  assert.equal(dataBytes(b), "WAVMODE hello".length * 200);
});

await run("voice names are case-insensitive", async () => {
  assert.equal((await post("/api/tts", { voice: "kore", text: "hi" })).status, 200);
});

await run("4,001 words rejected (no silent truncation)", async () => {
  const r = await post("/api/tts/plan", { text: words(4001) });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error.code, "too_long");
});

await run("empty / whitespace input rejected", async () => {
  for (const text of ["", "   \n\t  "]) {
    assert.equal((await post("/api/tts/plan", { text })).status, 400);
    assert.equal((await post("/api/tts", { ...opts, text })).status, 400);
  }
});

await run("punctuation, numbers, paragraphs, unicode", async () => {
  const text = "Dr. Smith paid $1,234.56 on 2026-10-21 — 50% off!\n\nCafé naïve résumé. 今天天气很好。 मेरा नाम राम है। 😀 Done?";
  const { plan } = await fullJob(text);
  assert.equal(plan.chunks.join(" ").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

await run("invalid options rejected (unknown/missing voice, bad json, wrong content type)", async () => {
  assert.equal((await post("/api/tts", { voice: "nobody", text: "hi" })).status, 400);
  assert.equal((await post("/api/tts", { text: "hi" })).status, 400);
  assert.equal((await post("/api/tts", "{not json")).status, 400);
  const r = await fetch(BASE + "/api/tts", { method: "POST", body: "text", headers: { "Content-Type": "text/plain" } });
  assert.equal(r.status, 415);
});

await run("part over 4,500 chars and oversized body rejected", async () => {
  assert.equal((await post("/api/tts", { ...opts, text: "a ".repeat(2300) })).status, 413);
  assert.equal((await post("/api/tts", { ...opts, text: "x".repeat(40_000) })).status, 413);
});

await run("cross-origin POST rejected", async () => {
  const r = await post("/api/tts", { ...opts, text: "hi" }, { headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403);
});

await run("no audio once (finishReason OTHER) → retryable, then succeeds", async () => {
  const ip = freshIp();
  const r = await post("/api/tts", { ...opts, text: "NOAUDIO first" }, { ip });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.retryable, true);
  assert.equal((await post("/api/tts", { ...opts, text: "NOAUDIO first" }, { ip })).status, 200);
});

await run("safety-blocked text → non-retryable provider_rejected", async () => {
  const r = await post("/api/tts", { ...opts, text: "SAFETY text" });
  const j = await r.json();
  assert.equal(r.status, 400);
  assert.equal(j.error.code, "provider_rejected");
  assert.equal(j.error.retryable, false);
});

await run("provider 500 → 502 retryable, no internal details leaked", async () => {
  const r = await post("/api/tts", { ...opts, text: "FAIL500 please" });
  const j = await r.json();
  assert.equal(r.status, 502);
  assert.equal(j.error.code, "provider_error");
  assert.equal(j.error.retryable, true);
  assert.ok(!JSON.stringify(j).includes("INTERNAL"));
});

await run("partial failure: failing part retried and succeeds", async () => {
  const ip = freshIp();
  assert.equal((await post("/api/tts", { ...opts, text: "FAILONCE part two." }, { ip })).status, 502);
  assert.equal((await post("/api/tts", { ...opts, text: "FAILONCE part two." }, { ip })).status, 200);
});

await run("per-minute provider 429 → retryable rate_limited with Retry-After", async () => {
  const r = await post("/api/tts", { ...opts, text: "RATELIMIT now" });
  const j = await r.json();
  assert.equal(r.status, 429);
  assert.equal(j.error.code, "rate_limited");
  assert.equal(j.error.retryable, true);
  assert.equal(r.headers.get("retry-after"), "1");
});

await run("provider timeout → 504", async () => {
  const r = await post("/api/tts", { ...opts, text: "SLOW response" });
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error.code, "timeout");
});

await run("per-IP request rate limit kicks in", async () => {
  const ip = freshIp();
  let limited = false;
  for (let i = 0; i < 150 && !limited; i++) {
    if ((await post("/api/tts/plan", { text: "hi" }, { ip })).status === 429) limited = true;
  }
  assert.ok(limited);
});

// These run last: they mark models as exhausted for the rest of the server's life.
await run("primary model's daily quota used up → falls back to the next model", async () => {
  const r = await post("/api/tts", { ...opts, text: "PRIMARYQUOTA hello" });
  assert.equal(r.status, 200, await r.clone().text());
  // Later requests skip the exhausted primary model directly and keep working.
  assert.equal((await post("/api/tts", { ...opts, text: "after fallback" })).status, 200);
});

await run("daily quota used up on every model → non-retryable provider_quota", async () => {
  const r = await post("/api/tts", { ...opts, text: "DAILYQUOTA reached" });
  const j = await r.json();
  assert.equal(r.status, 429);
  assert.equal(j.error.code, "provider_quota");
  assert.equal(j.error.retryable, false);
  assert.match(j.error.message, /tomorrow/);
});

for (const [s, n, m] of results) console.log(`${s}  ${n}${m ? `\n      ${m}` : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed (rate-limit waits honoured: ${stats.rateLimitWaits})`);
process.exit(failed ? 1 : 0);

// Minimal mock of the Gemini API generateContent TTS endpoint for local integration tests.
// Usage: node tests/mock-gemini.mjs [port]   (expects "x-goog-api-key: test-key")
//
// Markers in the text trigger failure modes:
//   FAIL500 → always 500           FAILONCE → 500 on first attempt, then success
//   RATELIMIT → 429 per-minute once (retryDelay 1s)   DAILYQUOTA → 429 per-day quota
//   NOAUDIO → 200 without audio once (finishReason OTHER)   SAFETY → 200 blocked (finishReason SAFETY)
//   WAVMODE → audio returned as audio/wav instead of L16 PCM   SLOW → never responds in time
import http from "node:http";

const port = Number(process.argv[2] ?? 4012);
const seen = new Map();
let calls = 0;

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const gErr = (code, status, message, details = []) => ({ error: { code, status, message, details } });

function wavHeader(pcmLength) {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + pcmLength, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(pcmLength, 40);
  return b;
}

http
  .createServer(async (req, res) => {
    if (req.headers["x-goog-api-key"] !== "test-key") {
      return send(res, 400, gErr(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }]));
    }
    const m = req.url.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
    if (req.method !== "POST" || !m) return send(res, 404, gErr(404, "NOT_FOUND", "not found"));
    if (m[1] !== "gemini-3.8-flash-tts") return send(res, 404, gErr(404, "NOT_FOUND", "model not found"));

    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls++;
    const text = body.contents?.[0]?.parts?.[0]?.text;
    const voice = body.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName;
    if (typeof text !== "string" || !text) return send(res, 400, gErr(400, "INVALID_ARGUMENT", "text required"));
    if (body.generationConfig?.responseModalities?.[0] !== "AUDIO") return send(res, 400, gErr(400, "INVALID_ARGUMENT", "modality"));
    if (!voice) return send(res, 400, gErr(400, "INVALID_ARGUMENT", "voice required"));

    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    process.stdout.write(`[mock] call #${calls} len=${text.length} voice=${voice} attempt=${count}\n`);

    if (text.includes("FAIL500")) return send(res, 500, gErr(500, "INTERNAL", "internal"));
    if (text.includes("FAILONCE") && count === 1) return send(res, 503, gErr(503, "UNAVAILABLE", "overloaded"));
    if (text.includes("RATELIMIT") && count === 1) {
      return send(res, 429, gErr(429, "RESOURCE_EXHAUSTED", "quota", [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" },
      ]));
    }
    if (text.includes("DAILYQUOTA")) {
      return send(res, 429, gErr(429, "RESOURCE_EXHAUSTED", "quota", [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "35s" },
      ]));
    }
    if (text.includes("NOAUDIO") && count === 1) return send(res, 200, { candidates: [{ finishReason: "OTHER", content: { parts: [] } }] });
    if (text.includes("SAFETY")) return send(res, 200, { candidates: [{ finishReason: "SAFETY" }] });
    if (text.includes("SLOW")) return; // hang; client times out

    const pcm = Buffer.alloc(text.length * 200, 0x11); // 100 samples per char, 16-bit
    const wavMode = text.includes("WAVMODE");
    const data = wavMode ? Buffer.concat([wavHeader(pcm.length), pcm]) : pcm;
    send(res, 200, {
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ inlineData: { mimeType: wavMode ? "audio/wav" : "audio/L16;codec=pcm;rate=24000", data: data.toString("base64") } }] },
      }],
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`[mock] Gemini mock listening on ${port}`));

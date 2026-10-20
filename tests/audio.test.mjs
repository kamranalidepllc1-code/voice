import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWav } from "../src/lib/tts/audio.ts";
import { wavFile } from "./fixtures.mjs";

test("mergeWav writes a single valid header and concatenates PCM data", () => {
  const merged = mergeWav([wavFile(100, 0x01), wavFile(50, 0x02, { unknownSize: true })]);
  const v = new DataView(merged.buffer);
  assert.equal(Buffer.from(merged.subarray(0, 4)).toString(), "RIFF");
  assert.equal(v.getUint32(4, true), merged.length - 8);
  assert.equal(Buffer.from(merged.subarray(36, 40)).toString(), "data");
  assert.equal(v.getUint32(40, true), 300);
  assert.equal(merged.length, 44 + 300);
  assert.equal(merged[44], 0x01);
  assert.equal(merged[44 + 199], 0x01);
  assert.equal(merged[44 + 200], 0x02);
});

test("mergeWav rejects chunks with different formats", () => {
  assert.throws(() => mergeWav([wavFile(10), wavFile(10, 0, { sampleRate: 16000 })]), /different formats/);
});

test("pcm16ToWav wraps raw PCM in a valid header that mergeWav accepts", async () => {
  const { pcm16ToWav } = await import("../src/lib/tts/audio.ts");
  const wav = pcm16ToWav(new Uint8Array(480).fill(7), 24000);
  const v = new DataView(wav.buffer);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), "RIFF");
  assert.equal(v.getUint32(24, true), 24000);
  assert.equal(v.getUint32(40, true), 480);
  assert.equal(mergeWav([wav, wav]).length, 44 + 960);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { countChars, countWords, normalizeText, splitIntoChunks } from "../src/lib/tts/text.ts";

const strip = (s) => s.replace(/\s+/g, "");

function makeWords(n) {
  const sentences = [];
  let words = 0;
  let i = 0;
  while (words < n) {
    const len = Math.min(8 + (i % 12), n - words);
    const ws = Array.from({ length: len }, (_, k) => `word${i}x${k}`);
    sentences.push(ws.join(" ") + (i % 3 === 0 ? "?" : "."));
    words += len;
    i++;
  }
  // Group sentences into paragraphs of 6.
  const paras = [];
  for (let p = 0; p < sentences.length; p += 6) paras.push(sentences.slice(p, p + 6).join(" "));
  return paras.join("\n\n");
}

function assertLossless(text, chunks, max) {
  assert.equal(strip(chunks.join("")), strip(normalizeText(text)), "content preserved in order");
  for (const c of chunks) {
    assert.ok(countChars(c) <= max, `chunk ${countChars(c)} > ${max}`);
    assert.equal(c, c.trim());
    assert.ok(c.length > 0);
  }
}

test("empty and whitespace-only input", () => {
  assert.deepEqual(splitIntoChunks("", 100), []);
  assert.deepEqual(splitIntoChunks("   \n\n\t  ", 100), []);
  assert.equal(countWords("   \n "), 0);
  assert.equal(normalizeText(" \r\n "), "");
});

test("short text is a single chunk, unchanged", () => {
  assert.deepEqual(splitIntoChunks("  Hello, world!  ", 2500), ["Hello, world!"]);
});

test("word counting: punctuation, numbers, unicode", () => {
  assert.equal(countWords("Hello, world! It's 42 degrees — 3 apples."), 7);
  assert.ok(countWords("今天天气很好。我们去公园吧。") >= 4, "CJK words are counted without spaces");
  assert.equal(countWords("Café naïve résumé"), 3);
});

test("code-point aware char count (emoji count as one)", () => {
  assert.equal(countChars("a😀b"), 3);
});

test("~1,000 words splits losslessly", () => {
  const text = makeWords(1000);
  assert.equal(countWords(text), 1000 + 0); // generated words only
  const chunks = splitIntoChunks(text, 2500);
  assert.ok(chunks.length >= 3);
  assertLossless(text, chunks, 2500);
});

test("4,000 words splits losslessly at paragraph/sentence boundaries", () => {
  const text = makeWords(4000);
  assert.equal(countWords(text), 4000);
  const chunks = splitIntoChunks(text, 2500);
  assertLossless(text, chunks, 2500);
  for (const c of chunks) assert.match(c, /[.?]$/, "chunk ends at a sentence boundary");
});

test("paragraph larger than max splits by sentence and keeps paragraph breaks", () => {
  const p1 = "First sentence here. Second sentence follows! Third one? Fourth.";
  const p2 = "New paragraph.";
  const chunks = splitIntoChunks(`${p1}\n\n${p2}`, 40);
  assertLossless(`${p1}\n\n${p2}`, chunks, 40);
  assert.ok(chunks.every((c) => !/^\s/.test(c)));
});

test("sentence without punctuation longer than max splits at word boundaries", () => {
  const text = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
  const chunks = splitIntoChunks(text, 50);
  assertLossless(text, chunks, 50);
  for (const c of chunks) assert.match(c, /^w\d+( w\d+)*$/, "no word was cut");
});

test("unbroken run longer than max is hard-split without breaking surrogate pairs", () => {
  const text = "😀".repeat(25) + "x".repeat(30);
  const chunks = splitIntoChunks(text, 10);
  assertLossless(text, chunks, 10);
  assert.ok(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c)));
});

test("CJK text without spaces is chunked losslessly", () => {
  const text = "今天天气很好，我们去公园散步吧。".repeat(200);
  const chunks = splitIntoChunks(text, 500);
  assertLossless(text, chunks, 500);
});

test("control characters are removed, CRLF normalized", () => {
  assert.equal(normalizeText("a\u0000b\r\nc\u0007"), "ab\nc");
});

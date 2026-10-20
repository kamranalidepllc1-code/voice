// Client-side merging of per-chunk WAV audio into one downloadable file: each
// file's PCM `data` payload is concatenated under one new RIFF header.
// Kept dependency-free (no imports) so it can be unit-tested directly with Node.

function ascii(b: Uint8Array, i: number, n: number): string {
  return String.fromCharCode(...b.subarray(i, i + n));
}

interface WavParts {
  fmt: Uint8Array;
  data: Uint8Array;
}

function parseWav(b: Uint8Array): WavParts {
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 12;
  let fmt: Uint8Array | null = null;
  while (i + 8 <= b.length) {
    const id = ascii(b, i, 4);
    let size = view.getUint32(i + 4, true);
    const bodyStart = i + 8;
    if (id === "data") {
      // Streaming encoders may write 0 or 0xFFFFFFFF as an unknown data size.
      if (size === 0 || bodyStart + size > b.length) size = b.length - bodyStart;
      if (!fmt) throw new Error("WAV data before fmt chunk");
      return { fmt, data: b.subarray(bodyStart, bodyStart + size) };
    }
    if (id === "fmt ") fmt = b.subarray(bodyStart, bodyStart + size);
    i = bodyStart + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

export function mergeWav(files: Uint8Array[]): Uint8Array {
  const parts = files.map(parseWav);
  const fmt = parts[0].fmt;
  for (const p of parts) {
    if (p.fmt.length !== fmt.length || p.fmt.some((v, k) => v !== fmt[k])) {
      throw new Error("WAV chunks have different formats");
    }
  }
  const dataLength = parts.reduce((s, p) => s + p.data.length, 0);
  const headerLength = 12 + 8 + fmt.length + 8;
  const out = new Uint8Array(headerLength + dataLength);
  const view = new DataView(out.buffer);
  const writeAscii = (at: number, s: string) => {
    for (let k = 0; k < s.length; k++) out[at + k] = s.charCodeAt(k);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, out.length - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, fmt.length, true);
  out.set(fmt, 20);
  writeAscii(20 + fmt.length, "data");
  view.setUint32(24 + fmt.length, dataLength, true);
  let offset = headerLength;
  for (const p of parts) {
    out.set(p.data, offset);
    offset += p.data.length;
  }
  return out;
}

/** Wraps raw 16-bit little-endian PCM in a WAV (RIFF) header. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const writeAscii = (at: number, s: string) => {
    for (let k = 0; k < s.length; k++) out[at + k] = s.charCodeAt(k);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

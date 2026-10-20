// Synthetic audio fixtures with spec-correct headers (no encoder needed).

/** 24 kHz 16-bit mono PCM WAV with an extra LIST chunk and optional unknown data size. */
export function wavFile(samples, fill = 0x11, { sampleRate = 24000, unknownSize = false } = {}) {
  const data = new Uint8Array(samples * 2).fill(fill);
  const list = new Uint8Array([..."LIST"].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 0x49, 0x4e, 0x46, 0x4f]));
  const out = new Uint8Array(12 + 24 + list.length + 8 + data.length);
  const v = new DataView(out.buffer);
  const w = (o, s) => [...s].forEach((c, k) => (out[o + k] = c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, out.length - 8, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  out.set(list, 36);
  const d = 36 + list.length;
  w(d, "data");
  v.setUint32(d + 4, unknownSize ? 0xffffffff : data.length, true);
  out.set(data, d + 8);
  return out;
}

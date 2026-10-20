import "server-only";
import type { TtsErrorBody, TtsErrorCode } from "../config";

export class TtsError extends Error {
  constructor(
    public readonly code: TtsErrorCode,
    public readonly status: number,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function errorResponse(err: unknown): Response {
  const e =
    err instanceof TtsError
      ? err
      : new TtsError("internal_error", 500, "Something went wrong. Please try again.", true);
  if (!(err instanceof TtsError)) {
    // Log only the error type/message — never the user's text or credentials.
    console.error("[tts] unexpected error:", err instanceof Error ? err.message : typeof err);
  }
  const body: TtsErrorBody = { error: { code: e.code, message: e.message, retryable: e.retryable } };
  const headers: HeadersInit = { "Cache-Control": "no-store" };
  if (e.retryAfterSeconds) (headers as Record<string, string>)["Retry-After"] = String(e.retryAfterSeconds);
  return Response.json(body, { status: e.status, headers });
}

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Basic CSRF / hot-linking protection: browsers always send Origin on
 * cross-origin POSTs, so reject requests whose Origin host differs from ours.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return; // same-origin GET, curl, server-to-server
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new TtsError("forbidden", 403, "Request origin not allowed.");
  }
  if (!host || originHost !== host) {
    throw new TtsError("forbidden", 403, "Request origin not allowed.");
  }
}

/** Reads a JSON body while enforcing a byte limit, even without Content-Length. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new TtsError("invalid_input", 415, "Expected a JSON request body.");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new TtsError("payload_too_large", 413, "Request is too large.");
  }
  if (!request.body) throw new TtsError("invalid_input", 400, "Request body is empty.");

  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TtsError("payload_too_large", 413, "Request is too large.");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TtsError("invalid_input", 400, "Request body is not valid JSON.");
  }
}

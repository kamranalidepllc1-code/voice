import { connection } from "next/server";
import { VOICES } from "@/lib/tts/config";
import { clientIp, errorResponse } from "@/lib/tts/server/http";
import { checkRequestRate } from "@/lib/tts/server/rate-limit";
import { isConfigured } from "@/lib/tts/server/gemini";

/** Documented prebuilt voices and whether an API key is configured. */
export async function GET(request: Request) {
  await connection(); // always run at request time, never prerendered
  try {
    checkRequestRate(clientIp(request));
    return Response.json(
      { voices: VOICES, configured: isConfigured() },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

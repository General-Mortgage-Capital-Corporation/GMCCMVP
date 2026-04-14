/**
 * Backend proxy for ElevenLabs TTS — keeps the API key server-side.
 * POST { text, voiceId? }  →  audio/mpeg stream
 */

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel

export const runtime = "nodejs";

export async function POST(req: Request) {
  const apiKey = process.env.ELEVENLABS_TTS_API_KEY ?? "";
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "TTS not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => null);
  if (!body?.text || typeof body.text !== "string") {
    return new Response(JSON.stringify({ error: "text field required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Cap text length to prevent abuse (5000 chars ≈ ~3 min of speech)
  const text = body.text.slice(0, 5000);
  const voiceId = body.voiceId ?? DEFAULT_VOICE_ID;

  const res = await fetch(`${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}/stream`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_flash_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`[tts] ElevenLabs ${res.status}: ${errText.slice(0, 200)}`);
    return new Response(JSON.stringify({ error: "TTS generation failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Stream the audio back to the client
  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}

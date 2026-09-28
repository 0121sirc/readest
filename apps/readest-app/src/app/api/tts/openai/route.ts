import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Same-origin proxy for a user-configured OpenAI-compatible speech endpoint.
// The browser cannot call most self-hosted TTS servers directly: they rarely
// answer the CORS preflight or send Access-Control-Allow-Origin. Forwarding the
// request from our own origin sidesteps that entirely.
//
// The target base URL comes from the client (it lives in localStorage), so this
// is a general http(s) forwarder — same trust model as the OPDS proxy. Only the
// scheme is constrained.

const buildSpeechUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/audio/speech') ? trimmed : `${trimmed}/audio/speech`;
};

export async function POST(req: Request): Promise<Response> {
  try {
    const { baseUrl, apiKey, model, input, voice, responseFormat } = await req.json();

    if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl.trim())) {
      return NextResponse.json({ error: 'A valid http(s) base URL is required' }, { status: 400 });
    }
    if (typeof input !== 'string' || input.length === 0) {
      return NextResponse.json({ error: 'input is required' }, { status: 400 });
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (typeof apiKey === 'string' && apiKey.trim()) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    const upstream = await fetch(buildSpeechUrl(baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input,
        voice,
        response_format: responseFormat || 'mp3',
      }),
    });

    if (!upstream.ok) {
      // Propagate the upstream status so the client can tell a permanent 4xx
      // (bad voice/request) from a transient 5xx and retry accordingly.
      const detail = await upstream.text().catch(() => '');
      return new Response(detail.slice(0, 500), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const audio = await upstream.arrayBuffer();
    return new Response(audio, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: `TTS proxy failed: ${message}` }, { status: 502 });
  }
}

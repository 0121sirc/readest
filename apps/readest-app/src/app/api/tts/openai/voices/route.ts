import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Same-origin proxy for a user-configured server's voice list. OpenAI has no
// standard voices endpoint, but several self-hosted implementations expose
// `/v1/audio/voices`; this normalizes the common shapes so the settings UI can
// offer them without hitting CORS.

interface NormalizedVoice {
  id: string;
  desc?: string;
}

const buildVoicesUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/audio/voices') ? trimmed : `${trimmed}/audio/voices`;
};

const normalize = (data: unknown): NormalizedVoice[] => {
  if (!data || typeof data !== 'object') return [];
  const obj = data as {
    voices?: unknown;
    data?: unknown;
    details?: Record<string, { desc?: string } | undefined>;
  };
  const details = obj.details ?? {};

  const toList = (raw: unknown): NormalizedVoice[] => {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry): NormalizedVoice | null => {
        if (typeof entry === 'string') return { id: entry };
        if (entry && typeof entry === 'object' && 'id' in entry) {
          const id = String((entry as { id: unknown }).id);
          return { id };
        }
        return null;
      })
      .filter((v): v is NormalizedVoice => v !== null);
  };

  const list = obj.voices !== undefined ? toList(obj.voices) : toList(obj.data);
  return list.map((voice) => {
    const desc = details[voice.id]?.desc;
    return desc ? { id: voice.id, desc } : { id: voice.id };
  });
};

export async function POST(req: Request): Promise<Response> {
  try {
    const { baseUrl, apiKey } = await req.json();

    if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl.trim())) {
      return NextResponse.json({ error: 'A valid http(s) base URL is required' }, { status: 400 });
    }

    const headers: Record<string, string> = {};
    if (typeof apiKey === 'string' && apiKey.trim()) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    const upstream = await fetch(buildVoicesUrl(baseUrl), { headers });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return new Response(detail.slice(0, 500), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await upstream.json().catch(() => null);
    return NextResponse.json({ voices: normalize(data) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: `Voices fetch failed: ${message}` }, { status: 502 });
  }
}

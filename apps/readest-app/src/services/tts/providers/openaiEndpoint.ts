// Transport for the user-configured OpenAI-compatible speech endpoint.
//
// On the web the browser cannot call most self-hosted TTS servers directly
// (no CORS), so both synthesis and the voice list go through the same-origin
// relay at `${getAPIBaseUrl()}/tts/openai*`. On the desktop build that route
// does not exist (`output: 'export'`), and the Tauri HTTP plugin talks to the
// endpoint with curl semantics, so the call goes straight to the user's
// server. This keeps TTS working on both platforms while letting a desktop
// user run entirely against their own endpoint.

import { getAPIBaseUrl, isTauriAppPlatform } from '@/services/environment';
import { getAIFetch } from '@/services/ai/utils/httpFetch';
import { OPENAI_TTS_RESPONSE_FORMAT, type OpenAITTSConfig } from './openaiConfig';

const trimBase = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '');

const buildSpeechUrl = (baseUrl: string): string => {
  const trimmed = trimBase(baseUrl);
  return trimmed.endsWith('/audio/speech') ? trimmed : `${trimmed}/audio/speech`;
};

const buildVoicesUrl = (baseUrl: string): string => {
  const trimmed = trimBase(baseUrl);
  return trimmed.endsWith('/audio/voices') ? trimmed : `${trimmed}/audio/voices`;
};

const buildHealthUrl = (baseUrl: string): string => `${trimBase(baseUrl)}/health`;

const authHeader = (apiKey: string): Record<string, string> =>
  apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {};

interface SpeechPayload {
  model?: string;
  input: string;
  voice: string;
}

const speechPayload = (config: OpenAITTSConfig, input: string, voice: string): SpeechPayload => ({
  // Omit an empty model entirely; many servers reject an unknown id.
  model: config.model.trim() || undefined,
  input,
  voice,
});

/**
 * POST a synthesis request to the configured endpoint. Returns the upstream
 * `Response` so callers keep the existing status / body handling.
 */
export const synthesizeOpenAI = (
  config: OpenAITTSConfig,
  input: string,
  voice: string,
  signal?: AbortSignal,
): Promise<Response> => {
  const payload = speechPayload(config, input, voice);
  if (isTauriAppPlatform()) {
    return getAIFetch()(buildSpeechUrl(config.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(config.apiKey) },
      body: JSON.stringify({ ...payload, response_format: OPENAI_TTS_RESPONSE_FORMAT }),
      signal,
    });
  }
  return window.fetch(`${getAPIBaseUrl()}/tts/openai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      ...payload,
      responseFormat: OPENAI_TTS_RESPONSE_FORMAT,
    }),
    signal,
  });
};

interface NormalizedVoice {
  id: string;
}

const normalizeVoices = (data: unknown): NormalizedVoice[] => {
  if (!data || typeof data !== 'object') return [];
  const obj = data as { voices?: unknown; data?: unknown };
  const toList = (raw: unknown): NormalizedVoice[] => {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry): NormalizedVoice | null => {
        if (typeof entry === 'string') return { id: entry };
        if (entry && typeof entry === 'object' && 'id' in entry) {
          return { id: String((entry as { id: unknown }).id) };
        }
        return null;
      })
      .filter((v): v is NormalizedVoice => v !== null);
  };
  return obj.voices !== undefined ? toList(obj.voices) : toList(obj.data);
};

const fetchSampleRate = async (
  baseUrl: string,
  headers: Record<string, string>,
): Promise<number | undefined> => {
  try {
    const res = await getAIFetch()(buildHealthUrl(baseUrl), { headers });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { sample_rate?: number };
    return typeof data.sample_rate === 'number' && data.sample_rate > 0
      ? data.sample_rate
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Fetch the endpoint's voice list (best-effort) and its PCM sample rate.
 * Returns empty on any failure; callers fall back to the configured voices.
 */
export const fetchOpenAIVoices = async (
  config: OpenAITTSConfig,
): Promise<{ voices: NormalizedVoice[]; sampleRate?: number }> => {
  if (!isTauriAppPlatform()) {
    try {
      const res = await window.fetch(`${getAPIBaseUrl()}/tts/openai/voices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey }),
      });
      if (!res.ok) return { voices: [] };
      const data = (await res.json()) as {
        voices?: { id?: string }[];
        sampleRate?: number;
      };
      return {
        voices: (data.voices ?? [])
          .map((voice) => voice.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
          .map((id) => ({ id })),
        sampleRate: data.sampleRate,
      };
    } catch {
      return { voices: [] };
    }
  }

  const headers = authHeader(config.apiKey);
  try {
    const res = await getAIFetch()(buildVoicesUrl(config.baseUrl), { headers });
    if (!res.ok) return { voices: [] };
    const data = await res.json().catch(() => null);
    const sampleRate = await fetchSampleRate(config.baseUrl, headers);
    return { voices: normalizeVoices(data), sampleRate };
  } catch {
    return { voices: [] };
  }
};

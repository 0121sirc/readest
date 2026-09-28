// A user-configured OpenAI-compatible speech endpoint as a SpeechProvider.
// Works with api.openai.com and the many local/proxy servers that implement
// `POST {baseUrl}/audio/speech` (OpenAI, LocalAI, Speaches, CosyVoice, ...).
//
// The service returns compressed audio only — no word boundaries — so word
// highlighting degrades to sentence highlighting, which is the documented
// fallback for providers without boundaries.
//
// Two things matter for self-hosted endpoints, which can take ~10s per request:
//   - an in-memory LRU of synthesized audio, so the look-ahead preload and the
//     playback scheduler don't both pay for the same sentence (and replays/seeks
//     are instant);
//   - a concurrency limiter, so opening several look-ahead requests does not
//     stampede the server.

import type { TTSVoice } from '../types';
import { getAPIBaseUrl } from '@/services/environment';
import {
  getOpenAITTSConfig,
  isOpenAITTSConfigured,
  parseOpenAIVoices,
  setOpenAITTSConfig,
} from './openaiConfig';
import {
  SpeechProvider,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

// Cap on simultaneous `/audio/speech` requests across preload + playback.
const MAX_CONCURRENT_REQUESTS = 6;
// In-memory cache budget for synthesized audio (per session).
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

class Semaphore {
  #max: number;
  #active = 0;
  #waiters: (() => void)[] = [];

  constructor(max: number) {
    this.#max = Math.max(1, max);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#max) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#waiters.shift()?.();
    }
  }
}

const cacheKey = (req: SpeechSynthesisRequest, model: string): string =>
  `${model}\u0000${req.voice}\u0000${req.pitch}\u0000${req.lang}\u0000${req.text}`;

export class OpenAISpeechProvider implements SpeechProvider {
  readonly id = 'openai-tts';
  readonly label = 'Custom OpenAI';

  // Caching is in-memory only and owned by this provider, so the offline-audio
  // download surface (which keys off CachingProvider) stays disabled.
  readonly cacheable = false;

  readonly #limiter = new Semaphore(MAX_CONCURRENT_REQUESTS);
  readonly #cache = new Map<string, ArrayBuffer>();
  #cacheBytes = 0;

  async init(): Promise<boolean> {
    return isOpenAITTSConfigured();
  }

  // The voice list is the server's, fetched through our proxy (no CORS). The
  // result is cached in the config so it survives a later fetch failure and can
  // seed the default voice; the settings panel no longer edits it directly.
  async #fetchServerVoices(): Promise<string[]> {
    const config = getOpenAITTSConfig();
    try {
      const res = await fetch(`${getAPIBaseUrl()}/tts/openai/voices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { voices?: { id?: string }[] };
      const ids = (data.voices ?? [])
        .map((voice) => voice.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (ids.length > 0) setOpenAITTSConfig({ ...config, voices: ids.join(',') });
      return ids;
    } catch {
      return [];
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    if (!isOpenAITTSConfigured()) return [];
    const serverVoices = await this.#fetchServerVoices();
    const ids =
      serverVoices.length > 0 ? serverVoices : parseOpenAIVoices(getOpenAITTSConfig().voices);
    return ids.map((id) => ({ id, name: id, lang: 'en' }));
  }

  get fallbackVoiceId(): string | undefined {
    return parseOpenAIVoices(getOpenAITTSConfig().voices)[0];
  }

  pickDefaultVoice(voices: TTSVoice[]): string | undefined {
    return voices[0]?.id;
  }

  #cacheGet(key: string): ArrayBuffer | undefined {
    const hit = this.#cache.get(key);
    if (!hit) return undefined;
    // Refresh recency (Map preserves insertion order).
    this.#cache.delete(key);
    this.#cache.set(key, hit);
    return hit.slice(0);
  }

  #cachePut(key: string, audio: ArrayBuffer): void {
    const size = audio.byteLength;
    if (size > MAX_CACHE_BYTES) return;
    const existing = this.#cache.get(key);
    if (existing) {
      this.#cacheBytes -= existing.byteLength;
      this.#cache.delete(key);
    }
    this.#cache.set(key, audio.slice(0));
    this.#cacheBytes += size;
    while (this.#cacheBytes > MAX_CACHE_BYTES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cacheBytes -= this.#cache.get(oldest)!.byteLength;
      this.#cache.delete(oldest);
    }
  }

  async synthesize(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const config = getOpenAITTSConfig();
    if (!isOpenAITTSConfigured(config)) {
      throw new Error('OpenAI TTS is not configured');
    }

    const key = cacheKey(req, config.model);
    const cached = this.#cacheGet(key);
    if (cached) return { audio: cached, boundaries: [] };

    return this.#limiter.run(async () => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      // Route through our own origin: most self-hosted TTS servers do not answer
      // the CORS preflight, so a direct browser fetch is blocked. The proxy
      // forwards to the configured base URL server-side.
      const response = await fetch(`${getAPIBaseUrl()}/tts/openai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          // Omit an empty model entirely; many servers reject an unknown id.
          model: config.model.trim() || undefined,
          input: req.text,
          voice: req.voice,
          responseFormat: 'mp3',
        }),
        signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const message = `OpenAI TTS request failed (${response.status})${
          detail ? `: ${detail.slice(0, 200)}` : ''
        }`;
        // 4xx (except transient 408/429) means the request itself is wrong:
        // retrying the same sentence cannot succeed, so let the client skip it.
        const permanent =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429;
        if (permanent) throw new SpeechSynthesisPermanentError(message);
        throw new Error(message);
      }

      const audio = await response.arrayBuffer();
      this.#cachePut(key, audio);
      return { audio, boundaries: [] };
    });
  }
}

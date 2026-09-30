// A user-configured OpenAI-compatible speech endpoint as a SpeechProvider.
// Works with api.openai.com and the many local/proxy servers that implement
// `POST {baseUrl}/audio/speech` (OpenAI, LocalAI, Speaches, CosyVoice, ...).
//
// The service returns audio only — no word boundaries — so word highlighting
// degrades to sentence highlighting, which is the documented fallback for
// providers without boundaries.
//
// Self-hosted endpoints are usually single-worker: they process one request at
// a time (a second request only starts after the first finishes). Firing the
// look-ahead window's requests concurrently therefore just queues them and
// multiplies latency into audible gaps. Two things fix that:
//   - a module-level serial queue, so exactly one `/audio/speech` request is in
//     flight across every provider instance (playback + dictionary);
//   - `response_format: pcm`, which the server streams as it synthesizes
//     (near-real-time) instead of buffering a fully encoded mp3/wav. PCM is
//     wrapped into a WAV container so the existing decode path is unchanged,
//     and non-PCM servers fall through with their bytes untouched.

import type { TTSVoice } from '../types';
import { getAPIBaseUrl } from '@/services/environment';
import {
  getOpenAITTSConfig,
  isOpenAITTSConfigured,
  OPENAI_TTS_RESPONSE_FORMAT,
  parseOpenAIVoices,
  setOpenAITTSConfig,
} from './openaiConfig';
import {
  SpeechProvider,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

// In-memory cache budget for synthesized audio (per session).
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_SAMPLE_RATE = 24000;

// One request at a time, shared by every OpenAI TTS provider instance. The
// queue continues after a rejected/skipped request so a bad sentence cannot
// wedge playback.
let serialChain: Promise<unknown> = Promise.resolve();
const runSerial = <T>(task: () => Promise<T>): Promise<T> => {
  const result = serialChain.then(task, task);
  serialChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const cacheKey = (req: SpeechSynthesisRequest, model: string): string =>
  `${model}\u0000${req.voice}\u0000${req.pitch}\u0000${req.lang}\u0000${req.text}`;

// Wrap 16-bit little-endian mono PCM in a minimal WAV container so
// `decodeAudioData` (and any downstream tooling) can read it.
const wrapPcmAsWav = (pcm: Uint8Array, sampleRate: number): ArrayBuffer => {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataLen = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataLen, true);
  new Uint8Array(buffer, 44).set(pcm);
  return buffer;
};

export class OpenAISpeechProvider implements SpeechProvider {
  readonly id = 'openai-tts';
  readonly label = 'Custom OpenAI';

  // Caching is in-memory only and owned by this provider, so the offline-audio
  // download surface (which keys off CachingProvider) stays disabled.
  readonly cacheable = false;
  // The server serializes requests; the buffered client skips parallel preload.
  readonly serialSynthesis = true;

  readonly #cache = new Map<string, ArrayBuffer>();
  #cacheBytes = 0;
  #sampleRate = DEFAULT_SAMPLE_RATE;

  async init(): Promise<boolean> {
    return isOpenAITTSConfigured();
  }

  // The voice list is the server's, fetched through our proxy (no CORS). The
  // result is cached in the config so it survives a later fetch failure and can
  // seed the default voice; the settings panel no longer edits it directly.
  // The endpoint's sample rate (from /health) is adopted for PCM wrapping.
  async #fetchServerVoices(): Promise<string[]> {
    const config = getOpenAITTSConfig();
    try {
      const res = await fetch(`${getAPIBaseUrl()}/tts/openai/voices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        voices?: { id?: string }[];
        sampleRate?: number;
      };
      if (typeof data.sampleRate === 'number' && data.sampleRate > 0) {
        this.#sampleRate = data.sampleRate;
      }
      const ids = (data.voices ?? [])
        .map((voice) => voice.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      // Seed the default voice only when the user has not chosen one. A
      // hand-entered voice (e.g. an Edge name like zh-CN-XiaoxiaoNeural) must
      // survive a server that only advertises OpenAI aliases such as alloy.
      if (ids.length > 0 && parseOpenAIVoices(config.voices).length === 0) {
        setOpenAITTSConfig({ ...config, voices: ids.join(',') });
      }
      return ids;
    } catch {
      return [];
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    if (!isOpenAITTSConfigured()) return [];
    const serverVoices = await this.#fetchServerVoices();
    // Configured voices first so a manually entered voice stays selectable even
    // when the server's list does not include it.
    const configured = parseOpenAIVoices(getOpenAITTSConfig().voices);
    const ids = [...new Set([...configured, ...serverVoices])];
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

    return runSerial(async () => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // wav, matching what reference clients use: on self-hosted servers pcm
      // streaming is often much slower than a single wav response, and the
      // browser decode path handles wav directly.
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
          responseFormat: OPENAI_TTS_RESPONSE_FORMAT,
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

      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') ?? '';
      // Some servers ignore response_format and return headerless PCM; wrap it.
      const audio = contentType.includes('pcm')
        ? wrapPcmAsWav(bytes, this.#sampleRate)
        : bytes.buffer;
      this.#cachePut(key, audio);
      return { audio, boundaries: [] };
    });
  }
}

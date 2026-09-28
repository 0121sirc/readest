import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenAISpeechProvider } from '@/services/tts/providers/openai';
import {
  clampLookahead,
  getOpenAITTSConfig,
  OPENAI_TTS_DEFAULT_LOOKAHEAD,
  parseOpenAIVoices,
  setOpenAITTSConfig,
} from '@/services/tts/providers/openaiConfig';
import { SpeechSynthesisPermanentError } from '@/services/tts/providers/types';

const CONFIG_KEY = 'readest-tts-openai';

describe('OpenAITTS config', () => {
  beforeEach(() => localStorage.clear());

  test('falls back to defaults when nothing is stored', () => {
    const config = getOpenAITTSConfig();
    expect(config.baseUrl).toBe('');
    expect(config.apiKey).toBe('');
    expect(config.model).toBe('');
    expect(config.voices).toBe('');
    expect(config.lookahead).toBe(OPENAI_TTS_DEFAULT_LOOKAHEAD);
  });

  test('round-trips a stored config', () => {
    setOpenAITTSConfig({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'sk-test',
      model: 'tts-1',
      voices: 'alloy, nova',
      lookahead: 5,
    });
    expect(getOpenAITTSConfig()).toEqual({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'sk-test',
      model: 'tts-1',
      voices: 'alloy, nova',
      lookahead: 5,
    });
    expect(localStorage.getItem(CONFIG_KEY)).toBeTruthy();
  });

  test('clamps the look-ahead to 1-6', () => {
    expect(clampLookahead(0)).toBe(1);
    expect(clampLookahead(99)).toBe(6);
    expect(clampLookahead(3.4)).toBe(3);
    expect(clampLookahead(undefined)).toBe(OPENAI_TTS_DEFAULT_LOOKAHEAD);
  });

  test('parses, trims, and drops empty voice ids', () => {
    expect(parseOpenAIVoices(' alloy , nova ,, onyx ')).toEqual(['alloy', 'nova', 'onyx']);
    expect(parseOpenAIVoices('')).toEqual([]);
  });
});

describe('OpenAISpeechProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  test('is unavailable and offers no voices until configured', async () => {
    const provider = new OpenAISpeechProvider();
    await expect(provider.init()).resolves.toBe(false);
    await expect(provider.getAllVoices()).resolves.toEqual([]);
  });

  test('is available and exposes the configured voices once a base URL is set', async () => {
    setOpenAITTSConfig({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'tts-1',
      voices: 'alloy, nova',
      lookahead: 3,
    });
    const provider = new OpenAISpeechProvider();
    await expect(provider.init()).resolves.toBe(true);
    const voices = await provider.getAllVoices();
    expect(voices.map((v) => v.id)).toEqual(['alloy', 'nova']);
    expect(provider.pickDefaultVoice(voices)).toBe('alloy');
  });

  test('posts the OpenAI speech payload and returns mp3 bytes', async () => {
    setOpenAITTSConfig({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini-tts',
      voices: 'alloy',
      lookahead: 3,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAISpeechProvider();
    const result = await provider.synthesize(
      { lang: 'en', text: 'hello world', voice: 'alloy', pitch: 1.0 },
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/tts\/openai$/);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini-tts',
      input: 'hello world',
      voice: 'alloy',
      responseFormat: 'mp3',
    });
    expect(result.audio.byteLength).toBe(4);
    expect(result.boundaries).toEqual([]);
  });

  test('caches synthesized audio and serves repeats without refetching', async () => {
    setOpenAITTSConfig({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'tts-1',
      voices: 'alloy',
      lookahead: 3,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAISpeechProvider();
    const req = { lang: 'en', text: 'same sentence', voice: 'alloy', pitch: 1.0 };
    const first = await provider.synthesize(req, new AbortController().signal);
    const second = await provider.synthesize(req, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.audio.byteLength).toBe(4);
    expect(second.audio.byteLength).toBe(4);
    // Callers own their buffer (decode may detach it), so hits return a copy.
    expect(first.audio).not.toBe(second.audio);
  });

  test('passes an empty api key through in the body (proxy decides on auth)', async () => {
    setOpenAITTSConfig({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: '',
      model: 'tts-1',
      voices: 'alloy',
      lookahead: 3,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAISpeechProvider();
    await provider.synthesize(
      { lang: 'en', text: 'hi', voice: 'alloy', pitch: 1.0 },
      new AbortController().signal,
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).apiKey).toBe('');
  });

  test('treats a 4xx as permanent and a 5xx as transient', async () => {
    setOpenAITTSConfig({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'tts-1',
      voices: 'alloy',
      lookahead: 3,
    });
    const provider = new OpenAISpeechProvider();
    const req = { lang: 'en', text: 'hi', voice: 'alloy', pitch: 1.0 };

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('bad voice', { status: 400 })) as unknown as typeof fetch;
    await expect(provider.synthesize(req, new AbortController().signal)).rejects.toBeInstanceOf(
      SpeechSynthesisPermanentError,
    );

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 502 })) as unknown as typeof fetch;
    const transient = await provider
      .synthesize(req, new AbortController().signal)
      .catch((err: unknown) => err);
    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toBeInstanceOf(SpeechSynthesisPermanentError);
  });
});

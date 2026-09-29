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
    expect(clampLookahead(99)).toBe(10);
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

  test('is available and exposes the voices fetched from the server', async () => {
    setOpenAITTSConfig({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'tts-1',
      voices: '',
      lookahead: 3,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ voices: [{ id: 'bfy' }, { id: 'rxd' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAISpeechProvider();
    await expect(provider.init()).resolves.toBe(true);
    const voices = await provider.getAllVoices();
    expect(voices.map((v) => v.id)).toEqual(['bfy', 'rxd']);
    expect(provider.pickDefaultVoice(voices)).toBe('bfy');
    // The fetched list is cached in the config for later/offline reads.
    expect(getOpenAITTSConfig().voices).toBe('bfy,rxd');
  });

  test('keeps a manually entered voice when the server advertises its own list', async () => {
    setOpenAITTSConfig({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: '',
      voices: 'zh-CN-XiaoxiaoNeural',
      lookahead: 3,
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ voices: [{ id: 'alloy' }, { id: 'nova' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const provider = new OpenAISpeechProvider();
    const voices = await provider.getAllVoices();
    // The configured voice stays selectable (and default); server voices append.
    expect(voices.map((v) => v.id)).toEqual(['zh-CN-XiaoxiaoNeural', 'alloy', 'nova']);
    expect(provider.pickDefaultVoice(voices)).toBe('zh-CN-XiaoxiaoNeural');
    // A hand-entered voice must not be clobbered by the fetched list.
    expect(getOpenAITTSConfig().voices).toBe('zh-CN-XiaoxiaoNeural');
  });

  test('falls back to the cached voice list when the server list fails', async () => {
    setOpenAITTSConfig({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: '',
      voices: 'cached-voice',
      lookahead: 3,
    });
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    const provider = new OpenAISpeechProvider();
    const voices = await provider.getAllVoices();
    expect(voices.map((v) => v.id)).toEqual(['cached-voice']);
  });

  test('posts the OpenAI speech payload and returns the raw bytes', async () => {
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
      responseFormat: 'wav',
    });
    expect(result.audio.byteLength).toBe(4);
    expect(result.boundaries).toEqual([]);
  });

  test('wraps a PCM response in a WAV container', async () => {
    setOpenAITTSConfig({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: '',
      model: '',
      voices: 'bfy',
      lookahead: 3,
    });
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0]);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(pcm, {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      }),
    ) as unknown as typeof fetch;

    const provider = new OpenAISpeechProvider();
    const { audio } = await provider.synthesize(
      { lang: 'zh', text: '你好', voice: 'bfy', pitch: 1.0 },
      new AbortController().signal,
    );
    const view = new DataView(audio);
    const tag = (offset: number) => String.fromCharCode(...new Uint8Array(audio, offset, 4));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(36)).toBe('data');
    expect(audio.byteLength).toBe(44 + pcm.byteLength);
    expect(view.getUint32(24, true)).toBe(24000);
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

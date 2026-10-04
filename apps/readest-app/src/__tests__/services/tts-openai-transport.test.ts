import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { isTauriAppPlatform } from '@/services/environment';
import { getAIFetch } from '@/services/ai/utils/httpFetch';
import { fetchOpenAIVoices, synthesizeOpenAI } from '@/services/tts/providers/openaiEndpoint';
import type { OpenAITTSConfig } from '@/services/tts/providers/openaiConfig';

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: vi.fn(() => false),
  getAPIBaseUrl: vi.fn(() => 'https://web.readest.com/api'),
}));

vi.mock('@/services/ai/utils/httpFetch', () => ({
  getAIFetch: vi.fn(),
}));

const config: OpenAITTSConfig = {
  baseUrl: 'https://tts.example.com/v1/',
  apiKey: 'sk-test',
  model: 'tts-1',
  voices: 'alloy',
  lookahead: 3,
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OpenAI TTS transport', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(getAIFetch).mockReset();
    vi.mocked(isTauriAppPlatform).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('web synthesis goes through the same-origin relay', async () => {
    mockFetch.mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200 }));

    await synthesizeOpenAI(config, 'hello', 'alloy');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://web.readest.com/api/tts/openai');
    expect(JSON.parse(init.body as string)).toEqual({
      baseUrl: 'https://tts.example.com/v1/',
      apiKey: 'sk-test',
      model: 'tts-1',
      input: 'hello',
      voice: 'alloy',
      responseFormat: 'wav',
    });
  });

  test('desktop synthesis calls the configured endpoint directly with bearer auth', async () => {
    vi.mocked(isTauriAppPlatform).mockReturnValue(true);
    const directFetch = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200 }));
    vi.mocked(getAIFetch).mockReturnValue(directFetch as unknown as typeof fetch);

    await synthesizeOpenAI(config, 'hello', 'alloy');

    expect(directFetch).toHaveBeenCalledOnce();
    const [url, init] = directFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://tts.example.com/v1/audio/speech');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'tts-1',
      input: 'hello',
      voice: 'alloy',
      response_format: 'wav',
    });
  });

  test('desktop voice discovery normalizes the server list and health sample rate', async () => {
    vi.mocked(isTauriAppPlatform).mockReturnValue(true);
    const directFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ sample_rate: 48000 }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: 'bfy' }, { id: 'rxd' }] }), {
        status: 200,
      });
    });
    vi.mocked(getAIFetch).mockReturnValue(directFetch as unknown as typeof fetch);

    const { voices, sampleRate } = await fetchOpenAIVoices(config);

    expect(voices.map((v) => v.id)).toEqual(['bfy', 'rxd']);
    expect(sampleRate).toBe(48000);
    expect(directFetch.mock.calls[0]![0]).toBe('https://tts.example.com/v1/audio/voices');
    expect(directFetch.mock.calls[1]![0]).toBe('https://tts.example.com/v1/health');
  });
});

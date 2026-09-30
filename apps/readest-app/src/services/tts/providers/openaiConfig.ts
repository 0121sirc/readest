// Configuration for a user-supplied OpenAI-compatible TTS endpoint. Kept in
// localStorage alongside the other TTS preferences (TTSUtils, bookCacheStore)
// so the provider can read it without threading settings through the reader.
//
// The base URL is the API root including the version segment, e.g.
// `https://api.openai.com/v1`; the provider appends `/audio/speech`.

const CONFIG_KEY = 'readest-tts-openai';

export const OPENAI_TTS_MIN_LOOKAHEAD = 1;
export const OPENAI_TTS_MAX_LOOKAHEAD = 10;
export const OPENAI_TTS_DEFAULT_LOOKAHEAD = 5;

// Fixed pause (milliseconds) scheduled after every synthesized chunk. 0
// disables it. Evens out the stalls of an endpoint that cannot quite keep up.
export const OPENAI_TTS_MIN_BLOCK_PADDING_MS = 0;
export const OPENAI_TTS_MAX_BLOCK_PADDING_MS = 5000;
export const OPENAI_TTS_DEFAULT_BLOCK_PADDING_MS = 300;

// Audio container requested from the endpoint. WAV is the widest-supported
// lossless option across OpenAI-compatible servers and is what both live
// playback and the settings Test use, so the test exercises the real path.
export const OPENAI_TTS_RESPONSE_FORMAT = 'wav';

export interface OpenAITTSConfig {
  // API root, e.g. https://api.openai.com/v1. Empty means the engine is off.
  baseUrl: string;
  // Optional: local OpenAI-compatible servers often need no key.
  apiKey: string;
  // Optional: many self-hosted servers ignore or reject an unknown model, so we
  // never prefill one.
  model: string;
  // The single voice id offered in the picker (selected from the server's list).
  voices: string;
  // How many sentences to synthesize ahead of playback (1-6). Self-hosted
  // endpoints can be slow, so overlapping requests keeps audio flowing.
  lookahead: number;
  // Pause in milliseconds after each synthesized chunk (0-5000); see above.
  blockPaddingMs?: number;
}

const DEFAULTS: OpenAITTSConfig = {
  baseUrl: '',
  apiKey: '',
  model: '',
  voices: '',
  lookahead: OPENAI_TTS_DEFAULT_LOOKAHEAD,
  blockPaddingMs: OPENAI_TTS_DEFAULT_BLOCK_PADDING_MS,
};

export const clampLookahead = (value: unknown): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  if (Number.isNaN(n)) return OPENAI_TTS_DEFAULT_LOOKAHEAD;
  return Math.min(OPENAI_TTS_MAX_LOOKAHEAD, Math.max(OPENAI_TTS_MIN_LOOKAHEAD, n));
};

export const clampBlockPaddingMs = (value: unknown): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  if (Number.isNaN(n)) return OPENAI_TTS_DEFAULT_BLOCK_PADDING_MS;
  return Math.min(OPENAI_TTS_MAX_BLOCK_PADDING_MS, Math.max(OPENAI_TTS_MIN_BLOCK_PADDING_MS, n));
};

export const getOpenAITTSConfig = (): OpenAITTSConfig => {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<OpenAITTSConfig>) : {};
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : DEFAULTS.baseUrl,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULTS.apiKey,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULTS.model,
      voices: typeof parsed.voices === 'string' && parsed.voices ? parsed.voices : DEFAULTS.voices,
      lookahead: clampLookahead(parsed.lookahead),
      blockPaddingMs: clampBlockPaddingMs(parsed.blockPaddingMs),
    };
  } catch {
    return { ...DEFAULTS };
  }
};

// Applies to TTS sessions started after the change (the client reads the config
// when it is initialized).
export const setOpenAITTSConfig = (config: OpenAITTSConfig): void => {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Storage full or unavailable; the default config keeps applying.
  }
};

export const isOpenAITTSConfigured = (config: OpenAITTSConfig = getOpenAITTSConfig()): boolean =>
  config.baseUrl.trim().length > 0;

export const parseOpenAIVoices = (voices: string): string[] =>
  voices
    .split(',')
    .map((voice) => voice.trim())
    .filter((voice) => voice.length > 0);

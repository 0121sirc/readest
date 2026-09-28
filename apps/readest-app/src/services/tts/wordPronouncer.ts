import { OpenAISpeechProvider } from './providers/openai';
import {
  getOpenAITTSConfig,
  isOpenAITTSConfigured,
  parseOpenAIVoices,
} from './providers/openaiConfig';
import { TTSUtils } from './TTSUtils';
import { WebAudioPlayer } from './WebAudioPlayer';
import type { TTSAudioContext } from './WebAudioPlayer';

// Speaks a single dictionary word as fast as possible through the configured
// OpenAI-compatible endpoint. Unlike the reader's TTSController, this never
// spins up a full speaking session — it synthesizes one utterance and schedules
// it on a dedicated Web Audio context. When the endpoint is not configured the
// request reports an error (there is no built-in fallback engine any more).

const OPENAI_TTS_NAME = 'openai-tts';

export type PronounceStatus = 'playing' | 'ended' | 'error';

export interface PronounceWordOptions {
  appService?: unknown;
}

// Prefer the user's remembered OpenAI voice for the language, else the first
// configured voice.
export const pickOpenAIVoiceId = (lang: string): string => {
  const voices = parseOpenAIVoices(getOpenAITTSConfig().voices);
  const preferred = TTSUtils.getPreferredVoice(OPENAI_TTS_NAME, lang);
  if (preferred && voices.includes(preferred)) return preferred;
  return voices[0] ?? '';
};

// A dedicated context, isolated from the reader's shared-context TTS so
// pronouncing a word can never resume/suspend or overlap an active read-aloud
// session. Created lazily on first use inside a user gesture (see warmWordAudio).
let dedicatedPlayer: WebAudioPlayer | null = null;
const getPlayer = (): WebAudioPlayer | null => {
  if (typeof AudioContext === 'undefined') return null;
  if (!dedicatedPlayer) {
    dedicatedPlayer = new WebAudioPlayer(() => new AudioContext() as unknown as TTSAudioContext);
  }
  return dedicatedPlayer;
};

const provider = new OpenAISpeechProvider();

// Bumped on every new request so a slower in-flight synthesis can detect it has
// been superseded and bail before touching the player or status.
let requestToken = 0;
let abortController: AbortController | null = null;

// Warm (create + resume) the dedicated audio context. MUST be called
// synchronously from the click handler: pronounceWord resumes the context only
// after a network await, outside WebKit's user-gesture window, where resume()
// is rejected by autoplay policy.
export const warmWordAudio = (): void => {
  const player = getPlayer();
  if (player) void player.ensureContext().catch(() => {});
};

export const cancelWordPronounce = (): void => {
  requestToken++;
  abortController?.abort();
  abortController = null;
  getPlayer()?.abortSession();
};

export const pronounceWord = async (
  word: string,
  lang: string | undefined,
  _options: PronounceWordOptions,
  onStatus?: (status: PronounceStatus) => void,
): Promise<void> => {
  const token = ++requestToken;
  const emit = (status: PronounceStatus) => {
    if (token === requestToken) onStatus?.(status);
  };

  const trimmed = word.trim();
  if (!trimmed) {
    emit('ended');
    return;
  }

  // Stop whatever is currently playing.
  getPlayer()?.abortSession();
  abortController?.abort();

  const player = getPlayer();
  if (!player || !isOpenAITTSConfigured()) {
    emit('error');
    return;
  }

  const voiceLang = lang && lang.length ? lang : 'en';
  const voice = pickOpenAIVoiceId(voiceLang);
  if (!voice) {
    emit('error');
    return;
  }

  const controller = new AbortController();
  abortController = controller;
  try {
    const { audio } = await provider.synthesize(
      { lang: voiceLang, text: trimmed, voice, pitch: 1.0 },
      controller.signal,
    );
    if (token !== requestToken) return;
    const buffer = await player.decode(audio);
    if (token !== requestToken) return;
    const generation = player.startSession((event) => {
      if (event.type === 'session-end') emit('ended');
      else if (event.type === 'context-error') emit('error');
    });
    player.scheduleChunk(generation, buffer, { trimStartSec: 0, mediaScale: 1, gapSec: 0 });
    player.endSession(generation);
    emit('playing');
  } catch (err) {
    if (token === requestToken) {
      console.warn('[dict-tts] pronunciation failed', err);
      emit('error');
    }
  } finally {
    if (abortController === controller) abortController = null;
  }
};

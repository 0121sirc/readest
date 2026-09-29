// The synthesis-side seam of the TTS architecture: a SpeechProvider turns
// text into compressed audio plus word-boundary timings, and nothing else.
// Scheduling, decoding, time-stretch, playout, word tracking, and media
// sessions all live above this seam (BufferedTTSClient and the players), so
// a new engine — another HTTP service, a local model, a system voice
// synthesizing to buffers — is one adapter implementing this contract.
//
// Invariants every provider must uphold:
// - The playback RATE is never sent to the provider. Rate is a playout
//   concern (WSOLA on the web path, AVPlayer timeDomain on iOS), which keeps
//   synthesized audio rate-independent and therefore cacheable.
// - `boundaries` use the Edge wire shape (100ns ticks from stream start,
//   verbatim text spans); providers convert at their edge. Absent boundaries
//   simply degrade word highlighting to sentence highlighting.

import type { TTSVoice } from '../types';

// Word-boundary timing emitted alongside synthesized audio. Offsets and
// durations are in 100-nanosecond ticks relative to the start of the audio
// stream; `text` is the verbatim span of the input text. Providers that have no
// boundary metadata simply return an empty list (word highlighting degrades to
// sentence highlighting).
export interface TTSWordBoundary {
  offset: number;
  duration: number;
  text: string;
}

export interface SpeechSynthesisRequest {
  lang: string;
  text: string;
  voice: string;
  pitch: number;
}

export interface SpeechSynthesisResult {
  // Compressed audio exactly as delivered by the engine. Callers own the
  // buffer (providers must hand out a fresh copy per call: WebKit's
  // decodeAudioData detaches its input).
  audio: ArrayBuffer;
  boundaries: TTSWordBoundary[];
}

// A failure that is permanent for the given sentence (retrying the same
// request cannot succeed). The buffered client skips the sentence instead of
// retrying; anything else thrown from synthesize() is treated as transient.
export class SpeechSynthesisPermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SpeechSynthesisPermanentError';
  }
}

export interface SpeechProvider {
  // Stable identifier: persisted voice/client preferences and cache
  // namespaces key off it, so renaming one is a migration.
  readonly id: string;
  // Human-readable engine name for voice-group headers.
  readonly label: string;
  // Probe/initialize the transport; false means the engine is unavailable
  // (its voices render disabled in the picker).
  init(): Promise<boolean>;
  getAllVoices(): Promise<TTSVoice[]>;
  synthesize(req: SpeechSynthesisRequest, signal: AbortSignal): Promise<SpeechSynthesisResult>;
  // Engine-specific default-voice policy for a language's candidate list
  // (already filtered and sorted); return undefined to accept the first.
  pickDefaultVoice?(voices: TTSVoice[]): string | undefined;
  // Last-resort voice when nothing matched and no voice was ever selected.
  readonly fallbackVoiceId?: string;
  // Whether synthesized audio may be persisted. Some services forbid
  // storing their output; CachingProvider bypasses the store when false.
  readonly cacheable?: boolean;
  // Synthesis is serialized and rate-limited by the server (e.g. a
  // single-worker self-hosted endpoint). The buffered client then skips the
  // controller's parallel preload, which would otherwise queue ahead of the
  // sentence being spoken, and keeps at most one request in flight.
  readonly serialSynthesis?: boolean;
  // Release provider resources (network handles, cache databases) when the
  // owning client shuts down.
  shutdown?(): Promise<void>;
}

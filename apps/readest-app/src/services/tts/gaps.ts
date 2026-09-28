// TTS pause defaults live in this leaf module (no imports) so that
// `src/services/constants.ts` can read them without pulling in the TTS client
// graph — which is mocked in some controller tests and imports `environment`
// back into `constants`. Keeping the values here makes that edge acyclic and
// mock-safe.

// Natural pause between sentences at 1.0x, replacing the silence Edge bakes
// into every utterance: measured at ~0.18s leading and ~0.8s trailing, so ~1s
// of dead air per sentence if it is played as-is (see #5414). The rate scaling
// happens once, before the value reaches the client (see scaleGapForRate).
export const DEFAULT_SENTENCE_GAP_SEC = 0.15;

// Silence inserted between paragraphs when auto-advancing during continuous
// playback, engine-agnostic (handled entirely in TTSController).
export const DEFAULT_PARAGRAPH_GAP_SEC = 0.3;

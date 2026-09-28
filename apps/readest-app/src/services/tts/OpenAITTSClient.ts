import { AppService } from '@/types/system';
import { BufferedTTSClient } from './BufferedTTSClient';
import { OpenAISpeechProvider } from './providers/openai';
import { getOpenAITTSConfig } from './providers/openaiConfig';
import type { TTSController } from './TTSController';
import { TTSCapabilities } from './TTSClient';
import { TTSVoicesGroup } from './types';

// Buffered engine over a user-supplied OpenAI-compatible endpoint. All the
// scheduling/playout lives in BufferedTTSClient; only two things differ from
// Edge: the voice list is multi-lingual (so it is not filtered by the book's
// language) and the endpoint reports no word boundaries.
export class OpenAITTSClient extends BufferedTTSClient {
  constructor(controller?: TTSController, appService?: AppService | null) {
    super(new OpenAISpeechProvider(), controller, appService);
  }

  // OpenAI voices are language-agnostic, so show every configured voice for
  // any requested language and tag it with that language so the picker's
  // per-language preference round-trips.
  override async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    if (!this.initialized || this.voices.length === 0) return [];
    const voices = this.voices.map((voice) => ({ ...voice, lang, disabled: false }));
    return [{ id: this.name, name: this.provider.label, voices }];
  }

  override getCapabilities(): TTSCapabilities {
    // No word-boundary metadata from the endpoint: highlight at the sentence
    // level so the controller does not suppress the sentence highlight waiting
    // for words that never arrive.
    return { ...super.getCapabilities(), wordBoundaries: false };
  }

  // User-tunable look-ahead (Settings → TTS → Custom OpenAI TTS). Self-hosted
  // endpoints can take seconds per sentence, so overlapping synthesis is the
  // difference between gaps and continuous speech.
  protected override getPrefetchDepth(): number {
    return getOpenAITTSConfig().lookahead;
  }
}

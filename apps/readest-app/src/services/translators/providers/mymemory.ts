import { stubTranslation as _ } from '@/utils/misc';
import { normalizeToShortLang } from '@/utils/lang';
import { TranslationProvider } from '../types';
import { splitTextIntoChunks } from '../utils';

/**
 * MyMemory's free public translation API. No key is required for casual use —
 * an optional `de` e-mail parameter raises the anonymous daily quota, but we
 * don't collect one. The endpoint sends `Access-Control-Allow-Origin: *`, so it
 * works from the webview's own network stack on every platform.
 *
 * Constraints verified against the live endpoint:
 * - `langpair` must be `<source>|<target>` and rejects `AUTO`; automatic
 *   detection is spelled `Autodetect`;
 * - a single `q` is capped at 500 characters (not bytes — CJK counts the same),
 *   so longer paragraphs are chunked and stitched back together;
 * - errors (bad language pair, oversized query, exhausted quota) come back as
 *   HTTP 200 with a non-200 `responseStatus` and a human-readable
 *   `responseDetails`, so the body has to be inspected rather than `response.ok`.
 */
const TRANSLATE_URL = 'https://api.mymemory.translated.net/get';
const MAX_CHARS_PER_REQUEST = 500;
// MyMemory throttles bursts; keep the fan-out modest like the other free
// endpoints. The counter is module-level because the limit is per caller.
const MAX_CONCURRENT_REQUESTS = 4;

let activeRequests = 0;
const requestQueue: Array<() => void> = [];

async function withRequestLimit<T>(task: () => Promise<T>): Promise<T> {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests++;
  } else {
    await new Promise<void>((resolve) => requestQueue.push(resolve));
  }
  try {
    return await task();
  } finally {
    const next = requestQueue.shift();
    if (next) next();
    else activeRequests--;
  }
}

const normalizeSource = (sourceLang: string): string => {
  const normalized = normalizeToShortLang(sourceLang);
  // MyMemory spells auto-detection `Autodetect` and rejects `auto`/`AUTO`.
  if (!normalized || normalized.toLowerCase() === 'auto') return 'Autodetect';
  return normalized;
};

const buildUrl = (line: string, sourceLang: string, targetLang: string) => {
  const url = new URL(TRANSLATE_URL);
  url.searchParams.append('q', line);
  url.searchParams.append(
    'langpair',
    `${normalizeSource(sourceLang)}|${normalizeToShortLang(targetLang)}`,
  );
  return url.toString();
};

const translateChunk = async (chunk: string, sourceLang: string, targetLang: string) => {
  const fetch = window.fetch.bind(window);
  const response = await withRequestLimit(() => fetch(buildUrl(chunk, sourceLang, targetLang)));
  if (!response.ok) {
    throw new Error(`Translation failed with status ${response.status}`);
  }
  const data = await response.json();
  const status = typeof data?.responseStatus === 'number' ? data.responseStatus : null;
  if (status !== null && status !== 200) {
    throw new Error(data?.responseDetails || `Translation failed with status ${status}`);
  }
  const translated = data?.responseData?.translatedText;
  return typeof translated === 'string' && translated ? translated : chunk;
};

export const mymemoryProvider: TranslationProvider = {
  name: 'mymemory',
  label: _('MyMemory'),
  translate: async (
    text: string[],
    sourceLang: string,
    targetLang: string,
    _token?: string | null,
    _useCache?: boolean,
    signal?: AbortSignal,
  ): Promise<string[]> => {
    if (!text.length) return [];

    const results: string[] = [];

    await Promise.all(
      text.map(async (line, index) => {
        if (!line?.trim().length) {
          results[index] = line;
          return;
        }
        if (signal?.aborted) throw new DOMException('Translation aborted', 'AbortError');

        const translated = await Promise.all(
          splitTextIntoChunks(line, MAX_CHARS_PER_REQUEST).map((chunk) =>
            translateChunk(chunk, sourceLang, targetLang),
          ),
        );
        results[index] = translated.join('');
      }),
    );

    return results;
  },
};

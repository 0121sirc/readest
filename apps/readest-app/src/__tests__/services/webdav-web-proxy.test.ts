import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { checkConnection } from '@/services/sync/providers/webdav/client';

// In the web build the WebDAV client must not hit the server directly (a
// preflighted PROPFIND is blocked by CORS); it tunnels through our own
// `/api/webdav` route instead.

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
  fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 207 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('web WebDAV transport', () => {
  test('tunnels through the same-origin /api/webdav proxy', async () => {
    const result = await checkConnection(
      { serverUrl: 'https://dav.example.com', username: 'alice', password: 'secret' },
      '/books',
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain('/api/webdav');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Headers;
    expect(headers.get('x-readest-webdav-url')).toBe('https://dav.example.com/books/');
    expect(headers.get('x-readest-webdav-method')).toBe('PROPFIND');
    expect(headers.get('authorization')).toMatch(/^Basic /);
    // `checkConnection` probes with Depth: 0; that must survive the tunnel.
    expect(headers.get('depth')).toBe('0');
  });
});

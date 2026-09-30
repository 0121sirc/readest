import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { checkConnection } from '@/services/sync/providers/webdav/client';

// Servers that only speak Digest (Apache mod_dav, several NAS stacks) reject
// Basic with a 401 challenge. The client must answer it and retry once.

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('webdav digest auth', () => {
  test('retries a 401 Digest challenge with a Digest Authorization header', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Digest realm="WebDAV", nonce="XwUu5KxcBgA=2aad", algorithm=MD5, qop="auth"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 207 }));

    const result = await checkConnection(
      { serverUrl: 'https://dav.example.com', username: 'alice', password: 'secret1234' },
      '/',
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const first = new Headers(fetchMock.mock.calls[0]![1].headers).get('authorization');
    expect(first).toMatch(/^Basic /);

    const second = new Headers(fetchMock.mock.calls[1]![1].headers).get('authorization');
    expect(second).toMatch(/^Digest /);
    expect(second).toContain('response="');
    expect(second).toContain('nonce="XwUu5KxcBgA=2aad"');
  });

  test('answers the challenge renamed by the same-origin tunnel', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            // The tunnel strips WWW-Authenticate (to avoid the browser dialog)
            // and re-exposes the challenge under a custom header.
            'x-readest-webdav-www-authenticate':
              'Digest realm="WebDAV", nonce="tunnel", algorithm=MD5, qop="auth"',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 207 }));

    const result = await checkConnection(
      { serverUrl: 'https://dav.example.com', username: 'alice', password: 'secret1234' },
      '/',
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = new Headers(fetchMock.mock.calls[1]![1].headers).get('authorization');
    expect(second).toMatch(/^Digest /);
  });
});

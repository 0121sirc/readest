import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/webdav/route';

// Same-origin WebDAV tunnel: it must forward the WebDAV verb/headers/body to a
// client-supplied target, refuse non-http(s) and internal targets (unless
// self-hosted), and drop credentials when a server redirects cross-origin.

const proxyReq = (
  target: string,
  method: string,
  headers: Record<string, string> = {},
  body?: string,
) =>
  new NextRequest('http://localhost:3000/api/webdav', {
    method: 'POST',
    headers: {
      'x-readest-webdav-url': target,
      'x-readest-webdav-method': method,
      ...headers,
    },
    body,
  });

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('webdav proxy validation', () => {
  it('requires a target URL', async () => {
    const res = await POST(new NextRequest('http://localhost:3000/api/webdav', { method: 'POST' }));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a WebDAV verb outside the allowlist', async () => {
    const res = await POST(proxyReq('https://dav.example.com/x', 'BREW'));
    expect(res.status).toBe(405);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) schemes', async () => {
    const res = await POST(proxyReq('file:///etc/passwd', 'GET'));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks private hosts when not self-hosted', async () => {
    const res = await POST(proxyReq('http://192.168.1.10/dav', 'PROPFIND', {}, '<p/>'));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows LAN targets when SELF_HOSTED=true', async () => {
    vi.stubEnv('SELF_HOSTED', 'true');
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const res = await POST(proxyReq('http://192.168.1.10/dav', 'PROPFIND', {}, '<p/>'));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('webdav proxy forwarding', () => {
  it('forwards verb, headers and body, and passes the 207 status through', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('<D:multistatus/>', {
        status: 207,
        headers: { 'content-type': 'application/xml', dav: '1, 2' },
      }),
    );

    const res = await POST(
      proxyReq(
        'https://dav.example.com/books',
        'PROPFIND',
        {
          authorization: 'Basic dXNlcjpwYXNz',
          depth: '1',
          'content-type': 'application/xml; charset=utf-8',
        },
        '<D:propfind xmlns:D="DAV:"/>',
      ),
    );

    expect(res.status).toBe(207);
    expect(res.headers.get('dav')).toBe('1, 2');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('<D:multistatus/>');

    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe('https://dav.example.com/books');
    expect(init.method).toBe('PROPFIND');
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Basic dXNlcjpwYXNz');
    expect(headers.get('depth')).toBe('1');
    // PROPFIND bodies are buffered so redirects can replay them.
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toContain('propfind');
  });

  it('drops a Digest Authorization even on a same-origin redirect', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://dav.example.com/books/' },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 401 }));

    const res = await POST(
      proxyReq(
        'https://dav.example.com/books',
        'MKCOL',
        {
          authorization:
            'Digest username="alice", realm="WebDAV", nonce="n", uri="/books", response="x"',
        },
        'x',
      ),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondHeaders = fetchSpy.mock.calls[1]![1].headers as Headers;
    expect(secondHeaders.get('authorization')).toBeNull();
    // The redirect hop's 401 is what the client sees, so it can re-auth.
    expect(res.status).toBe(401);
  });

  it('renames WWW-Authenticate instead of forwarding it (no browser dialog)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('denied', {
        status: 401,
        headers: {
          'www-authenticate': 'Digest realm="WebDAV", nonce="n", algorithm=MD5, qop="auth"',
        },
      }),
    );

    const res = await POST(proxyReq('https://dav.example.com/x', 'PROPFIND', {}, '<p/>'));

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(res.headers.get('x-readest-webdav-www-authenticate')).toContain('Digest');
  });

  it('drops credentials when a redirect leaves the origin', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://mirror.example.net/books/' },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 207 }));

    const res = await POST(
      proxyReq('https://dav.example.com/books', 'PROPFIND', { authorization: 'Basic x' }, '<p/>'),
    );

    expect(res.status).toBe(207);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondHeaders = fetchSpy.mock.calls[1]![1].headers as Headers;
    expect(secondHeaders.get('authorization')).toBeNull();
  });
});

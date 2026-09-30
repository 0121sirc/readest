import { NextRequest, NextResponse } from 'next/server';
import { isBlockedHost } from '@/utils/network';

// Same-origin tunnel for the web build's WebDAV transport.
//
// The browser can't call a WebDAV server directly: a PROPFIND/PUT carries
// `Authorization`, `Depth` and a non-safelisted `Content-Type`, so the request
// is preflighted and blocked unless the *WebDAV server* sends CORS headers —
// which self-hosted servers almost never do. Tauri sidesteps this with the
// native HTTP plugin; the web build cannot.
//
// This route forwards the request from our own origin instead. It is a POST
// tunnel rather than one route method per WebDAV verb because Next's route
// handlers only dispatch the standard methods (PROPFIND/MKCOL have no handler):
// the real method and target travel in `x-readest-webdav-*` headers and the
// body is passed through untouched.
//
// Payload is buffered so a redirect can replay it (a stream body can't be sent
// twice). WebDAV book transfers are already buffered in the browser, so this
// does not regress a streaming path that exists on web today.

export const dynamic = 'force-dynamic';

// Cap redirect hops so the SSRF host check re-runs on every one.
const MAX_REDIRECTS = 5;

// WebDAV verbs the sync engine issues, plus the standard ones a server may
// redirect through. Anything else is rejected rather than blindly forwarded.
const ALLOWED_METHODS = new Set([
  'PROPFIND',
  'PROPPATCH',
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'MKCOL',
  'DELETE',
  'MOVE',
  'COPY',
  'OPTIONS',
]);

// Request headers worth forwarding. The rest (cookies, host, hop-by-hop, our
// own x-readest-* control headers) are dropped.
const FORWARDED_REQUEST_HEADERS = [
  'authorization',
  'depth',
  'destination',
  'overwrite',
  'if-match',
  'if-none-match',
  'range',
  'content-type',
];

// Response headers the WebDAV client reads (status parsing, HEAD sizes, ETags).
// `www-authenticate` is deliberately NOT forwarded: a 401 carrying it makes the
// renderer open its native credential dialog for the `/api/webdav` response.
// The challenge is renamed below so the client can still answer Digest.
const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-range',
  'content-disposition',
  'accept-ranges',
  'etag',
  'last-modified',
  'dav',
  'cache-control',
]);

/** Renamed `WWW-Authenticate`, readable same-origin, safe for the renderer. */
const AUTH_CHALLENGE_HEADER = 'x-readest-webdav-www-authenticate';

/** Set by the client when it accepts the server's self-signed certificate. */
const INSECURE_TLS_HEADER = 'x-readest-webdav-insecure';

// Native fetch (undici) has no per-request "ignore certificate" option, so the
// only lever on Node is the process-wide NODE_TLS_REJECT_UNAUTHORIZED. Swapping
// it around a single request is racy, so insecure requests are serialized: at
// most one takes the process-wide bypass at a time. On the Cloudflare edge this
// is a no-op (and self-signed LAN hosts are unreachable there anyway).
let insecureChain: Promise<unknown> = Promise.resolve();
const fetchUpstream = async (
  url: string,
  init: RequestInit,
  insecure: boolean,
): Promise<Response> => {
  if (!insecure || typeof process === 'undefined') return fetch(url, init);
  const run = async () => {
    const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      return await fetch(url, init);
    } finally {
      if (previous === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
    }
  };
  const result = insecureChain.then(run, run);
  insecureChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

// Hop-by-hop headers must not cross the proxy boundary. `content-encoding` is
// dropped because `fetch` has already decoded the body, so forwarding it would
// make the browser decode a second time.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'content-encoding',
]);

// A self-hosted / LAN deployment reaches its own private WebDAV on purpose;
// the hosted edge has no internal network to protect, and neither does a
// production server that should not be an open SSRF relay. Mirrors the OPDS
// proxy, plus SELF_HOSTED so a Docker/LAN deployment can use LAN targets.
const isPrivateHostAllowed = (): boolean =>
  process.env.NODE_ENV === 'development' ||
  process.env['SELF_HOSTED'] === 'true' ||
  process.env['NEXT_PUBLIC_SELF_HOSTED'] === 'true';

class WebDAVProxyError extends Error {}

const validateTarget = (raw: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WebDAVProxyError('Invalid target URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebDAVProxyError('Only http(s) URLs are supported');
  }
  if (!isPrivateHostAllowed() && isBlockedHost(parsed.hostname)) {
    throw new WebDAVProxyError('This URL is not allowed');
  }
  return parsed;
};

const buildResponse = (upstream: Response): Response => {
  const headers = new Headers();
  const encoded = upstream.headers.has('content-encoding');
  for (const [key, value] of upstream.headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (!FORWARDED_RESPONSE_HEADERS.has(lower)) continue;
    // The decoded body no longer matches a compressed Content-Length.
    if (lower === 'content-length' && encoded) continue;
    headers.set(key, value);
  }
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  // Hand the auth challenge to the client without the renderer's native dialog.
  const challenge = upstream.headers.get('www-authenticate');
  if (challenge) {
    try {
      headers.set(AUTH_CHALLENGE_HEADER, challenge);
    } catch {
      // Header values must be byte strings; a malformed challenge is dropped.
    }
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
};

export async function POST(request: NextRequest): Promise<Response> {
  const target = request.headers.get('x-readest-webdav-url');
  const method = (request.headers.get('x-readest-webdav-method') ?? '').toUpperCase();

  if (!target) {
    return NextResponse.json({ error: 'Missing x-readest-webdav-url header' }, { status: 400 });
  }
  if (!ALLOWED_METHODS.has(method)) {
    return NextResponse.json(
      { error: `Method not allowed: ${method || '(none)'}` },
      { status: 405 },
    );
  }

  // GET/HEAD carry no body; everything else may. Buffer so redirects can replay.
  const buffered = ['GET', 'HEAD'].includes(method) ? undefined : await request.arrayBuffer();
  const body = buffered && buffered.byteLength > 0 ? buffered : undefined;
  const insecure = request.headers.get(INSECURE_TLS_HEADER) === '1';

  const baseHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) baseHeaders.set(name, value);
  }

  try {
    const authOrigin = validateTarget(target).origin;
    // A Digest `Authorization` is bound to the exact request target, so it can
    // never be replayed across a redirect (servers reject the mismatch, often
    // with a bare 400). Drop it on any hop and let the server hand back a fresh
    // challenge instead of forwarding a stale one.
    const digestAuth = (baseHeaders.get('authorization') ?? '').toLowerCase().startsWith('digest ');
    let current = target;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = validateTarget(current);
      const headers = new Headers(baseHeaders);
      // Only a redirected hop loses the credentials: a Digest header can't be
      // replayed to a new target, and cross-origin must not leak them. The
      // first hop keeps whatever the client sent.
      if (hop > 0 && (digestAuth || parsed.origin !== authOrigin) && headers.has('authorization')) {
        headers.delete('authorization');
      }
      const upstream = await fetchUpstream(
        parsed.toString(),
        { method, headers, body, redirect: 'manual' },
        insecure,
      );
      if ([301, 302, 303, 307, 308].includes(upstream.status) && upstream.headers.has('location')) {
        const location = upstream.headers.get('location')!;
        await upstream.body?.cancel();
        current = new URL(location, parsed).toString();
        continue;
      }
      return buildResponse(upstream);
    }
    throw new WebDAVProxyError('Too many redirects');
  } catch (error) {
    if (error instanceof WebDAVProxyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `WebDAV proxy failed: ${message}` }, { status: 502 });
  }
}

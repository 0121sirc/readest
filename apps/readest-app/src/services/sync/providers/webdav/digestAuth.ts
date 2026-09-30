import { md5 } from 'js-md5';

/**
 * Minimal HTTP Digest authentication (RFC 7616 / RFC 2617) for the WebDAV
 * client.
 *
 * Plenty of self-hosted WebDAV servers (Apache mod_dav here, but also some NAS
 * stacks) advertise `Digest` with `algorithm=MD5, qop="auth"` and reject Basic
 * outright. The browser can't do this for us: `fetch` never answers a Digest
 * challenge on its own, and letting the challenge reach the renderer makes the
 * browser open its native credential dialog. So we parse the challenge and
 * build the response ourselves.
 *
 * Only MD5 (plain, and MD5-sess) is implemented — the algorithms Apache emits
 * by default. SHA-256 challenges return `null` and the caller falls back to
 * surfacing the 401.
 */

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  algorithm?: string;
  /** Raw `qop` value, e.g. `auth` or `auth,auth-int`. */
  qop?: string;
}

const UNQUOTE_RE = /^"(.*)"$/s;

const paramValue = (raw: string): string => {
  const trimmed = raw.trim();
  const match = UNQUOTE_RE.exec(trimmed);
  return match ? match[1]! : trimmed;
};

/**
 * Parse the `Digest` challenge from a `WWW-Authenticate` header value. Returns
 * null when the header is absent or isn't a Digest challenge (the header may
 * list several schemes).
 */
export const parseDigestChallenge = (header: string | null | undefined): DigestChallenge | null => {
  if (!header) return null;
  const start = header.toLowerCase().indexOf('digest');
  if (start < 0) return null;

  const params: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(header.slice(start + 'digest'.length))) !== null) {
    params[match[1]!.toLowerCase()] = paramValue(match[2] ?? match[3] ?? '');
  }

  if (!params['realm'] || !params['nonce']) return null;
  return {
    realm: params['realm'],
    nonce: params['nonce'],
    opaque: params['opaque'],
    algorithm: params['algorithm'],
    qop: params['qop'],
  };
};

const randomHex = (bytes: number): string => {
  const array = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(array);
  } else {
    for (let i = 0; i < bytes; i++) array[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
};

export interface DigestAuthArgs {
  challenge: DigestChallenge;
  method: string;
  /** Request-URI exactly as sent (path + query), percent-encoded. */
  uri: string;
  username: string;
  password: string;
  /** Test seams: a fixed client nonce / nonce count. */
  cnonce?: string;
  nc?: string;
}

/**
 * Build the `Authorization: Digest …` header for a challenge, or null when the
 * challenge asks for an algorithm we don't implement.
 */
export const buildDigestAuthorization = (args: DigestAuthArgs): string | null => {
  const { challenge, method, uri, username, password } = args;
  const algorithm = (challenge.algorithm ?? 'MD5').toUpperCase();
  if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') return null;

  const useQop = (challenge.qop ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .includes('auth');
  const cnonce = args.cnonce ?? randomHex(16);
  const nc = args.nc ?? '00000001';

  const ha1Base = md5(`${username}:${challenge.realm}:${password}`);
  const ha1 = algorithm === 'MD5-SESS' ? md5(`${ha1Base}:${challenge.nonce}:${cnonce}`) : ha1Base;
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);
  const response = useQop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
    challenge.opaque ? `opaque="${challenge.opaque}"` : '',
    useQop ? `qop=auth` : '',
    useQop ? `nc=${nc}` : '',
    useQop ? `cnonce="${cnonce}"` : '',
  ].filter(Boolean);

  return `Digest ${parts.join(', ')}`;
};

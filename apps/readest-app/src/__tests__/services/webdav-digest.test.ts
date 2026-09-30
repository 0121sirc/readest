import { describe, expect, test } from 'vitest';
import {
  buildDigestAuthorization,
  parseDigestChallenge,
} from '@/services/sync/providers/webdav/digestAuth';

describe('parseDigestChallenge', () => {
  test('parses the Apache mod_dav challenge', () => {
    const challenge = parseDigestChallenge(
      'Digest realm="WebDAV", nonce="XwUu5KxcBgA=2aad3a14", algorithm=MD5, qop="auth"',
    );
    expect(challenge).toEqual({
      realm: 'WebDAV',
      nonce: 'XwUu5KxcBgA=2aad3a14',
      algorithm: 'MD5',
      qop: 'auth',
      opaque: undefined,
    });
  });

  test('returns null for Basic or a missing header', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
    expect(parseDigestChallenge(null)).toBeNull();
  });
});

describe('buildDigestAuthorization', () => {
  // RFC 2617 §3.5 worked example.
  test('matches the RFC 2617 MD5 + qop=auth vector', () => {
    const header = buildDigestAuthorization({
      challenge: {
        realm: 'testrealm@host.com',
        nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
        qop: 'auth',
        opaque: '5ccc069c403ebaf9f0171e9517f40e41',
        algorithm: 'MD5',
      },
      method: 'GET',
      uri: '/dir/index.html',
      username: 'Mufasa',
      password: 'Circle Of Life',
      cnonce: '0a4f113b',
      nc: '00000001',
    });

    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=00000001');
    expect(header).toContain('cnonce="0a4f113b"');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  test('supports challenges without qop', () => {
    const header = buildDigestAuthorization({
      challenge: { realm: 'WebDAV', nonce: 'abc', algorithm: 'MD5' },
      method: 'PROPFIND',
      uri: '/',
      username: 'alice',
      password: 'secret',
      cnonce: 'deadbeef',
    });
    expect(header).toMatch(/^Digest /);
    expect(header).toContain('response="');
    expect(header).not.toContain('qop=');
  });

  test('declines algorithms it does not implement', () => {
    expect(
      buildDigestAuthorization({
        challenge: { realm: 'r', nonce: 'n', algorithm: 'SHA-256' },
        method: 'GET',
        uri: '/',
        username: 'a',
        password: 'b',
      }),
    ).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/services/environment', () => ({
  getAPIBaseUrl: vi.fn(() => 'https://web.readest.com/api'),
}));

vi.mock('@/utils/access', () => ({
  getAccessToken: vi.fn(async () => 'token-123'),
}));

import { fetchGatewayRoute } from '@/services/ai/utils/gatewayRoute';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('fetchGatewayRoute', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('resolves the route against the configured API base and attaches the bearer token', async () => {
    await fetchGatewayRoute('chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://web.readest.com/api/ai/chat');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer token-123');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});

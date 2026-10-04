import { getAPIBaseUrl } from '@/services/environment';
import { getAccessToken } from '@/utils/access';

/**
 * Transport for the AI Gateway proxy routes (`/api/ai/chat`, `/api/ai/embed`).
 *
 * The Tauri build is a static export with no `/api` server, so a bare
 * `/api/ai/*` fetch resolves against `tauri://localhost` and 404s. Routing
 * through `getAPIBaseUrl()` sends it to the configured Readest web API
 * (`Server` settings) instead. The routes authenticate via bearer token, so
 * the token is attached when one is available.
 */
export const fetchGatewayRoute = async (path: string, init: RequestInit): Promise<Response> => {
  const token = await getAccessToken();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(`${getAPIBaseUrl()}/ai/${path}`, { ...init, headers });
};

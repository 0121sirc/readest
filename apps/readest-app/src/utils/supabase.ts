import { createClient } from '@supabase/supabase-js';
import { getRuntimeConfig } from '@/services/runtimeConfig';

const supabaseUrl =
  getRuntimeConfig()?.supabaseUrl ||
  process.env['SUPABASE_URL'] ||
  process.env['NEXT_PUBLIC_SUPABASE_URL'] ||
  atob(process.env['NEXT_PUBLIC_DEFAULT_SUPABASE_URL_BASE64']!);
const supabaseAnonKey =
  getRuntimeConfig()?.supabaseAnonKey ||
  process.env['SUPABASE_ANON_KEY'] ||
  process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
  atob(process.env['NEXT_PUBLIC_DEFAULT_SUPABASE_KEY_BASE64']!);

// Local-first mode has no account, so the auth client must never touch the
// network on its own. `createClient` defaults to `autoRefreshToken` +
// `persistSession` + `detectSessionInUrl`, and with a stale session left in
// localStorage it fires a background refresh against Supabase on every load —
// an unhandled `TypeError: Failed to fetch` when that host is unreachable.
// Duplicated from `access.isReadestAccountHidden` to avoid a module cycle
// (`access` imports this file).
const accountHidden = (() => {
  const config = getRuntimeConfig();
  if (config?.disableReadestAccount !== undefined) return config.disableReadestAccount;
  const raw = process.env['NEXT_PUBLIC_DISABLE_READEST_ACCOUNT'];
  if (raw !== undefined && raw !== '') return raw === 'true' || raw === '1';
  return process.env['NODE_ENV'] !== 'test';
})();

export const supabase = accountHidden
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : createClient(supabaseUrl, supabaseAnonKey);

export const createSupabaseClient = (accessToken?: string) => {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : {},
    },
  });
};

export const createSupabaseAdminClient = () => {
  const supabaseAdminKey = process.env['SUPABASE_ADMIN_KEY'] || '';
  return createClient(supabaseUrl, supabaseAdminKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
};

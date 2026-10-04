import type { ServerSettings } from '@/types/settings';

/**
 * Synchronous mirror of `SystemSettings.server`.
 *
 * `getBaseUrl()` and friends are called from module-scope constants and
 * low-level helpers that cannot await the settings load, so the loader writes
 * the persisted server slice here once settings are read, and the settings
 * save path refreshes it on every edit. Before the first write the getters
 * fall through to the runtime config / baked `NEXT_PUBLIC_*` values.
 */
let serverConfig: ServerSettings | undefined;

export const setServerConfig = (config: ServerSettings | undefined): void => {
  serverConfig = config;
};

export const getServerConfig = (): ServerSettings | undefined => serverConfig;

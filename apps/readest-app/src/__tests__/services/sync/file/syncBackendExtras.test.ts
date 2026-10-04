import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { EnvConfigType } from '@/services/environment';
import type { SystemSettings } from '@/types/settings';

const syncAppSettings = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>) => ({ applied: false, pushed: false })),
);
const syncAssets = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>) => ({ applied: 0, pushed: 0, downloaded: 0 })),
);

vi.mock('@/services/sync/file/settingsSync', () => ({ syncAppSettings }));
vi.mock('@/services/sync/file/assetSync', () => ({ syncAssets }));

import { syncBackendExtras } from '@/services/sync/file/runLibrarySync';
import { useSettingsStore } from '@/store/settingsStore';

const baseSettings = (webdav: Record<string, unknown> = {}): SystemSettings =>
  ({
    version: 1,
    webdav: {
      enabled: true,
      serverUrl: 'https://dav.example.com',
      rootPath: '/Readest',
      username: 'alice',
      ...webdav,
    },
  }) as SystemSettings;

const saveSettings = vi.fn(async () => {});
const envConfig = {
  getAppService: vi.fn(async () => ({ saveSettings }) as never),
} as unknown as EnvConfigType;

const provider = { rootPath: '/' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.getState().setSettings(baseSettings());
});

describe('syncBackendExtras', () => {
  test('runs both the settings and the asset step', async () => {
    await syncBackendExtras(envConfig, 'webdav', provider);

    expect(syncAppSettings).toHaveBeenCalledTimes(1);
    expect(syncAssets).toHaveBeenCalledTimes(1);
  });

  // This is the gap the manual "Sync now" button had: it reconciled books but
  // left the portable preferences and imported assets behind.
  test('honours the per-backend sub-toggles', async () => {
    useSettingsStore.getState().setSettings(baseSettings({ syncSettings: false }));

    await syncBackendExtras(envConfig, 'webdav', provider);

    expect(syncAppSettings).not.toHaveBeenCalled();
    expect(syncAssets).toHaveBeenCalledTimes(1);
  });

  test('scopes both steps to the endpoint the backend points at', async () => {
    await syncBackendExtras(envConfig, 'webdav', provider);

    expect(syncAppSettings.mock.calls[0]![0]).toMatchObject({
      backendKind: 'webdav',
      scope: expect.stringMatching(/\S/),
    });
    expect(syncAssets.mock.calls[0]![0]).toMatchObject({ backendKind: 'webdav' });
  });

  test('passes the remote-wins flag through to the settings step', async () => {
    await syncBackendExtras(envConfig, 'webdav', provider, { preferRemote: true });

    expect(syncAppSettings.mock.calls[0]![0]).toMatchObject({ preferRemote: true });
  });

  test('isolates a settings failure so the asset step still runs', async () => {
    syncAppSettings.mockRejectedValueOnce(new Error('boom'));

    await expect(syncBackendExtras(envConfig, 'webdav', provider)).resolves.toBeUndefined();
    expect(syncAssets).toHaveBeenCalledTimes(1);
  });
});

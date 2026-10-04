import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

import type { SystemSettings } from '@/types/settings';
import type { FileSyncProvider } from '@/services/sync/file/provider';

const hoisted = vi.hoisted(() => {
  const state: { settings: SystemSettings } = { settings: {} as SystemSettings };
  const tts = {
    baseUrl: 'https://tts.example.com/v1',
    apiKey: 'TTS-SECRET',
    model: 'tts-1',
    voices: 'alloy',
    lookahead: 5,
    blockPaddingMs: 300,
  };
  return { state, tts };
});

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      settings: hoisted.state.settings,
      setSettings: (next: SystemSettings) => {
        hoisted.state.settings = next;
      },
    }),
  },
}));

vi.mock('@/services/tts/providers/openaiConfig', () => ({
  getOpenAITTSConfig: () => ({ ...hoisted.tts }),
  setOpenAITTSConfig: (config: { apiKey?: string }) => {
    Object.assign(hoisted.tts, config);
  },
}));

import { syncAppSettings, SETTINGS_SYNC_VERSION } from '@/services/sync/file/settingsSync';

const SNAPSHOT_KEY = 'readest_file_settings_sync_v1:webdav';

const baseSettings = (): SystemSettings =>
  ({
    globalViewSettings: {
      defaultFontSize: 16,
      marginLeftPx: 16,
      backgroundTextureId: 'none',
    },
    globalReadSettings: {
      translationProvider: 'mymemory',
      translateTargetLang: 'EN',
      notebookActiveTab: 'notes',
    },
    aiSettings: {
      enabled: true,
      provider: 'openrouter',
      openrouterBaseUrl: 'https://openrouter.ai/api/v1',
      openrouterApiKey: 'AI-SECRET',
      aiGatewayApiKey: 'GATEWAY-SECRET',
    },
    dictionarySettings: { providerOrder: ['builtin:system'], providerEnabled: {} },
  }) as unknown as SystemSettings;

const makeProvider = () => {
  const writes: { path: string; body: string }[] = [];
  let remote: string | null = null;
  const provider = {
    rootPath: '/',
    writes,
    setRemote: (value: string | null) => {
      remote = value;
    },
    readText: async () => remote,
    writeText: async (path: string, body: string) => {
      writes.push({ path, body });
      remote = body;
    },
    ensureDir: async () => {},
    readBinary: async () => null,
    writeBinary: async () => {},
    head: async () => null,
    list: async () => [],
    deleteDir: async () => {},
  };
  return provider as unknown as FileSyncProvider & {
    writes: { path: string; body: string }[];
    setRemote: (value: string | null) => void;
  };
};

const parseLast = (provider: FileSyncProvider & { writes: { body: string }[] }) =>
  JSON.parse(provider.writes[provider.writes.length - 1]!.body) as {
    version: number;
    sections: Record<string, { t: number; v: Record<string, unknown> }>;
  };

/**
 * Publish a complete payload (every section, so a pull cannot fall back to
 * pushing the sections the fixture remote lacks) stamped at `t`, with the
 * reader's font size set to `fontSize`. Written under a throwaway scope so the
 * run does not stamp the endpoint under test.
 */
const seedRemoteSections = async (
  provider: FileSyncProvider & {
    writes: { body: string }[];
    setRemote: (v: string | null) => void;
  },
  fontSize: number,
  t: number,
) => {
  await syncAppSettings({
    provider,
    backendKind: 'webdav',
    scope: 'seed',
    saveSettings: async () => {},
  });
  const payload = parseLast(provider);
  for (const [name, section] of Object.entries(payload.sections)) {
    payload.sections[name] = { t, v: section.v };
  }
  payload.sections['globalViewSettings'] = {
    t,
    v: { ...payload.sections['globalViewSettings']!.v, defaultFontSize: fontSize },
  };
  provider.setRemote(JSON.stringify(payload));
};

describe('syncAppSettings', () => {
  let saveSettings: Mock<(next: SystemSettings) => Promise<void>>;

  beforeEach(() => {
    localStorage.clear();
    hoisted.state.settings = baseSettings();
    hoisted.tts.apiKey = 'TTS-SECRET';
    saveSettings = vi.fn<(next: SystemSettings) => Promise<void>>(async () => {});
  });

  test('first run on a fresh remote pushes the portable sections', async () => {
    const provider = makeProvider();

    const result = await syncAppSettings({ provider, backendKind: 'webdav', saveSettings });

    expect(result).toEqual({ applied: false, pushed: true });
    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]!.path).toBe('/Readest/settings.json');
    const payload = parseLast(provider);
    expect(payload.version).toBe(SETTINGS_SYNC_VERSION);
    expect(Object.keys(payload.sections).sort()).toEqual(
      [
        'aiSettings',
        'dictionarySettings',
        'globalReadSettings',
        'globalViewSettings',
        'libraryBackground',
        'tts',
      ].sort(),
    );
  });

  test('never writes secrets to the wire', async () => {
    const provider = makeProvider();
    await syncAppSettings({ provider, backendKind: 'webdav', saveSettings });

    const payload = parseLast(provider);
    expect(payload.sections['aiSettings']!.v).not.toHaveProperty('openrouterApiKey');
    expect(payload.sections['aiSettings']!.v).not.toHaveProperty('aiGatewayApiKey');
    expect(payload.sections['tts']!.v).not.toHaveProperty('apiKey');
    // Device-local fields are excluded; the selected textures now sync.
    expect(payload.sections['globalViewSettings']!.v).toHaveProperty('backgroundTextureId');
    expect(payload.sections['globalReadSettings']!.v).not.toHaveProperty('notebookActiveTab');
    expect(payload.sections['libraryBackground']).toBeDefined();
  });

  test('applies a newer remote section and keeps local secrets', async () => {
    const provider = makeProvider();
    await syncAppSettings({ provider, backendKind: 'webdav', saveSettings }); // seed snapshot + remote

    const seeded = parseLast(provider);
    provider.setRemote(
      JSON.stringify({
        version: SETTINGS_SYNC_VERSION,
        sections: {
          ...seeded.sections,
          globalViewSettings: {
            t: Date.now() + 60_000,
            v: { ...seeded.sections['globalViewSettings']!.v, defaultFontSize: 42 },
          },
        },
      }),
    );

    const result = await syncAppSettings({ provider, backendKind: 'webdav', saveSettings });

    expect(result.applied).toBe(true);
    expect(result.pushed).toBe(false);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(hoisted.state.settings.globalViewSettings.defaultFontSize).toBe(42);
    // The local AI key survived the remote merge.
    expect(hoisted.state.settings.aiSettings.openrouterApiKey).toBe('AI-SECRET');
  });

  test('pushes a local edit that landed after the last snapshot', async () => {
    const provider = makeProvider();
    await syncAppSettings({ provider, backendKind: 'webdav', saveSettings });

    hoisted.state.settings = {
      ...hoisted.state.settings,
      globalViewSettings: { ...hoisted.state.settings.globalViewSettings, defaultFontSize: 20 },
    };

    const result = await syncAppSettings({ provider, backendKind: 'webdav', saveSettings });

    expect(result.pushed).toBe(true);
    expect(parseLast(provider).sections['globalViewSettings']!.v['defaultFontSize']).toBe(20);
  });

  test('a steady state writes nothing on the second run', async () => {
    const provider = makeProvider();
    await syncAppSettings({ provider, backendKind: 'webdav', saveSettings });
    const writesAfterFirst = provider.writes.length;

    const result = await syncAppSettings({ provider, backendKind: 'webdav', saveSettings });

    expect(result).toEqual({ applied: false, pushed: false });
    expect(provider.writes).toHaveLength(writesAfterFirst);
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeTruthy();
  });

  // Repointing WebDAV at a different server must not inherit the previous
  // endpoint's stamps: the new target has never seen this device's settings,
  // so a stamp written for the old server would silently skip publishing.
  test('snapshots are scoped per endpoint, so a repointed backend re-publishes', async () => {
    const provider = makeProvider();

    await syncAppSettings({
      provider,
      backendKind: 'webdav',
      scope: 'endpoint-a',
      saveSettings,
    });
    const writesAfterA = provider.writes.length;

    // Same endpoint, nothing changed: the stamp holds it steady.
    expect(
      (
        await syncAppSettings({
          provider,
          backendKind: 'webdav',
          scope: 'endpoint-a',
          saveSettings,
        })
      ).pushed,
    ).toBe(false);
    expect(provider.writes).toHaveLength(writesAfterA);

    // Same backend kind, new endpoint: endpoint A's stamp must not mask the
    // local state, and A's own key must survive for when the user switches back.
    const result = await syncAppSettings({
      provider,
      backendKind: 'webdav',
      scope: 'endpoint-b',
      saveSettings,
    });

    expect(result.pushed).toBe(true);
    expect(provider.writes.length).toBeGreaterThan(writesAfterA);
    expect(localStorage.getItem(`${SNAPSHOT_KEY}:endpoint-a`)).toBeTruthy();
    expect(localStorage.getItem(`${SNAPSHOT_KEY}:endpoint-b`)).toBeTruthy();
  });

  // The endpoint-replace flow (a Connect that chose "remote wins") must let the
  // new server's preferences through instead of having the device's local edit
  // beat them just because this device has no stamp yet.
  test('preferRemote applies the remote value over a stamp-less local edit', async () => {
    const provider = makeProvider();
    await seedRemoteSections(provider, 42, Date.now() - 60_000);

    const result = await syncAppSettings({
      provider,
      backendKind: 'webdav',
      scope: 'endpoint-b',
      preferRemote: true,
      saveSettings,
    });

    expect(result).toEqual({ applied: true, pushed: false });
    expect(hoisted.state.settings.globalViewSettings.defaultFontSize).toBe(42);
  });

  test('without preferRemote the same stamp-less local edit wins', async () => {
    const provider = makeProvider();
    await seedRemoteSections(provider, 42, Date.now() - 60_000);

    const result = await syncAppSettings({
      provider,
      backendKind: 'webdav',
      scope: 'endpoint-b',
      saveSettings,
    });

    expect(result.pushed).toBe(true);
    expect(result.applied).toBe(false);
    expect(hoisted.state.settings.globalViewSettings.defaultFontSize).toBe(16);
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { EnvConfigType } from '@/services/environment';

const hoisted = vi.hoisted(() => {
  interface Row {
    id: string;
    name: string;
    path: string;
    bundleDir?: string;
    contentId?: string;
    byteSize?: number;
    loaded?: boolean;
    deletedAt?: number;
  }
  const fontState = { rows: [] as Row[] };
  const applyRemoteFont = vi.fn((font: Row) => {
    const i = fontState.rows.findIndex((f) => f.id === font.id);
    if (i >= 0) fontState.rows[i] = font;
    else fontState.rows.push(font);
  });
  const softDeleteFont = vi.fn((contentId: string) => {
    fontState.rows = fontState.rows.map((f) =>
      f.contentId === contentId ? { ...f, deletedAt: Date.now() } : f,
    );
  });
  const activateFont = vi.fn(async () => {});
  const textureState = { rows: [] as Row[] };
  const dictState = { rows: [] as Record<string, unknown>[] };

  return {
    fontState,
    applyRemoteFont,
    softDeleteFont,
    activateFont,
    textureState,
    dictState,
  };
});

vi.mock('@/store/customFontStore', () => ({
  useCustomFontStore: {
    getState: () => ({
      get fonts() {
        return hoisted.fontState.rows;
      },
      applyRemoteFont: hoisted.applyRemoteFont,
      softDeleteByContentId: hoisted.softDeleteFont,
      activateFontByContentId: hoisted.activateFont,
    }),
  },
}));

vi.mock('@/store/customTextureStore', () => ({
  useCustomTextureStore: {
    getState: () => ({
      get textures() {
        return hoisted.textureState.rows;
      },
      applyRemoteTexture: vi.fn(),
      softDeleteByContentId: vi.fn(),
      activateTextureByContentId: vi.fn(async () => {}),
    }),
  },
}));

vi.mock('@/store/customDictionaryStore', () => ({
  useCustomDictionaryStore: {
    getState: () => ({
      get dictionaries() {
        return hoisted.dictState.rows;
      },
      applyRemoteDictionary: vi.fn(),
      softDeleteByContentId: vi.fn(),
      markAvailableByContentId: vi.fn(),
    }),
  },
}));

import { syncAssets } from '@/services/sync/file/assetSync';
import type { FileSyncProvider } from '@/services/sync/file/provider';

interface FakeProvider extends FileSyncProvider {
  writes: { path: string; body: string }[];
  remoteFiles: Map<string, ArrayBuffer>;
  setManifest: (manifest: unknown) => void;
  getManifest: () => string | null;
}

const makeProvider = () => {
  let manifest: string | null = null;
  const remoteFiles = new Map<string, ArrayBuffer>();
  const writes: { path: string; body: string }[] = [];
  const provider = {
    rootPath: '/',
    writes,
    remoteFiles,
    setManifest: (value: unknown) => {
      manifest = value === null ? null : JSON.stringify(value);
    },
    getManifest: () => manifest,
    readText: async (path: string) => (path.endsWith('manifest.json') ? manifest : null),
    writeText: async (path: string, body: string) => {
      writes.push({ path, body });
      if (path.endsWith('manifest.json')) manifest = body;
    },
    readBinary: async (path: string) => remoteFiles.get(path) ?? null,
    writeBinary: async (path: string, body: ArrayBuffer) => {
      remoteFiles.set(path, body);
    },
    head: async (path: string) => (remoteFiles.has(path) ? { size: 1 } : null),
    list: async () => [],
    ensureDir: async () => {},
    deleteDir: async () => {},
  };
  return provider as unknown as FakeProvider;
};

const FONT_PATH = '/Readest/Assets/Fonts/cid1/MyFont.ttf';

describe('syncAssets', () => {
  let appFiles: Map<string, ArrayBuffer>;
  let appService: {
    exists: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    createDir: ReturnType<typeof vi.fn>;
    resolveFilePath: ReturnType<typeof vi.fn>;
  };
  let envConfig: EnvConfigType;

  beforeEach(() => {
    localStorage.clear();
    hoisted.fontState.rows = [];
    hoisted.textureState.rows = [];
    hoisted.dictState.rows = [];
    hoisted.applyRemoteFont.mockClear();
    hoisted.softDeleteFont.mockClear();
    hoisted.activateFont.mockClear();

    appFiles = new Map<string, ArrayBuffer>();
    appService = {
      exists: vi.fn(async (path: string, base: string) => appFiles.has(`${base}:${path}`)),
      readFile: vi.fn(async (path: string, base: string) => appFiles.get(`${base}:${path}`)),
      writeFile: vi.fn(async (path: string, base: string, content: ArrayBuffer) => {
        appFiles.set(`${base}:${path}`, content);
      }),
      createDir: vi.fn(async () => {}),
      resolveFilePath: vi.fn(async (path: string, base: string) => `/abs/${base}/${path}`),
    };
    envConfig = { getAppService: async () => appService } as unknown as EnvConfigType;
  });

  test('uploads a local font and writes the manifest', async () => {
    hoisted.fontState.rows = [
      {
        id: 'fid',
        name: 'MyFont',
        path: 'bundle1/MyFont.ttf',
        bundleDir: 'bundle1',
        contentId: 'cid1',
        byteSize: 4,
        loaded: true,
      },
    ];
    appFiles.set('Fonts:bundle1/MyFont.ttf', new Uint8Array([1, 2, 3, 4]).buffer);
    const provider = makeProvider();

    const result = await syncAssets({ provider, backendKind: 'webdav', envConfig });

    expect(provider.remoteFiles.has(FONT_PATH)).toBe(true);
    const manifest = JSON.parse(provider.getManifest()!);
    expect(manifest.fonts[0].contentId).toBe('cid1');
    expect(result.pushed).toBeGreaterThan(0);
  });

  test('adds a remote font, downloads its bytes and activates it', async () => {
    const provider = makeProvider();
    provider.setManifest({
      version: 1,
      updatedAt: 1,
      fonts: [{ contentId: 'cid2', name: 'Remote', filename: 'Remote.ttf' }],
      textures: [],
      dictionaries: [],
    });
    provider.remoteFiles.set('/Readest/Assets/Fonts/cid2/Remote.ttf', new Uint8Array([9]).buffer);

    await syncAssets({ provider, backendKind: 'webdav', envConfig });

    expect(hoisted.applyRemoteFont).toHaveBeenCalledOnce();
    expect(hoisted.applyRemoteFont.mock.calls[0]![0]).toMatchObject({ contentId: 'cid2' });
    expect(appService.writeFile).toHaveBeenCalled();
    expect(hoisted.activateFont).toHaveBeenCalledWith(envConfig, 'cid2');
  });

  test('propagates a remote tombstone', async () => {
    hoisted.fontState.rows = [
      {
        id: 'f3',
        name: 'Gone',
        path: 'b3/Gone.ttf',
        bundleDir: 'b3',
        contentId: 'cid3',
        loaded: true,
      },
    ];
    const provider = makeProvider();
    provider.setManifest({
      version: 1,
      updatedAt: 2,
      fonts: [{ contentId: 'cid3', name: 'Gone', filename: 'Gone.ttf', deletedAt: 123 }],
      textures: [],
      dictionaries: [],
    });

    await syncAssets({ provider, backendKind: 'webdav', envConfig });

    expect(hoisted.softDeleteFont).toHaveBeenCalledWith('cid3');
  });

  test('a steady state writes the manifest only once', async () => {
    hoisted.fontState.rows = [
      {
        id: 'fid',
        name: 'MyFont',
        path: 'bundle1/MyFont.ttf',
        bundleDir: 'bundle1',
        contentId: 'cid1',
        byteSize: 4,
        loaded: true,
      },
    ];
    appFiles.set('Fonts:bundle1/MyFont.ttf', new Uint8Array([1, 2, 3, 4]).buffer);
    const provider = makeProvider();

    await syncAssets({ provider, backendKind: 'webdav', envConfig });
    const writesAfterFirst = provider.writes.length;
    await syncAssets({ provider, backendKind: 'webdav', envConfig });

    expect(provider.writes.length).toBe(writesAfterFirst);
  });
});

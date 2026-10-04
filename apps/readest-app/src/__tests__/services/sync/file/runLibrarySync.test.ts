import { describe, test, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore } from '@/store/settingsStore';
import { setCachedUserPlan } from '@/services/sync/cloudSyncProvider';
import { useLibraryStore } from '@/store/libraryStore';
import { useFileSyncStore } from '@/store/fileSyncStore';
import type { SystemSettings } from '@/types/settings';

/** A complete SyncLibraryResult shape; the pass merges every reporting field. */
const syncResult = (over: Record<string, unknown> = {}) => ({
  booksSynced: 0,
  failures: 0,
  failedBooks: [],
  indexPushFailed: false,
  ...over,
});

const syncLibrary = vi.fn().mockResolvedValue(syncResult());
const pushBookFile = vi.fn().mockResolvedValue({ uploaded: true });
const pushBookCover = vi.fn().mockResolvedValue({ uploaded: true });
const downloadBookFile = vi.fn().mockResolvedValue(true);

// The two "extras" steps are asserted through their own suites (their scope /
// toggle / remote-wins behaviour); here they are stubbed so a pass never
// reaches the real network-shaped code with a fixture provider.
const syncAppSettings = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>) => ({ applied: false, pushed: false })),
);
const syncAssets = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>) => ({ applied: 0, pushed: 0, downloaded: 0 })),
);

vi.mock('@/services/sync/file/settingsSync', () => ({ syncAppSettings }));
vi.mock('@/services/sync/file/assetSync', () => ({ syncAssets }));

vi.mock('@/services/sync/file/providerRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sync/file/providerRegistry')>();
  return {
    ...actual,
    createFileSyncProvider: vi.fn(async () => ({}) as never),
  };
});

vi.mock('@/services/sync/file/appLocalStore', () => ({
  createAppLocalStore: vi.fn(() => ({}) as never),
}));

vi.mock('@/services/sync/file/engine', () => ({
  FileSyncEngine: vi.fn(function (this: Record<string, unknown>) {
    this['syncLibrary'] = syncLibrary;
    this['pushBookFile'] = pushBookFile;
    this['pushBookCover'] = pushBookCover;
    this['downloadBookFile'] = downloadBookFile;
  }),
}));

// Defaults keep `canBackendRun('gdrive')` true (non-web), so the existing pass
// tests still run gdrive; the getReadyFileSyncBackends block toggles them.
vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  isWebAppPlatform: vi.fn(() => false),
}));
vi.mock('@/services/sync/providers/gdrive/auth/webTokenStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/sync/providers/gdrive/auth/webTokenStore')>()),
  hasValidWebDriveToken: vi.fn(() => false),
}));
// jsdom is neither an iOS nor a macOS Tauri app, so the real gate would say
// false anyway; the mock makes the platform dependency explicit and togglable.
vi.mock('@/services/sync/providers/icloud/buildICloudProvider', () => ({
  isICloudSupportedPlatform: vi.fn(() => false),
  buildICloudProvider: vi.fn(async () => null),
}));

import { isWebAppPlatform } from '@/services/environment';
import { hasValidWebDriveToken } from '@/services/sync/providers/gdrive/auth/webTokenStore';
import {
  canBackendRun,
  getReadyFileSyncBackends,
  replaceLocalLibraryWithRemote,
  runFileBookDownload,
  runFileBookUpload,
  runFileLibrarySyncPass,
} from '@/services/sync/file/runLibrarySync';
import type { Book } from '@/types/book';

const makeBook = (hash: string): Book => ({
  hash,
  format: 'EPUB',
  title: `Book ${hash}`,
  sourceTitle: `Book ${hash}`,
  author: 'A',
  createdAt: 1,
  updatedAt: 1,
});

const translationFn = (key: string, params?: Record<string, string | number>) => {
  if (params) {
    return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)), key);
  }
  return key;
};

const envConfig = {
  getAppService: vi.fn(async () => ({ saveSettings: vi.fn() }) as never),
} as never;

const multiProviderSettings = {
  version: 1,
  readestCloud: { enabled: false },
  webdav: {
    enabled: true,
    serverUrl: 'https://dav',
    username: 'u',
    password: 'p',
    rootPath: '/',
    syncBooks: true,
  },
  googleDrive: { enabled: true, syncBooks: true },
} as unknown as SystemSettings;

describe('runFileLibrarySyncPass', () => {
  test.each([
    { failures: 1 },
    { indexPushFailed: true },
  ])('does not record partial sync as successful: %j', async (failure) => {
    syncLibrary.mockResolvedValueOnce(syncResult(failure));
    await runFileLibrarySyncPass(envConfig, translationFn);
    expect(useSettingsStore.getState().settings.webdav?.lastSyncedAt).toBeUndefined();
    expect(useFileSyncStore.getState().lastErrorByKind.webdav).toBeTruthy();
  });

  beforeEach(() => {
    syncLibrary.mockReset().mockResolvedValue(syncResult({ booksSynced: 1 }));
    useSettingsStore.getState().setSettings(multiProviderSettings);
    useLibraryStore.setState({ library: [makeBook('h1')], libraryLoaded: true });
    useFileSyncStore.setState({ byKind: {}, activeKind: null, lastErrorByKind: {} });
    setCachedUserPlan('pro');
  });

  test('runs every enabled backend in a fixed order and sums the result', async () => {
    const result = await runFileLibrarySyncPass(envConfig, translationFn);
    expect(syncLibrary).toHaveBeenCalledTimes(2);
    expect(result?.booksSynced).toBe(2);
  });

  test('aggregates failures across backends instead of keeping only the last (#5900)', async () => {
    // A spread of the LAST result silently replaced the earlier backends'
    // failure counts, so a pass where the first mirror failed every book and
    // the second succeeded reported a clean run.
    syncLibrary
      .mockReset()
      .mockResolvedValueOnce(
        syncResult({
          booksSynced: 1,
          failures: 3,
          failedBooks: [{ hash: 'h1', title: 'A', reason: 'no source', phase: 'upload-file' }],
          indexPushFailed: true,
        }),
      )
      .mockResolvedValueOnce(syncResult({ booksSynced: 1 }));

    const result = await runFileLibrarySyncPass(envConfig, translationFn);

    expect(result?.booksSynced).toBe(2);
    expect(result?.failures).toBe(3);
    expect(result?.failedBooks).toHaveLength(1);
    expect(result?.indexPushFailed).toBe(true);
  });

  test('holds the mutex for the whole pass', async () => {
    let lockedDuringPass: boolean | null = null;
    syncLibrary.mockImplementation(async () => {
      // A racing auto-sync must be refused while the pass is mid-flight.
      lockedDuringPass = useFileSyncStore.getState().beginSync('s3', 'Syncing…') === false;
      return syncResult({ booksSynced: 1 });
    });
    await runFileLibrarySyncPass(envConfig, translationFn);
    expect(lockedDuringPass).toBe(true);
    // ...and the lock is free again afterwards.
    expect(useFileSyncStore.getState().activeKind).toBeNull();
  });

  // The check above only observes the lock from inside a backend's own
  // syncLibrary call, which is always mid-acquisition by construction — it
  // cannot see a release-then-reacquire between backends, because releasing
  // and reacquiring back to back has no `await` between them for anything
  // else to run in. Subscribing to the store directly records every
  // transition `set()` produces (beginSync/switchSync/endSync each call it
  // once), so a hand-off that dips through `null` becomes visible even
  // though nothing outside the store could ever race into that instant.
  test('hands the lock directly from one backend to the next, never through a released state', async () => {
    const activeKindHistory: (string | null)[] = [];
    const unsubscribe = useFileSyncStore.subscribe((state) => {
      activeKindHistory.push(state.activeKind);
    });
    await runFileLibrarySyncPass(envConfig, translationFn);
    unsubscribe();
    // The final entry is the pass's own closing endSync; every transition
    // before it must already hold some backend's lock.
    expect(activeKindHistory.slice(0, -1)).not.toContain(null);
  });

  test('a failing backend does not stop the others', async () => {
    syncLibrary
      .mockRejectedValueOnce(new Error('token expired'))
      .mockResolvedValueOnce(syncResult({ booksSynced: 3 }));

    const result = await runFileLibrarySyncPass(envConfig, translationFn);

    expect(syncLibrary).toHaveBeenCalledTimes(2);
    expect(result?.booksSynced).toBe(3);
    expect(useFileSyncStore.getState().lastErrorByKind.webdav).toBe('token expired');
    expect(useFileSyncStore.getState().lastErrorByKind.gdrive).toBeNull();
  });

  test('returns null when every backend fails', async () => {
    syncLibrary.mockRejectedValue(new Error('offline'));
    expect(await runFileLibrarySyncPass(envConfig, translationFn)).toBeNull();
    expect(useFileSyncStore.getState().activeKind).toBeNull();
  });

  test('does nothing when no backend is enabled', async () => {
    useSettingsStore.getState().setSettings({ version: 1 } as SystemSettings);
    expect(await runFileLibrarySyncPass(envConfig, translationFn)).toBeNull();
    expect(syncLibrary).not.toHaveBeenCalled();
  });

  test('skips when the library has not loaded (would push an empty index)', async () => {
    useLibraryStore.setState({ libraryLoaded: false });
    expect(await runFileLibrarySyncPass(envConfig, translationFn)).toBeNull();
    expect(syncLibrary).not.toHaveBeenCalled();
  });

  test('skips when another backend holds the library-sync mutex', async () => {
    useFileSyncStore.getState().beginSync('s3', 'busy');
    expect(await runFileLibrarySyncPass(envConfig, translationFn)).toBeNull();
    expect(syncLibrary).not.toHaveBeenCalled();
  });

  // The endpoint-replace flow purges the local library and immediately pulls
  // the NEW target. It must talk to that backend only, and pull-only: pushing
  // the half-replaced state (or waking a second backend) would repopulate the
  // very remote the user just asked to adopt.
  test('`only` restricts the pass to one backend', async () => {
    const result = await runFileLibrarySyncPass(envConfig, translationFn, { only: 'webdav' });

    expect(syncLibrary).toHaveBeenCalledTimes(1);
    expect(result?.booksSynced).toBe(1);
    expect(useSettingsStore.getState().settings.googleDrive?.lastSyncedAt).toBeUndefined();
  });

  test('`strategyOverride` forces the direction for one run', async () => {
    await runFileLibrarySyncPass(envConfig, translationFn, {
      only: 'webdav',
      strategyOverride: 'receive',
    });

    const options = syncLibrary.mock.calls[0]![1] as { strategy: string };
    expect(options.strategy).toBe('receive');
  });
});

describe('replaceLocalLibraryWithRemote', () => {
  const appService = {
    saveSettings: vi.fn(async () => {}),
    loadLibraryBooks: vi.fn(async (): Promise<Book[]> => [makeBook('h1'), makeBook('h2')]),
    deleteBook: vi.fn(async () => {}),
    saveLibraryBooks: vi.fn(async () => {}),
  };

  beforeEach(() => {
    syncLibrary.mockReset().mockResolvedValue(syncResult({ booksSynced: 7 }));
    useSettingsStore.getState().setSettings(multiProviderSettings);
    useLibraryStore.setState({ library: [makeBook('h1'), makeBook('h2')], libraryLoaded: true });
    useFileSyncStore.setState({ byKind: {}, activeKind: null, lastErrorByKind: {} });
    setCachedUserPlan('pro');
    appService.loadLibraryBooks.mockClear();
    appService.deleteBook.mockClear();
    appService.saveLibraryBooks.mockClear();
    syncAppSettings.mockClear();
    (envConfig as unknown as { getAppService: ReturnType<typeof vi.fn> }).getAppService
      .mockReset()
      .mockImplementation(async () => appService as never);
  });

  test('purges every local book, then pulls the new target receive-only', async () => {
    await replaceLocalLibraryWithRemote(envConfig, translationFn, 'webdav');

    // Local side: every book purged (files, cover, config) and the library
    // replaced with an empty one, not a tombstoned one — tombstones would be
    // pushed straight back up to the server the user just adopted.
    expect(appService.deleteBook).toHaveBeenCalledTimes(2);
    expect(appService.deleteBook).toHaveBeenCalledWith(expect.anything(), 'purge');
    expect(appService.saveLibraryBooks).toHaveBeenCalledWith([], { replace: true });
    expect(useLibraryStore.getState().library).toEqual([]);

    // Remote side: pull-only (`syncBooks` would push nothing anyway, and a
    // strategy that uploads would fight the "remote wins" choice).
    expect(syncLibrary).toHaveBeenCalledTimes(1);
    expect((syncLibrary.mock.calls[0]![1] as { strategy: string }).strategy).toBe('receive');

    // The purge must finish before anything touches the remote.
    expect(appService.saveLibraryBooks.mock.invocationCallOrder[0]).toBeLessThan(
      syncLibrary.mock.invocationCallOrder[0]!,
    );
  });

  test('talks to the repointed backend only, and lets its settings win', async () => {
    await replaceLocalLibraryWithRemote(envConfig, translationFn, 'webdav');

    // Two backends are enabled in this fixture; one syncLibrary call means the
    // pass was narrowed, and only WebDAV records a sync.
    expect(syncLibrary).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().settings.googleDrive?.lastSyncedAt).toBeUndefined();
    expect(syncAppSettings.mock.calls[0]![0]).toMatchObject({
      backendKind: 'webdav',
      preferRemote: true,
    });
  });
});

describe('runFileBookUpload', () => {
  beforeEach(() => {
    pushBookFile.mockReset().mockResolvedValue({ uploaded: true });
    pushBookCover.mockReset().mockResolvedValue({ uploaded: true });
    useSettingsStore.getState().setSettings(multiProviderSettings);
    setCachedUserPlan('pro');
  });

  test('pushes the book to every enabled backend', async () => {
    expect(await runFileBookUpload(envConfig, makeBook('h1'))).toBe(true);
    expect(pushBookFile).toHaveBeenCalledTimes(2);
  });

  test('succeeds when at least one backend takes the book', async () => {
    pushBookFile
      .mockRejectedValueOnce(new Error('drive is down'))
      .mockResolvedValueOnce({ uploaded: true });
    expect(await runFileBookUpload(envConfig, makeBook('h1'))).toBe(true);
  });

  test('fails when no backend takes the book', async () => {
    pushBookFile.mockRejectedValue(new Error('offline'));
    expect(await runFileBookUpload(envConfig, makeBook('h1'))).toBe(false);
  });

  test('treats an already-mirrored file as success', async () => {
    pushBookFile
      .mockResolvedValueOnce({ uploaded: false, reason: 'remote-matches' })
      .mockResolvedValueOnce({ uploaded: false, reason: 'no-source' });
    expect(await runFileBookUpload(envConfig, makeBook('h1'))).toBe(true);
  });
});

describe('runFileBookDownload', () => {
  beforeEach(() => {
    downloadBookFile.mockReset();
    useSettingsStore.getState().setSettings(multiProviderSettings);
    setCachedUserPlan('pro');
  });

  test('stops at the first backend that has the file', async () => {
    downloadBookFile.mockResolvedValueOnce(true);
    expect(await runFileBookDownload(envConfig, makeBook('h1'))).toBe(true);
    expect(downloadBookFile).toHaveBeenCalledTimes(1);
  });

  test('falls through to the next backend when the first does not have it', async () => {
    downloadBookFile.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await runFileBookDownload(envConfig, makeBook('h1'))).toBe(true);
    expect(downloadBookFile).toHaveBeenCalledTimes(2);
  });

  test('stamps downloadedAt and coverDownloadedAt on success', async () => {
    downloadBookFile.mockResolvedValueOnce(true);
    const book = makeBook('h1');
    expect(await runFileBookDownload(envConfig, book)).toBe(true);
    expect(book.downloadedAt).toBeTruthy();
    expect(book.coverDownloadedAt).toBeTruthy();
  });
});

describe('getReadyFileSyncBackends', () => {
  const settings = {
    version: 1,
    webdav: {
      enabled: true,
      serverUrl: 'https://dav',
      username: 'u',
      password: 'p',
      rootPath: '/',
    },
    googleDrive: { enabled: true },
  } as unknown as SystemSettings;

  beforeEach(() => {
    vi.mocked(isWebAppPlatform).mockReturnValue(true);
    vi.mocked(hasValidWebDriveToken).mockReturnValue(true);
    setCachedUserPlan('pro');
  });

  test('includes gdrive when the web token is valid', () => {
    expect(getReadyFileSyncBackends(settings)).toEqual(['webdav', 'gdrive']);
  });

  test('drops gdrive when the web token is gone (canBackendRun false)', () => {
    vi.mocked(hasValidWebDriveToken).mockReturnValue(false);
    expect(canBackendRun('gdrive')).toBe(false);
    expect(canBackendRun('webdav')).toBe(true);
    expect(getReadyFileSyncBackends(settings)).toEqual(['webdav']);
  });

  test('native (non-web) keeps gdrive regardless of the web token', () => {
    vi.mocked(isWebAppPlatform).mockReturnValue(false);
    vi.mocked(hasValidWebDriveToken).mockReturnValue(false);
    expect(getReadyFileSyncBackends(settings)).toEqual(['webdav', 'gdrive']);
  });

  test('excludes everything when the plan gate pauses third-party sync', () => {
    setCachedUserPlan('free');
    expect(getReadyFileSyncBackends(settings)).toEqual([]);
  });

  test('rules icloud out off Apple platforms (canBackendRun false)', () => {
    expect(canBackendRun('icloud')).toBe(false);
  });
});

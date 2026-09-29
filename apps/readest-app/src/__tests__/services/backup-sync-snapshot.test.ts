import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZipWriter } from '@zip.js/zip.js';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import type { AppService, FileItem } from '@/types/system';
import type { DatabaseService } from '@/types/database';
import {
  addBackupEntriesToZip,
  mergeRestoredSettings,
  restoreFromBackupZip,
} from '@/services/backupService';
import { exportStatsSnapshot, importStatsSnapshot } from '@/services/statistics/statsSnapshot';
import { StatisticsDb } from '@/services/statistics/statisticsDb';

/**
 * Whole-sync snapshot: the manifest + BaseDir-prefixed entries let a user
 * move every sync-relevant file between devices without a sync server.
 */

const LIVE_HASH = '1111111111111111111111111111aaaa';

const mocks = vi.hoisted(() => {
  type FakeEntry = { filename: string; directory: boolean; getData: () => Promise<Uint8Array> };
  return { entries: [] as FakeEntry[] };
});

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
  isWebAppPlatform: () => true,
}));
vi.mock('@/utils/zip', () => ({ configureZip: vi.fn() }));
vi.mock('@zip.js/zip.js', () => ({
  BlobReader: class {},
  // Mirror the real reader: the backup writer hands it the raw bytes, which
  // the capturing writer below decodes to inspect JSON entries.
  Uint8ArrayReader: class {
    array: Uint8Array;
    constructor(array: ArrayBuffer | Uint8Array) {
      this.array = array instanceof Uint8Array ? array : new Uint8Array(array);
    }
  },
  Uint8ArrayWriter: class {},
  ZipReader: class {
    async getEntries() {
      return mocks.entries;
    }
    async close() {}
  },
}));

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: LIVE_HASH,
    format: 'EPUB',
    title: 'Book',
    author: 'Author',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeCapturingWriter() {
  const names: string[] = [];
  const contents = new Map<string, string>();
  const writer = {
    add: async (name: string, reader: unknown) => {
      names.push(name);
      if (reader && typeof reader === 'object' && 'array' in reader) {
        contents.set(name, new TextDecoder().decode((reader as { array: Uint8Array }).array));
      }
    },
  } as unknown as ZipWriter<unknown>;
  return { writer, names, contents };
}

describe('mergeRestoredSettings - asset array union', () => {
  const base = { customDictionaries: [], customFonts: [], customTextures: [] };

  it('unions by contentId, keeping the newer entry and local-only records', () => {
    const current = {
      ...base,
      customDictionaries: [
        {
          id: 'a',
          kind: 'mdict',
          name: 'old-A',
          contentId: 'a',
          bundleDir: 'A',
          files: {},
          addedAt: 1,
        },
        {
          id: 'b',
          kind: 'mdict',
          name: 'B',
          contentId: 'b',
          bundleDir: 'B',
          files: {},
          addedAt: 5,
        },
      ],
    } as unknown as SystemSettings;
    const backup = {
      ...base,
      customDictionaries: [
        {
          id: 'a',
          kind: 'mdict',
          name: 'new-A',
          contentId: 'a',
          bundleDir: 'A',
          files: {},
          addedAt: 3,
        },
        {
          id: 'c',
          kind: 'mdict',
          name: 'C',
          contentId: 'c',
          bundleDir: 'C',
          files: {},
          addedAt: 2,
        },
      ],
    } as unknown as Partial<SystemSettings>;

    const merged = mergeRestoredSettings(current, backup);
    expect(merged.customDictionaries.map((d) => d.name)).toEqual(['new-A', 'B', 'C']);
  });

  it('lets a backup tombstone win over a live local record', () => {
    const current = {
      ...base,
      customDictionaries: [
        {
          id: 'a',
          kind: 'mdict',
          name: 'A',
          contentId: 'a',
          bundleDir: 'A',
          files: {},
          addedAt: 5,
        },
      ],
    } as unknown as SystemSettings;
    const backup = {
      ...base,
      customDictionaries: [
        {
          id: 'a',
          kind: 'mdict',
          name: 'A',
          contentId: 'a',
          bundleDir: 'A',
          files: {},
          addedAt: 1,
          deletedAt: 99,
        },
      ],
    } as unknown as Partial<SystemSettings>;

    const merged = mergeRestoredSettings(current, backup);
    expect(merged.customDictionaries[0]!.deletedAt).toBe(99);
  });
});

describe('collectBackupEntries (snapshot) via addBackupEntriesToZip', () => {
  const filesByBase: Record<string, FileItem[]> = {
    Books: [
      { path: `${LIVE_HASH}/book.epub`, size: 1000 },
      { path: `${LIVE_HASH}/config.json`, size: 50 },
    ],
    Dictionaries: [{ path: 'bundle1/word.mdx', size: 500 }],
    Fonts: [{ path: 'bundle2/font.ttf', size: 700 }],
    Images: [],
  };

  const makeSvc = (books: Book[]) =>
    ({
      loadLibraryBooks: async () => books,
      loadSettings: async () => ({}) as never,
      resolveFilePath: async (_p: string, base: string) => `/data/${base}`,
      readDirectory: async (dir: string) => filesByBase[dir.replace('/data/', '')] ?? [],
      readFile: async () => new ArrayBuffer(8),
      databaseExists: async () => false,
    }) as unknown as AppService;

  it('writes a manifest and BaseDir-prefixed asset + book entries', async () => {
    const { writer, names, contents } = makeCapturingWriter();

    await addBackupEntriesToZip(writer, makeSvc([makeBook()]), { snapshot: true });

    expect(names).toContain('manifest.json');
    expect(names).toContain(`Books/${LIVE_HASH}/book.epub`);
    expect(names).toContain(`Books/${LIVE_HASH}/config.json`);
    expect(names).toContain('Dictionaries/bundle1/word.mdx');
    expect(names).toContain('Fonts/bundle2/font.ttf');
    const manifest = JSON.parse(contents.get('manifest.json')!);
    expect(manifest).toMatchObject({ format: 'readest-sync', version: 1, includeAssets: true });
  });

  it('omits assets and prefixes for a plain (non-snapshot) backup', async () => {
    const { writer, names } = makeCapturingWriter();

    await addBackupEntriesToZip(writer, makeSvc([makeBook()]), {});

    expect(names).not.toContain('manifest.json');
    expect(names).toContain(`${LIVE_HASH}/book.epub`);
    expect(names).not.toContain('Dictionaries/bundle1/word.mdx');
  });

  it('drops book content when includeBookFiles is false but keeps sidecars', async () => {
    const { writer, names } = makeCapturingWriter();

    await addBackupEntriesToZip(writer, makeSvc([makeBook()]), {
      snapshot: true,
      includeBookFiles: false,
    });

    expect(names).not.toContain(`Books/${LIVE_HASH}/book.epub`);
    expect(names).toContain(`Books/${LIVE_HASH}/config.json`);
  });
});

describe('snapshot restore', () => {
  const entry = (filename: string, content?: string) => ({
    filename,
    directory: false,
    getData: async () => new TextEncoder().encode(content ?? 'bytes'),
  });

  const writeFile = vi.fn();

  const appService = {
    loadLibraryBooks: async () => [makeBook()],
    loadSettings: async () => ({}) as never,
    saveSettings: vi.fn(),
    saveLibraryBooks: vi.fn(),
    resolveFilePath: async (path: string, base: string) =>
      path ? `/data/${base}/${path}` : `/data/${base}`,
    readFile: async () => '{}',
    writeFile,
    exists: async () => false,
    createDir: vi.fn(),
    importBook: vi.fn(),
  } as unknown as AppService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entries = [
      entry('manifest.json', JSON.stringify({ format: 'readest-sync', version: 1 })),
      entry('library.json', JSON.stringify([makeBook()])),
      entry('settings.json', JSON.stringify({})),
      entry(`Books/${LIVE_HASH}/book.epub`),
      entry(`Books/${LIVE_HASH}/config.json`, JSON.stringify({ progress: [7, 10], updatedAt: 9 })),
      entry('Dictionaries/bundle1/word.mdx'),
    ];
  });

  it('routes snapshot entries to their BaseDir and merges config', async () => {
    await restoreFromBackupZip(appService, new Blob());

    const calls = writeFile.mock.calls.map(([p, base]) => `${base}:${p}`);
    expect(calls).toContain(`Books:${LIVE_HASH}/book.epub`);
    expect(calls).toContain('Dictionaries:bundle1/word.mdx');
    // Existing book: config.json is merged in JS and written back under Books.
    expect(calls).toContain(`Books:${LIVE_HASH}/config.json`);
    expect(appService.saveLibraryBooks).toHaveBeenCalled();
  });
});

describe('stats snapshot', () => {
  it('exports page events from the statistics DB', async () => {
    const row = {
      bookMd5: LIVE_HASH,
      title: 'Book',
      authors: 'Author',
      page: 3,
      startTime: 100,
      duration: 12,
      totalPages: 50,
    };
    const db = {
      execute: vi.fn(async () => ({ rowsAffected: 1, lastInsertId: 0 })),
      select: vi.fn(async () => [row]),
      batch: vi.fn(),
      close: vi.fn(),
    } as unknown as DatabaseService;
    const appService = {
      databaseExists: async () => true,
      openDatabase: async () => db,
    } as unknown as AppService;

    const snapshot = await exportStatsSnapshot(appService);
    expect(snapshot?.events).toHaveLength(1);
    expect(snapshot?.events[0]).toMatchObject({ bookMd5: LIVE_HASH, page: 3, duration: 12 });
    expect(snapshot?.books[0]).toMatchObject({ bookMd5: LIVE_HASH, title: 'Book' });
    // `StatisticsDb` memoizes its connection per module; close it so the next
    // test's fake DB is the one that gets used.
    await (await StatisticsDb.open(appService)).close();
  });

  it('imports events through a merge transaction', async () => {
    const executed: string[] = [];
    const db = {
      execute: vi.fn(async (sql: string) => {
        executed.push(sql);
        return { rowsAffected: 1, lastInsertId: 1 };
      }),
      select: vi.fn(async (sql: string) => (sql.includes('FROM book') ? [{ id: 1 }] : [])),
      batch: vi.fn(),
      close: vi.fn(),
    } as unknown as DatabaseService;
    const appService = {
      databaseExists: async () => true,
      openDatabase: async () => db,
    } as unknown as AppService;

    await importStatsSnapshot(appService, {
      books: [{ bookMd5: LIVE_HASH, title: 'Book', authors: 'Author' }],
      events: [{ bookMd5: LIVE_HASH, page: 3, startTime: 100, duration: 12, totalPages: 50 }],
    });

    expect(executed).toContain('BEGIN');
    expect(executed).toContain('COMMIT');
    expect(executed.some((sql) => sql.includes('INSERT INTO page_stat_data'))).toBe(true);
  });
});

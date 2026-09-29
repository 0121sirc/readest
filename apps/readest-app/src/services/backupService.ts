import { mergeBookshelfStates } from '@/services/bookshelves/state';
import type { Configuration, FileEntry, ZipWriter } from '@zip.js/zip.js';
import { AppService, BaseDir, FileItem } from '@/types/system';
import { EXTS } from '@/libs/document';
import { isTauriAppPlatform } from '@/services/environment';
import { Book, BookConfig, BookNote } from '@/types/book';
import { SystemSettings } from '@/types/settings';
import { getBookDirOfPath, getLibraryFilename, isBookFile } from '@/utils/book';
import { getAbsOfflineDir } from '@/utils/audiobook';
import { stampBookConfigSchema } from '@/utils/serializer';
import { configureZip } from '@/utils/zip';
import {
  STATS_SNAPSHOT_FILENAME,
  exportStatsSnapshot,
  importStatsSnapshot,
  isEmptyStatsSnapshot,
  type StatsSnapshot,
} from '@/services/statistics/statsSnapshot';

/** Book file extensions for identifying book files in backup directories. */
const BOOK_EXTS = new Set(Object.values(EXTS));

const isAbsOfflineEntry = (entryName: string): boolean => {
  const dir = getBookDirOfPath(entryName);
  return !!dir && entryName.startsWith(`${getAbsOfflineDir(dir)}/`);
};

/** Root-level zip entry name for the backed-up global settings snapshot. */
export const SETTINGS_BACKUP_FILENAME = 'settings.json';

/** Root-level zip entry name for the sync-snapshot manifest. */
export const SNAPSHOT_MANIFEST_FILENAME = 'manifest.json';
export const SNAPSHOT_FORMAT = 'readest-sync';
export const SNAPSHOT_VERSION = 1;

/**
 * Asset directories folded into a sync snapshot. Entries are stored at the
 * root of the zip prefixed with the BaseDir name (`Dictionaries/…`,
 * `Fonts/…`, `Images/…`) so a native extract with `destDir` = the app data
 * root (`BaseDir 'Data'`) lands them exactly where the app reads them.
 */
export const SNAPSHOT_ASSET_BASES = ['Dictionaries', 'Fonts', 'Images'] as const;
export type SnapshotAssetBase = (typeof SNAPSHOT_ASSET_BASES)[number];

/** Base dirs whose per-file paths can be prefixed in a snapshot zip. */
const SNAPSHOT_FILE_BASES: readonly BaseDir[] = ['Books', ...SNAPSHOT_ASSET_BASES];

/** Reverse of {@link SNAPSHOT_FILE_BASES}: zip prefix → BaseDir. */
const snapshotBaseOfEntry = (entryName: string): BaseDir | null => {
  for (const base of SNAPSHOT_FILE_BASES) {
    if (entryName.startsWith(`${base}/`)) return base;
  }
  return null;
};

/**
 * Book fields that describe THIS device's copy and must never be exported in
 * a portable snapshot. A peer that adopts a foreign `filePath` reads the row
 * as a purely-local book and can then delete the "missing" book cloud-and-
 * device (see #5084 / `wire.ts:stripDeviceLocalFields`). Download stamps are
 * kept: the snapshot carries the files themselves when `includeBookFiles` is
 * on, and a device without the bytes re-derives availability from disk.
 */
const SNAPSHOT_STRIP_BOOK_FIELDS = ['filePath', 'altFilePaths', 'coverImageUrl'] as const;

/**
 * Manifest written at the root of a whole-sync snapshot. Its presence (and
 * `format`) is what tells the importer this is a snapshot rather than a
 * legacy library backup, and it records which optional sections the exporter
 * actually produced.
 */
export interface SnapshotManifest {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  exportedAt: number;
  includeBookFiles: boolean;
  includeAssets: boolean;
  includeStats: boolean;
  counts: { books: number; files: number; assets: number; statEvents: number };
}

/**
 * Options controlling what a backup zip includes.
 */
export interface BackupOptions {
  /**
   * Include account credentials (sync tokens, passwords, API keys) in the
   * settings snapshot. The backup zip is unencrypted, so this is opt-in and
   * defaults to false.
   */
  includeCredentials?: boolean;
  /**
   * Produce a whole-sync snapshot: write `manifest.json`, fold in the custom
   * asset bundles and reading statistics, and prefix file entries with their
   * BaseDir so the archive is reconstructable without a sync server.
   */
  snapshot?: boolean;
  /**
   * Include the book content files themselves. Book sidecars (`config.json`,
   * `nav.json`, `cover.png`, TTS packs) are always included. Defaults to true.
   */
  includeBookFiles?: boolean;
  /** Include custom dictionary / font / texture bundles. Snapshot only; defaults to true. */
  includeAssets?: boolean;
  /** Include reading statistics. Snapshot only; defaults to true. */
  includeStats?: boolean;
}

interface ResolvedBackupOptions {
  includeCredentials: boolean;
  snapshot: boolean;
  includeBookFiles: boolean;
  includeAssets: boolean;
  includeStats: boolean;
}

const resolveBackupOptions = (options: BackupOptions): ResolvedBackupOptions => ({
  includeCredentials: options.includeCredentials ?? false,
  snapshot: options.snapshot ?? false,
  includeBookFiles: options.includeBookFiles ?? true,
  includeAssets: options.snapshot ? (options.includeAssets ?? true) : false,
  includeStats: options.snapshot ? (options.includeStats ?? true) : false,
});

/**
 * SystemSettings dot-paths excluded from backups. Each is either tied to
 * this device (and meaningless to restore elsewhere) or sync/migration
 * bookkeeping that would corrupt state if restored stale. Restore keeps
 * the current device's value for every path here — see issue #4098.
 */
export const BACKUP_SETTINGS_BLACKLIST = [
  // Device filesystem paths — invalid on another device / OS.
  'localBooksDir',
  'customRootDir',
  'externalLibraryFolders',
  'autoImportFolders',
  'autoImportFlattenFolders',
  'savedBookCoverForLockScreenPath',
  // Per-device identity — restoring causes sync identity / HLC collisions.
  'replicaDeviceId',
  'kosync.deviceId',
  'bookorbit.deviceId',
  // Sync cursors — stale values make sync skip pulls or re-push everything.
  'lastSyncedAtBooks',
  'lastSyncedAtConfigs',
  'lastSyncedAtNotes',
  'lastSyncedAtReplicas',
  'readwise.lastSyncedAt',
  'hardcover.lastSyncedAt',
  'notion.lastSyncedAt',
  'googleDrive.deviceId',
  'googleDrive.lastSyncedAt',
  'webdav.deviceId',
  'webdav.lastSyncedAt',
  'webdav.providerSelectedAt',
  'googleDrive.providerSelectedAt',
  'onedrive.deviceId',
  'onedrive.lastSyncedAt',
  'onedrive.providerSelectedAt',
  's3.deviceId',
  's3.lastSyncedAt',
  's3.providerSelectedAt',
  'icloud.deviceId',
  'icloud.lastSyncedAt',
  'icloud.providerSelectedAt',
  'readestCloud.disabledAt',
  // Transient runtime state — book keys may not exist post-restore; screen
  // brightness is live device state.
  'lastOpenBooks',
  'screenBrightness',
  // Schema versioning — restore keeps the current device's value so its
  // migrations are not skipped.
  'version',
  'migrationVersion',
] as const;

/**
 * Credential dot-paths stripped from backups unless `includeCredentials`
 * is set. OPDS catalog and Audiobookshelf server credentials live inside
 * the `opdsCatalogs` / `absServers` arrays and are handled separately in
 * `sanitizeSettingsForBackup`.
 */
export const BACKUP_SETTINGS_CREDENTIAL_FIELDS = [
  'kosync.username',
  'kosync.userkey',
  'kosync.password',
  'bookorbit.username',
  'bookorbit.userkey',
  'bookorbit.password',
  'readwise.accessToken',
  'hardcover.accessToken',
  'notion.accessToken',
  // S3 access keys are strong, long-lived cloud credentials — strip them from
  // unencrypted backup zips unless the user opts into including credentials.
  's3.accessKeyId',
  's3.secretAccessKey',
  'aiSettings.aiGatewayApiKey',
  'aiSettings.openrouterApiKey',
] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Delete a dot-path key from a deep object; no-op when the path is absent. */
const deletePath = (obj: Record<string, unknown>, path: string): void => {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]!];
    if (!isPlainObject(next)) return;
    cur = next;
  }
  delete cur[parts[parts.length - 1]!];
};

/**
 * Produce a copy of SystemSettings safe to write into a backup zip:
 * strips device-specific / sync-bookkeeping fields always, and account
 * credentials unless `includeCredentials` is set. Input is not mutated.
 */
export function sanitizeSettingsForBackup(
  settings: SystemSettings,
  options: BackupOptions = {},
): SystemSettings {
  const clone = structuredClone(settings) as SystemSettings & Record<string, unknown>;
  if (clone.bookshelves) {
    clone.bookshelves = structuredClone(mergeBookshelfStates(clone.bookshelves));
    // A portable snapshot must not depend on this device's anonymous journal.
    for (const row of Object.values(clone.bookshelves.rows)) delete row.localOnly;
  }
  for (const path of BACKUP_SETTINGS_BLACKLIST) {
    deletePath(clone, path);
  }
  if (!options.includeCredentials) {
    for (const path of BACKUP_SETTINGS_CREDENTIAL_FIELDS) {
      deletePath(clone, path);
    }
    if (clone.notion) clone.notion.enabled = false;
    if (Array.isArray(clone.opdsCatalogs)) {
      clone.opdsCatalogs = clone.opdsCatalogs.map((catalog) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { username: _username, password: _password, ...rest } = catalog;
        return rest;
      });
    }
    if (Array.isArray(clone.absServers)) {
      clone.absServers = clone.absServers.map((server) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const {
          username: _username,
          password: _password,
          accessToken: _accessToken,
          refreshToken: _refreshToken,
          ...rest
        } = server;
        return rest;
      });
    }
  }
  return clone;
}

/** Recursively merge `source` onto `target`; objects merge, scalars/arrays replace. */
const deepMerge = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
};

/**
 * Union-merge two arrays of user-authored records by a stable identity key,
 * keeping the newer side on conflict. Used for the settings arrays that back
 * the imported assets / integrations so a snapshot import never drops a
 * record the device already has (`deepMerge` would replace whole arrays).
 *
 * Tombstones win even when they are not "newer": a snapshot deletion must
 * propagate the same way it does through replica sync.
 */
function mergeByIdentity<T>(
  current: readonly T[] | undefined,
  backup: readonly T[] | undefined,
  keyOf: (item: T) => string | undefined,
  stampOf: (item: T) => number,
): T[] {
  const cur = current ?? [];
  const bak = backup ?? [];
  if (bak.length === 0) return [...cur];
  const out: T[] = [...cur];
  const index = new Map<string, number>();
  cur.forEach((item, i) => {
    const key = keyOf(item);
    if (key) index.set(key, i);
  });
  const deletedAtOf = (item: T): number | null => {
    const value = (item as { deletedAt?: number | null }).deletedAt;
    return value == null ? null : value;
  };
  for (const item of bak) {
    const key = keyOf(item);
    if (!key) {
      out.push(item);
      continue;
    }
    const existingIndex = index.get(key);
    if (existingIndex === undefined) {
      index.set(key, out.length);
      out.push(item);
      continue;
    }
    const existing = out[existingIndex]!;
    const backupDeleted = deletedAtOf(item) !== null;
    const existingDeleted = deletedAtOf(existing) !== null;
    if (backupDeleted !== existingDeleted) {
      if (backupDeleted) out[existingIndex] = item;
      continue;
    }
    if (stampOf(item) > stampOf(existing)) out[existingIndex] = item;
  }
  return out;
}

/**
 * Merge a restored settings snapshot onto the current device settings.
 * Blacklisted fields are absent from the snapshot, so the current
 * device's values for them are preserved. User-authored arrays are
 * union-merged by identity (see {@link mergeByIdentity}) rather than
 * replaced; neither input is mutated.
 */
export function mergeRestoredSettings(
  current: SystemSettings,
  backup: Partial<SystemSettings>,
): SystemSettings {
  const merged = deepMerge(
    current as unknown as Record<string, unknown>,
    backup as unknown as Record<string, unknown>,
  ) as unknown as SystemSettings;
  if (current.bookshelves || backup.bookshelves)
    merged.bookshelves = mergeBookshelfStates(current.bookshelves, backup.bookshelves);
  merged.customDictionaries = mergeByIdentity(
    current.customDictionaries,
    backup.customDictionaries,
    (d) => d.contentId ?? d.id,
    (d) => d.addedAt ?? 0,
  );
  merged.customFonts = mergeByIdentity(
    current.customFonts,
    backup.customFonts,
    (f) => f.contentId ?? f.id,
    (f) => f.downloadedAt ?? 0,
  );
  merged.customTextures = mergeByIdentity(
    current.customTextures,
    backup.customTextures,
    (t) => t.contentId ?? t.id,
    (t) => t.downloadedAt ?? 0,
  );
  merged.opdsCatalogs = mergeByIdentity(
    current.opdsCatalogs,
    backup.opdsCatalogs,
    (c) => c.contentId ?? c.id,
    (c) => c.addedAt ?? 0,
  );
  merged.absServers = mergeByIdentity(
    current.absServers,
    backup.absServers,
    (s) => s.contentId ?? s.id,
    (s) => s.addedAt ?? 0,
  );
  return merged;
}

/**
 * Merge two BookConfigs: uses the config with higher reading progress as base,
 * then merges booknotes from both (deduplicating by id, latest updatedAt wins).
 */
export function mergeBookConfigs(
  current: Partial<BookConfig>,
  backup: Partial<BookConfig>,
): Partial<BookConfig> {
  const currentPage = current.progress?.[0] ?? 0;
  const backupPage = backup.progress?.[0] ?? 0;

  // Use the config with higher progress as base
  const base = backupPage > currentPage ? { ...backup } : { ...current };

  // Merge booknotes from both configs
  const noteMap = new Map<string, BookNote>();
  for (const note of current.booknotes ?? []) {
    noteMap.set(note.id, note);
  }
  for (const note of backup.booknotes ?? []) {
    const existing = noteMap.get(note.id);
    if (!existing || (note.updatedAt || 0) > (existing.updatedAt || 0)) {
      noteMap.set(note.id, note);
    }
  }
  base.booknotes = [...noteMap.values()];

  return stampBookConfigSchema(base);
}

/**
 * Merge two Book metadata records: uses the one with higher updatedAt as base,
 * then reconciles timestamps. Only marks as deleted if BOTH sides agree.
 */
export function mergeBookMetadata(current: Book, backup: Book): Book {
  const base = backup.updatedAt > current.updatedAt ? { ...backup } : { ...current };
  base.updatedAt = Math.max(current.updatedAt, backup.updatedAt);
  base.createdAt = Math.min(current.createdAt, backup.createdAt);
  // Only deleted if BOTH sides agree
  base.deletedAt =
    current.deletedAt && backup.deletedAt ? Math.max(current.deletedAt, backup.deletedAt) : null;
  return base;
}

/** A book restored from a backup whose local copy had been soft-deleted. */
export interface RevivedBook {
  /** The live library record, mutated in place by `reviveRestoredBooks`. */
  book: Book;
  /** The book's metadata as stored in the backup. */
  backup: Book;
}

/**
 * Fix up books revived from a backup — present (not deleted) in the backup
 * but soft-deleted in the current library — see issue #4098.
 *
 * Their files were just re-extracted, so `downloadedAt` / `coverDownloadedAt`
 * are taken from the backup record (the local deletion had cleared them).
 *
 * `updatedAt` is bumped so the restore out-ranks the cloud's deletion
 * tombstone in the next sync's last-writer-wins merge. A single uniform
 * offset is applied to every revived book, so their relative `updatedAt`
 * order — and thus the library's "Updated" sort — is preserved exactly.
 * `syncedAt` is cleared so the next push re-uploads them and corrects the
 * cloud rows. Mutates the `book` of each entry in place.
 */
export function reviveRestoredBooks(revived: RevivedBook[], now: number = Date.now()): void {
  if (revived.length === 0) return;
  let maxUpdatedAt = 0;
  for (const { book } of revived) {
    if (book.updatedAt > maxUpdatedAt) maxUpdatedAt = book.updatedAt;
  }
  // offset >= 1 guarantees every book out-ranks its (un-bumped) cloud copy
  // while a single shared offset keeps their relative order intact.
  const offset = Math.max(1, now - maxUpdatedAt);
  for (const { book, backup } of revived) {
    book.updatedAt += offset;
    book.syncedAt = null;
    book.downloadedAt = backup.downloadedAt ?? book.downloadedAt ?? now;
    book.coverDownloadedAt = backup.coverDownloadedAt ?? book.coverDownloadedAt ?? now;
  }
}

type ProgressCallback = (current: number, total: number, filename: string) => void;

interface PlannedFile {
  /** `file.path` is relative to `base`; `entryName` uses forward slashes. */
  file: FileItem;
  entryName: string;
  base: BaseDir;
}

interface BackupPlan {
  /** Small JSON entries: library.json, settings.json, optional manifest/statistics. */
  texts: { name: string; content: string }[];
  files: PlannedFile[];
}

/** Strip a book's device-local fields for a portable snapshot export. */
const stripSnapshotBookFields = (book: Book): Book => {
  const copy = { ...book };
  for (const field of SNAPSHOT_STRIP_BOOK_FIELDS) delete copy[field];
  return copy;
};

/**
 * Recursively list a base dir's files. `file.path` keeps the host separator
 * (a Windows `readDirectory` hands back `hash\cover.png`); callers derive
 * forward-slash zip entry names from it while `readFile`/progress use the
 * raw path, exactly as the pre-snapshot code did.
 */
async function listBaseFiles(appService: AppService, base: BaseDir): Promise<FileItem[]> {
  try {
    const dir = await appService.resolveFilePath('', base);
    return await appService.readDirectory(dir, 'None');
  } catch (error) {
    console.warn(`Skipping ${base} backup:`, error);
    return [];
  }
}

/** `file.path` normalized to forward slashes for a zip entry name. */
const entryPathOf = (file: FileItem): string => file.path.replace(/\\/g, '/');

/**
 * Plan the archive: which entries a backup holds and what they are named.
 * Shared by the in-memory zip.js writer (web) and the native writer (Tauri).
 *
 * Legacy backups store book files as `<hash>/…`; sync snapshots prefix every
 * file with its BaseDir (`Books/<hash>/…`, `Dictionaries/<bundle>/…`, …) so a
 * native extract rooted at the app data dir lands each file in place.
 */
async function collectBackupEntries(
  appService: AppService,
  options: BackupOptions,
): Promise<BackupPlan> {
  const opts = resolveBackupOptions(options);
  // Generate canonical library.json from the current storage backend. A
  // snapshot strips device-local fields so the archive is portable.
  const books = await appService.loadLibraryBooks();
  const libraryBooks = opts.snapshot
    ? books.map(stripSnapshotBookFields)
    : books.map(({ coverImageUrl: _coverImageUrl, ...rest }) => rest);
  const texts = [{ name: getLibraryFilename(), content: JSON.stringify(libraryBooks, null, 2) }];

  // Add the global settings snapshot, sanitized of device-specific and
  // (unless opted in) credential fields.
  try {
    const settings = await appService.loadSettings();
    const sanitized = sanitizeSettingsForBackup(settings, options);
    texts.push({ name: SETTINGS_BACKUP_FILENAME, content: JSON.stringify(sanitized, null, 2) });
  } catch (error) {
    console.warn('Skipping settings backup:', error);
  }

  // Add the files of every live library book. Only a book's own `<hash>/`
  // dir is exported: the Books/ tree also holds root-level library metadata
  // and dirs no live row references — a soft-deleted book whose file
  // lingered, or an import killed before the library was saved. Those never
  // show in the library UI and must not be silently exported either (#5837).
  // With no rows at all (a library.json that failed to load hands back `[]`)
  // every dir is exported instead, so a broken library can still be rebuilt
  // by restore's orphan-dir import.
  const liveHashes = new Set(books.filter((b) => !b.deletedAt).map((b) => b.hash));
  const isExported = (path: string) => {
    const dir = getBookDirOfPath(path);
    return !!dir && (books.length === 0 || liveHashes.has(dir));
  };
  const bookFiles: PlannedFile[] = (await listBaseFiles(appService, 'Books'))
    .filter((file) => file.size > 0 && isExported(file.path))
    // Offline Audiobookshelf audio (#6256) is re-downloadable and can run to
    // gigabytes, each file read into memory here.
    .filter((file) => !isAbsOfflineEntry(entryPathOf(file)))
    // A restore killed mid-file leaves its `.part` temp file behind.
    .filter((file) => !file.path.endsWith('.part'))
    // The book content can be excluded; sidecars (config/nav/cover/tts) stay.
    .filter((file) => opts.includeBookFiles || !isBookFile(file.path))
    .map((file) => ({
      file,
      base: 'Books',
      entryName: opts.snapshot ? `Books/${entryPathOf(file)}` : entryPathOf(file),
    }));

  // Custom asset bundles (dictionaries / fonts / textures). Their metadata
  // rides settings.json; the binaries are what a fresh device cannot rebuild.
  const assetFiles: PlannedFile[] = [];
  if (opts.includeAssets) {
    for (const base of SNAPSHOT_ASSET_BASES) {
      const files = (await listBaseFiles(appService, base)).filter(
        (file) => file.size > 0 && !file.path.endsWith('.part'),
      );
      for (const file of files) {
        assetFiles.push({ file, base, entryName: `${base}/${entryPathOf(file)}` });
      }
    }
  }

  let statsSnapshot: StatsSnapshot | null = null;
  if (opts.includeStats) {
    statsSnapshot = await exportStatsSnapshot(appService);
  }
  if (!isEmptyStatsSnapshot(statsSnapshot)) {
    texts.push({ name: STATS_SNAPSHOT_FILENAME, content: JSON.stringify(statsSnapshot) });
  }

  if (opts.snapshot) {
    const manifest: SnapshotManifest = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      exportedAt: Date.now(),
      includeBookFiles: opts.includeBookFiles,
      includeAssets: opts.includeAssets,
      includeStats: opts.includeStats,
      counts: {
        books: liveHashes.size,
        files: bookFiles.length,
        assets: assetFiles.length,
        statEvents: statsSnapshot?.events.length ?? 0,
      },
    };
    texts.unshift({
      name: SNAPSHOT_MANIFEST_FILENAME,
      content: JSON.stringify(manifest, null, 2),
    });
  }

  return { texts, files: [...bookFiles, ...assetFiles] };
}

/**
 * Shared logic: add all library entries to a ZipWriter.
 */
export async function addBackupEntriesToZip(
  writer: ZipWriter<unknown>,
  appService: AppService,
  options: BackupOptions,
  onProgress?: ProgressCallback,
): Promise<void> {
  const { Uint8ArrayReader } = await import('@zip.js/zip.js');
  const { texts, files } = await collectBackupEntries(appService, options);

  for (const { name, content } of texts) {
    await writer.add(name, new Uint8ArrayReader(new TextEncoder().encode(content)));
  }

  const total = files.length;
  for (let i = 0; i < files.length; i++) {
    const { file, entryName, base } = files[i]!;
    onProgress?.(i + 1, total, file.path);
    try {
      const content = await appService.readFile(file.path, base, 'binary');
      const data = new Uint8Array(content as ArrayBuffer);
      await writer.add(entryName, new Uint8ArrayReader(data), { level: 0 });
    } catch (error) {
      console.warn(`Skipping file ${file.path}:`, error);
    }
  }
}

type ZipProgress = { current: number; total: number; name: string };

/**
 * Run one of the Rust zip commands, forwarding its progress channel.
 * The bulk bytes never cross the IPC bridge: on Android a request body is
 * serialized as a JSON number array, 3.9 MB/s measured on a Xiaomi 13, which
 * made a 687 MB library take three minutes to back up (#6291).
 */
async function invokeZipCommand(
  cmd: 'write_backup_zip' | 'extract_backup_zip',
  args: Record<string, unknown>,
  onProgress?: ProgressCallback,
): Promise<void> {
  const { Channel, invoke } = await import('@tauri-apps/api/core');
  const channel = new Channel<ZipProgress>();
  channel.onmessage = ({ current, total, name }) => onProgress?.(current, total, name);
  await invoke(cmd, { ...args, onProgress: channel });
}

const ZIP_WRITE_CONFIG: Partial<Configuration> = {
  useWebWorkers: true,
  useCompressionStream: true,
  chunkSize: 1 * 1024 * 1024, // 1MB chunks for streaming
};

/**
 * Create a backup zip in memory, returning an ArrayBuffer.
 * Used on web where streaming to a file is not available.
 */
export async function createBackupZip(
  appService: AppService,
  options: BackupOptions = {},
  onProgress?: ProgressCallback,
): Promise<ArrayBuffer> {
  await configureZip(ZIP_WRITE_CONFIG);
  const { BlobWriter, ZipWriter } = await import('@zip.js/zip.js');

  const blobWriter = new BlobWriter('application/zip');
  const writer = new ZipWriter(blobWriter);
  await addBackupEntriesToZip(writer, appService, options, onProgress);
  await writer.close();
  const blob = await blobWriter.getData();
  return await blob.arrayBuffer();
}

/**
 * Stream a backup zip directly to a file path on disk.
 * Uses TransformStream so only chunks are held in memory at a time.
 * Only available on Tauri (requires @tauri-apps/plugin-fs).
 */
export async function createBackupZipToFile(
  appService: AppService,
  filePath: string,
  options: BackupOptions = {},
  onProgress?: ProgressCallback,
): Promise<void> {
  const opts = resolveBackupOptions(options);
  const { texts, files } = await collectBackupEntries(appService, options);
  // Snapshot entry names are prefixed with their BaseDir, so the whole archive
  // is read relative to the app data root (`Data` = the parent of Books/Fonts/
  // Images/Dictionaries). Legacy backups keep the flat `<hash>/…` names under
  // the Books dir. A file entry's name is also its path under srcDir (forward
  // slashes; the writer joins them, so host separators never reach it).
  const srcDir = await appService.resolveFilePath('', opts.snapshot ? 'Data' : 'Books');
  const entries = [...texts, ...files.map(({ entryName }) => ({ name: entryName }))];
  try {
    // The writer reports every entry; the dialog's contract counts file
    // entries only and echoes their on-disk path (same as the zip.js writer).
    await invokeZipCommand('write_backup_zip', { dest: filePath, srcDir, entries }, (current) => {
      const index = current - texts.length - 1;
      const file = files[index];
      if (file) onProgress?.(index + 1, files.length, file.file.path);
    });
    return;
  } catch (error) {
    // A non-seekable Android document provider fails on the first seek; a
    // mid-run I/O error leaves a partial archive. Either way stream it the
    // old way, after truncating whatever the native writer left behind.
    console.error('Native backup writer failed, streaming through the IPC bridge instead:', error);
  }

  await configureZip(ZIP_WRITE_CONFIG);
  const { ZipWriter } = await import('@zip.js/zip.js');
  const { writeFile } = await import('@tauri-apps/plugin-fs');

  await writeFile(filePath, new Uint8Array());
  const { readable, writable } = new TransformStream<Uint8Array>();

  // Start streaming readable side to the file (runs concurrently)
  const writePromise = writeFile(filePath, readable);

  const writer = new ZipWriter(writable);
  await addBackupEntriesToZip(writer, appService, options, onProgress);
  await writer.close();
  await writePromise;
}

/**
 * Validate that zip entries contain a valid backup structure.
 * Must contain library.json at the root level.
 */
export function validateBackupStructure(entryNames: string[]): boolean {
  return entryNames.some((name) => name === getLibraryFilename());
}

/**
 * Restore library from a zip backup, merging with existing data.
 * - Override book files and cover images for existing books
 * - Merge book config files (keep higher progress, merge notes)
 * - Add new books not present in current library
 * - Import orphan hash directories not listed in library.json
 * - Restore global settings (settings.json), deep-merged onto current
 *
 * A whole-sync snapshot (`manifest.json` present) additionally restores the
 * custom asset bundles (dictionaries/fonts/textures) and reading statistics.
 * Snapshot file entries are prefixed with their BaseDir, so both the native
 * extractor (`destDir` = the app data root) and the JS fallback place them
 * correctly.
 */
export async function restoreFromBackupZip(
  appService: AppService,
  zipBlob: Blob,
  onProgress?: ProgressCallback,
  /** Where the zip lives (path or picker URI); lets Tauri extract it natively. */
  source?: string,
): Promise<{ booksAdded: number; booksUpdated: number; settingsRestored: boolean }> {
  await configureZip();
  const { BlobReader, ZipReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');

  const reader = new ZipReader(new BlobReader(zipBlob));
  const entries = await reader.getEntries();

  // Validate structure
  const entryNames = entries.map((e) => e.filename);
  if (!validateBackupStructure(entryNames)) {
    await reader.close();
    throw new Error('Invalid backup file: missing library.json');
  }

  // Filter to file entries only (directories don't have getData)
  const fileEntries = entries.filter((e) => !e.directory);

  // Detect a whole-sync snapshot. Its entries are BaseDir-prefixed; legacy
  // backups keep flat `<hash>/…` book names.
  const manifestEntry = fileEntries.find((e) => e.filename === SNAPSHOT_MANIFEST_FILENAME);
  let isSnapshot = false;
  if (manifestEntry) {
    try {
      const raw = await manifestEntry.getData!(new Uint8ArrayWriter());
      const manifest = JSON.parse(new TextDecoder().decode(raw)) as SnapshotManifest;
      if (manifest.format !== SNAPSHOT_FORMAT || manifest.version > SNAPSHOT_VERSION) {
        throw new Error(`unsupported snapshot version: ${manifest.version}`);
      }
      isSnapshot = true;
    } catch (error) {
      await reader.close();
      throw new Error(`Invalid sync snapshot manifest: ${String(error)}`);
    }
  }

  // `snapshotBaseOfEntry` maps a snapshot entry to its BaseDir. For a legacy
  // backup every file belongs to Books and keeps its raw name.
  const baseOfEntry = (name: string): BaseDir =>
    (isSnapshot ? snapshotBaseOfEntry(name) : 'Books') ?? 'Books';
  const relOfEntry = (name: string): string => {
    const base = baseOfEntry(name);
    return isSnapshot && name.startsWith(`${base}/`) ? name.slice(base.length + 1) : name;
  };
  const isAssetEntry = (name: string): boolean => {
    const base = snapshotBaseOfEntry(name);
    return base !== null && base !== 'Books';
  };
  const isControlEntry = (name: string): boolean =>
    name === SNAPSHOT_MANIFEST_FILENAME ||
    name === STATS_SNAPSHOT_FILENAME ||
    name === SETTINGS_BACKUP_FILENAME ||
    name === getLibraryFilename();

  // Read backup library.json
  const libraryEntry = fileEntries.find((e) => e.filename === getLibraryFilename());
  if (!libraryEntry) {
    await reader.close();
    throw new Error('Cannot read library.json from backup');
  }
  const libraryData = await libraryEntry.getData!(new Uint8ArrayWriter());
  const backupBooks: Book[] = JSON.parse(new TextDecoder().decode(libraryData));

  // Load current library
  const currentBooks = await appService.loadLibraryBooks();

  const currentBooksMap = new Map<string, Book>();
  for (const book of currentBooks) {
    currentBooksMap.set(book.hash, book);
  }

  const bookEntries = fileEntries.filter(
    (e) => !isControlEntry(e.filename) && !isAssetEntry(e.filename),
  );
  const assetEntries = fileEntries.filter((e) => isAssetEntry(e.filename));

  // Collect orphan hash directories: in zip but not in library.json
  const backupHashes = new Set(backupBooks.map((b) => b.hash));
  const orphanHashes = new Set<string>();
  for (const entry of bookEntries) {
    const slashIdx = relOfEntry(entry.filename).indexOf('/');
    if (slashIdx < 0) continue;
    const dir = relOfEntry(entry.filename).slice(0, slashIdx);
    if (dir && !backupHashes.has(dir)) {
      orphanHashes.add(dir);
    }
  }

  let booksAdded = 0;
  let booksUpdated = 0;
  const revivedBooks: RevivedBook[] = [];
  // Plan first so progress can count the whole job: the config.json of a
  // book already in the library is merged in JS, every other entry is
  // extracted in one pass, then orphan books are imported from disk.
  const configMerges: { entry: FileEntry; rel: string }[] = [];
  const bulkEntries: FileEntry[] = [];
  const orphanImports: { entry: FileEntry; rel: string }[] = [];

  for (const backupBook of backupBooks) {
    const existingBook = currentBooksMap.get(backupBook.hash);
    const bookDir = backupBook.hash;

    // Get all file entries for this book's directory (BaseDir-relative).
    const bookFileEntries = bookEntries.filter((e) =>
      relOfEntry(e.filename).startsWith(`${bookDir}/`),
    );

    if (existingBook) {
      // Update: override book file and cover, merge config
      for (const entry of bookFileEntries) {
        const rel = relOfEntry(entry.filename);
        if (rel.endsWith('/config.json')) configMerges.push({ entry, rel });
        else bulkEntries.push(entry);
      }

      // Merge book metadata (timestamps, deletedAt reconciliation). A book
      // deleted locally but present in the backup is "revived" — collect it
      // so its download state and updatedAt can be fixed up after the loop.
      const wasRevived = !!existingBook.deletedAt && !backupBook.deletedAt;
      Object.assign(existingBook, mergeBookMetadata(existingBook, backupBook));
      if (wasRevived) revivedBooks.push({ book: existingBook, backup: backupBook });
      booksUpdated++;
    } else {
      // Add new book: extract all files
      if (!(await appService.exists(bookDir, 'Books'))) {
        await appService.createDir(bookDir, 'Books');
      }
      bulkEntries.push(...bookFileEntries);
      currentBooks.push(backupBook);
      currentBooksMap.set(backupBook.hash, backupBook);
      booksAdded++;
    }
  }

  // Orphan directories: hash dirs in zip not listed in library.json.
  for (const hash of orphanHashes) {
    if (currentBooksMap.has(hash)) continue;
    const orphanEntries = bookEntries.filter((e) => relOfEntry(e.filename).startsWith(`${hash}/`));
    // Find the book file by extension
    const bookEntry = orphanEntries.find((e) => {
      const ext = e.filename.split('.').pop()?.toLowerCase() ?? '';
      return BOOK_EXTS.has(ext);
    });
    if (!bookEntry) continue;
    if (!(await appService.exists(hash, 'Books'))) {
      await appService.createDir(hash, 'Books');
    }
    bulkEntries.push(...orphanEntries);
    orphanImports.push({ entry: bookEntry, rel: relOfEntry(bookEntry.filename) });
  }

  // Asset bundles are plain binary copies — no config merge, no orphan import.
  bulkEntries.push(...assetEntries);

  const total = configMerges.length + bulkEntries.length + orphanImports.length;
  let done = 0;
  const tick = (name: string) => onProgress?.(++done, total, name);

  // Merged configs are written only once the book files they describe are
  // on disk, so a failed extraction leaves the current configs untouched.
  const mergedConfigs: { rel: string; json: string }[] = [];
  for (const { entry, rel } of configMerges) {
    tick(entry.filename);
    const data = await entry.getData!(new Uint8ArrayWriter());
    let currentConfig: Partial<BookConfig> = {};
    try {
      const str = (await appService.readFile(rel, 'Books', 'text')) as string;
      currentConfig = JSON.parse(str);
    } catch {
      /* use empty config if current doesn't exist */
    }
    const backupConfig: Partial<BookConfig> = JSON.parse(new TextDecoder().decode(data));
    const mergedConfig = mergeBookConfigs(currentConfig, backupConfig);
    mergedConfigs.push({ rel, json: JSON.stringify(mergedConfig) });
  }

  await extractEntries(
    appService,
    bulkEntries,
    source,
    (current, _bulkTotal, name) => {
      onProgress?.(configMerges.length + current, total, name);
    },
    {
      snapshot: isSnapshot,
      baseOfEntry,
      relOfEntry,
    },
  );
  done = configMerges.length + bulkEntries.length;
  for (const { rel, json } of mergedConfigs) {
    await appService.writeFile(rel, 'Books', json);
  }

  for (const { entry, rel } of orphanImports) {
    tick(entry.filename);
    try {
      const filePath = await appService.resolveFilePath(rel, 'Books');
      const imported = await appService.importBook(filePath, currentBooks, { overwrite: true });
      if (imported) {
        currentBooksMap.set(imported.hash, imported);
        booksAdded++;
      }
    } catch (error) {
      console.warn(`Failed to import orphan book from ${entry.filename}:`, error);
    }
  }

  // Make revived books out-rank the cloud's deletion tombstone in the
  // next sync, without disturbing the library's "Updated" sort order.
  reviveRestoredBooks(revivedBooks);

  // Save merged library
  await appService.saveLibraryBooks(currentBooks);

  // Restore global settings if the backup carries them. Blacklisted
  // fields are absent from the snapshot, so the current device keeps
  // its own values for those after the deep merge.
  let settingsRestored = false;
  const settingsEntry = fileEntries.find((e) => e.filename === SETTINGS_BACKUP_FILENAME);
  if (settingsEntry) {
    try {
      const data = await settingsEntry.getData!(new Uint8ArrayWriter());
      const backupSettings: Partial<SystemSettings> = JSON.parse(new TextDecoder().decode(data));
      const currentSettings = await appService.loadSettings();
      await appService.saveSettings(mergeRestoredSettings(currentSettings, backupSettings));
      settingsRestored = true;
    } catch (error) {
      console.warn('Failed to restore settings from backup:', error);
    }
  }

  // Reading statistics ride a JSON snapshot rather than the SQLite file; merge
  // them with the same per-event LWW as a server pull. Best-effort: a missing
  // stats DB is created here, and a malformed section must not fail the whole
  // restore.
  const statsEntry = fileEntries.find((e) => e.filename === STATS_SNAPSHOT_FILENAME);
  if (statsEntry) {
    try {
      const raw = await statsEntry.getData!(new Uint8ArrayWriter());
      await importStatsSnapshot(appService, JSON.parse(new TextDecoder().decode(raw)));
    } catch (error) {
      console.warn('Failed to restore reading statistics from backup:', error);
    }
  }

  await reader.close();

  return { booksAdded, booksUpdated, settingsRestored };
}

/**
 * Write zip entries into their destination dirs: natively on Tauri when the
 * zip's location is known, otherwise (web, or a native failure) one file at a
 * time through the IPC bridge.
 *
 * For a snapshot the native extractor is rooted at the app data dir and gets
 * the full BaseDir-prefixed names; the JS fallback maps each entry back to its
 * BaseDir. Legacy backups write every entry to Books unchanged.
 */
async function extractEntries(
  appService: AppService,
  entries: FileEntry[],
  source: string | undefined,
  onProgress: ProgressCallback | undefined,
  target: {
    snapshot: boolean;
    baseOfEntry: (name: string) => BaseDir;
    relOfEntry: (name: string) => string;
  },
): Promise<void> {
  if (isTauriAppPlatform() && source) {
    try {
      const destDir = await appService.resolveFilePath('', target.snapshot ? 'Data' : 'Books');
      const names = entries.map((e) => e.filename);
      await invokeZipCommand(
        'extract_backup_zip',
        { src: source, destDir, entries: names },
        onProgress,
      );
      return;
    } catch (error) {
      console.warn(
        'Native backup extractor failed, writing through the IPC bridge instead:',
        error,
      );
    }
  }
  const { Uint8ArrayWriter } = await import('@zip.js/zip.js');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    onProgress?.(i + 1, entries.length, entry.filename);
    const data = await entry.getData!(new Uint8ArrayWriter());
    await appService.writeFile(
      target.relOfEntry(entry.filename),
      target.baseOfEntry(entry.filename),
      data.buffer as ArrayBuffer,
    );
  }
}

/**
 * Create and save a backup zip file.
 * On Tauri, streams directly to disk to avoid holding the entire zip in memory.
 * On web, builds the zip in memory and triggers a download.
 */
export async function saveBackupFile(
  appService: AppService,
  filename: string,
  options: BackupOptions = {},
  onProgress?: ProgressCallback,
): Promise<boolean> {
  if (isTauriAppPlatform()) {
    // Tauri: stream directly to the chosen file path
    const { save: saveDialog } = await import('@tauri-apps/plugin-dialog');
    const ext = filename.split('.').pop() || 'zip';
    const filePath = await saveDialog({
      defaultPath: filename,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!filePath) return false;
    await createBackupZipToFile(appService, filePath, options, onProgress);
    return true;
  } else {
    // Web: build zip in memory then save
    const zipData = await createBackupZip(appService, options, onProgress);
    let filePath: string | undefined;
    return appService.saveFile(filename, zipData, { filePath, mimeType: 'application/zip' });
  }
}

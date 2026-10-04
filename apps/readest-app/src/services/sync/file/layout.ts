import { Book } from '@/types/book';
import { EXTS } from '@/libs/document';
import { makeSafeFilename } from '@/utils/misc';

/**
 * Layout convention for the "Readest" subtree under the user's configured
 * rootPath, shared by every file-based sync provider (WebDAV today; Google
 * Drive / Dropbox / FTP / SFTP in future). The whole sync feature is scoped
 * to this subtree so we never touch unrelated files in the user's storage.
 *
 * Tree:
 *   <rootPath>/
 *     Readest/
 *       library.json                                 ← shared index
 *       books/
 *         <hash>/
 *           <safe-title>.<ext>                       ← the book file
 *           cover.png                                ← optional
 *           config.json                              ← progress + booknotes
 *
 * Why hash directories: avoids title collisions and makes title edits a
 * pure metadata operation (no remote rename). The friendly file name
 * inside the directory keeps the remote browse experience readable.
 *
 * These builders are pure functions of `rootPath` — no transport knowledge.
 * The directory/file names below are a FROZEN wire layout: changing them
 * would orphan every existing remote tree, so they must stay byte-stable.
 */

export const SYNC_BASE_DIR = 'Readest';
export const SYNC_BOOKS_DIR = 'books';
export const SYNC_LIBRARY_FILE = 'library.json';
export const SYNC_BOOK_CONFIG_FILE = 'config.json';
export const SYNC_BOOK_COVER_FILE = 'cover.png';
// Portable app preferences (reader layout/typography, translation, highlight
// colours, AI/TTS endpoint config, dictionary prefs) live beside the index so a
// second device picks them up on its first sync. Device-local fields and
// credentials are never written here — see settingsSync.ts.
export const SYNC_SETTINGS_FILE = 'settings.json';
// TTS section packs (<section>-<keysfp>.mp3 + .json sidecars) live in a
// per-book subdirectory. Additive to the frozen layout above: older clients
// simply never look inside it.
export const SYNC_BOOK_TTS_DIR = 'tts';

/**
 * Normalise the user-entered rootPath so the rest of the code can rely on
 * a leading slash and no trailing slash (root = "/").
 */
export const normalizeRoot = (rootPath: string | undefined): string => {
  if (!rootPath) return '/';
  let p = rootPath.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
};

/** Join normalised path segments with single slashes, leading-slash kept. */
const join = (...parts: string[]): string => {
  const cleaned = parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter((p) => p.length > 0);
  return `/${cleaned.join('/')}`;
};

/** Absolute path of the Readest base directory (where library.json lives). */
export const buildBasePath = (rootPath: string): string =>
  join(normalizeRoot(rootPath), SYNC_BASE_DIR);

/** Absolute path of the per-book directory keyed by hash. */
export const buildBookDirPath = (rootPath: string, bookHash: string): string =>
  join(buildBasePath(rootPath), SYNC_BOOKS_DIR, bookHash);

/** Absolute path of the per-book TTS pack directory. */
export const buildBookTTSDirPath = (rootPath: string, bookHash: string): string =>
  join(buildBookDirPath(rootPath, bookHash), SYNC_BOOK_TTS_DIR);

/** Absolute path of one TTS pack file (or sidecar) inside the tts dir. */
export const buildBookTTSFilePath = (rootPath: string, bookHash: string, name: string): string =>
  join(buildBookTTSDirPath(rootPath, bookHash), name);

/** Absolute path of a book's config.json (progress + booknotes). */
export const buildBookConfigPath = (rootPath: string, bookHash: string): string =>
  join(buildBookDirPath(rootPath, bookHash), SYNC_BOOK_CONFIG_FILE);

/** Absolute path of the shared library.json index. */
export const buildLibraryPath = (rootPath: string): string =>
  join(buildBasePath(rootPath), SYNC_LIBRARY_FILE);

/** Absolute path of the shared app-settings snapshot. */
export const buildSettingsPath = (rootPath: string): string =>
  join(buildBasePath(rootPath), SYNC_SETTINGS_FILE);

/**
 * Imported asset kinds mirrored over a file backend. Address by `contentId`
 * (immutable across devices), never by `bundleDir` (device-local, re-minted on
 * receive). Layout:
 *   Readest/Assets/manifest.json                       ← portable metadata
 *   Readest/Assets/Fonts/<contentId>/<filename>
 *   Readest/Assets/Textures/<contentId>/<filename>
 *   Readest/Assets/Dictionaries/<contentId>/<filename> ← one file per file
 */
export type SyncAssetKind = 'font' | 'texture' | 'dictionary';

const SYNC_ASSET_DIRS: Record<SyncAssetKind, string> = {
  font: 'Fonts',
  texture: 'Textures',
  dictionary: 'Dictionaries',
};

/** Absolute path of the shared asset metadata manifest. */
export const buildAssetsManifestPath = (rootPath: string): string =>
  join(buildBasePath(rootPath), 'Assets', 'manifest.json');

/** Absolute path of one asset's remote bundle directory. */
export const buildAssetDirPath = (
  rootPath: string,
  kind: SyncAssetKind,
  contentId: string,
): string => join(buildBasePath(rootPath), 'Assets', SYNC_ASSET_DIRS[kind], contentId);

/** Absolute path of one file inside an asset's remote bundle directory. */
export const buildAssetFilePath = (
  rootPath: string,
  kind: SyncAssetKind,
  contentId: string,
  filename: string,
): string => join(buildAssetDirPath(rootPath, kind, contentId), filename);

/**
 * Friendly book file name "<sanitized title>.<ext>" used inside the
 * per-hash directory. Collisions across books are impossible because
 * each book lives in its own hash dir; collisions inside a single
 * hash dir are also impossible because there's only ever one book file.
 *
 * Re-uses readest's existing `makeSafeFilename` so naming rules are
 * consistent with the local on-disk layout (which is `<hash>/<title>.<ext>`).
 */
export const buildBookFileName = (book: Book): string => {
  const ext = EXTS[book.format] || 'bin';
  const baseName = book.sourceTitle || book.title || book.hash;
  return `${makeSafeFilename(baseName)}.${ext}`;
};

/** Absolute path of the book file, including the friendly file name. */
export const buildBookFilePath = (rootPath: string, book: Book): string =>
  join(buildBookDirPath(rootPath, book.hash), buildBookFileName(book));

/** Absolute path of the book cover image. */
export const buildBookCoverPath = (rootPath: string, bookHash: string): string =>
  join(buildBookDirPath(rootPath, bookHash), SYNC_BOOK_COVER_FILE);

/**
 * Walk the parents of an absolute path, top-down, so callers can
 * MKCOL each segment idempotently before writing a file. Excludes the
 * leaf itself.
 *
 * Example: ancestorsOf('/a/b/c/file.json') -> ['/a', '/a/b', '/a/b/c']
 */
export const ancestorsOf = (absolutePath: string): string[] => {
  const segments = absolutePath.split('/').filter(Boolean);
  if (segments.length <= 1) return [];
  const out: string[] = [];
  let acc = '';
  for (let i = 0; i < segments.length - 1; i += 1) {
    acc += `/${segments[i]}`;
    out.push(acc);
  }
  return out;
};

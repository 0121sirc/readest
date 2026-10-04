/**
 * Cross-device sync of imported custom fonts, textures and dictionaries over a
 * file backend (WebDAV today), mirroring the native Readest Cloud `font` /
 * `texture` / `dictionary` replica kinds but riding the user's own storage.
 *
 * Metadata travels in `Readest/Assets/manifest.json`; each bundle's files live
 * under `Readest/Assets/<Kind>/<contentId>/<filename>` and are addressed by the
 * cross-device `contentId` (immutable), never by `bundleDir` (device-local).
 *
 * Merge policy: add + tombstone union. A live local entry always wins over a
 * remote duplicate (its `bundleDir` keeps pointing at already-downloaded
 * bytes); remote-only entries are added as `unavailable` placeholders and their
 * bytes fetched below. Deletions propagate: a remote tombstone soft-deletes the
 * local entry and drops the remote bundle directory.
 */
import type { EnvConfigType } from '@/services/environment';
import type { CustomFont } from '@/styles/fonts';
import { getFontId } from '@/styles/fonts';
import type { CustomTexture } from '@/styles/textures';
import { getTextureId } from '@/styles/textures';
import type { ImportedDictionary } from '@/services/dictionaries/types';
import { enumerateDictionaryFiles } from '@/services/sync/adapters/dictionary';
import { useCustomFontStore } from '@/store/customFontStore';
import { useCustomTextureStore } from '@/store/customTextureStore';
import { useCustomDictionaryStore } from '@/store/customDictionaryStore';
import { getFilename } from '@/utils/path';
import { uniqueId } from '@/utils/misc';
import { useSettingsStore } from '@/store/settingsStore';
import type { FileSyncProvider } from './provider';
import {
  ancestorsOf,
  buildAssetDirPath,
  buildAssetFilePath,
  buildAssetsManifestPath,
} from './layout';

export const ASSETS_MANIFEST_VERSION = 1;

interface PortableFont {
  contentId: string;
  name: string;
  filename: string;
  family?: string;
  style?: string;
  weight?: number;
  variable?: boolean;
  byteSize?: number;
  downloadedAt?: number;
  deletedAt?: number;
  reincarnation?: string;
}

interface PortableTexture {
  contentId: string;
  name: string;
  filename: string;
  downloadedAt?: number;
  deletedAt?: number;
  reincarnation?: string;
}

interface PortableDictionary {
  contentId: string;
  name: string;
  kind: ImportedDictionary['kind'];
  lang?: string;
  addedAt: number;
  files: ImportedDictionary['files'];
  plugin?: ImportedDictionary['plugin'];
  unsupported?: boolean;
  unsupportedReason?: string;
  deletedAt?: number;
  reincarnation?: string;
}

export interface AssetsManifest {
  version: number;
  updatedAt: number;
  fonts: PortableFont[];
  textures: PortableTexture[];
  dictionaries: PortableDictionary[];
}

const snapshotKey = (backendKind: string) => `readest_file_assets_sync_v1:${backendKind}`;

const readSnapshot = (backendKind: string): string | null => {
  try {
    return localStorage.getItem(snapshotKey(backendKind));
  } catch {
    return null;
  }
};

const writeSnapshot = (backendKind: string, hash: string): void => {
  try {
    localStorage.setItem(snapshotKey(backendKind), hash);
  } catch {
    // Storage unavailable; the next run re-pushes (idempotent).
  }
};

const hashManifest = (manifest: AssetsManifest): string => {
  // `updatedAt` is regenerated per run and must not affect change detection.
  const text = JSON.stringify({
    version: manifest.version,
    fonts: manifest.fonts,
    textures: manifest.textures,
    dictionaries: manifest.dictionaries,
  });
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  return `${(hash >>> 0).toString(36)}:${text.length}`;
};

const toPortableFont = (font: CustomFont): PortableFont | null => {
  if (!font.contentId) return null;
  return {
    contentId: font.contentId,
    name: font.name,
    filename: getFilename(font.path),
    family: font.family,
    style: font.style,
    weight: font.weight,
    variable: font.variable,
    byteSize: font.byteSize,
    downloadedAt: font.downloadedAt,
    deletedAt: font.deletedAt,
    reincarnation: font.reincarnation,
  };
};

const toPortableTexture = (texture: CustomTexture): PortableTexture | null => {
  if (!texture.contentId) return null;
  return {
    contentId: texture.contentId,
    name: texture.name,
    filename: getFilename(texture.path),
    downloadedAt: texture.downloadedAt,
    deletedAt: texture.deletedAt,
    reincarnation: texture.reincarnation,
  };
};

const toPortableDictionary = (dict: ImportedDictionary): PortableDictionary | null => {
  if (!dict.contentId) return null;
  return {
    contentId: dict.contentId,
    name: dict.name,
    kind: dict.kind,
    lang: dict.lang,
    addedAt: dict.addedAt,
    files: dict.files,
    plugin: dict.plugin,
    unsupported: dict.unsupported,
    unsupportedReason: dict.unsupportedReason,
    deletedAt: dict.deletedAt,
    reincarnation: dict.reincarnation,
  };
};

/** Bookkeeping-only copy of the portable manifest, stably ordered for hashing. */
const snapshotManifest = (): AssetsManifest => {
  const byContentId = <T extends { contentId: string }>(a: T, b: T) =>
    a.contentId.localeCompare(b.contentId);
  const fonts = useCustomFontStore
    .getState()
    .fonts.map(toPortableFont)
    .filter((f): f is PortableFont => f !== null)
    .sort(byContentId);
  const textures = useCustomTextureStore
    .getState()
    .textures.map(toPortableTexture)
    .filter((t): t is PortableTexture => t !== null)
    .sort(byContentId);
  const dictionaries = useCustomDictionaryStore
    .getState()
    .dictionaries.map(toPortableDictionary)
    .filter((d): d is PortableDictionary => d !== null)
    .sort(byContentId);
  return { version: ASSETS_MANIFEST_VERSION, updatedAt: Date.now(), fonts, textures, dictionaries };
};

/** Union-merge a remote manifest into the local stores (add + tombstone). */
const applyRemoteManifest = (manifest: AssetsManifest): void => {
  const fontStore = useCustomFontStore.getState();
  for (const remote of manifest.fonts ?? []) {
    const local = fontStore.fonts.find((f) => f.contentId === remote.contentId);
    if (remote.deletedAt) {
      if (local && !local.deletedAt) fontStore.softDeleteByContentId(remote.contentId);
      continue;
    }
    if (local) continue; // local entry (and its bytes) win
    const bundleDir = uniqueId();
    fontStore.applyRemoteFont({
      id: getFontId(remote.name),
      name: remote.name,
      path: `${bundleDir}/${remote.filename}`,
      bundleDir,
      contentId: remote.contentId,
      family: remote.family,
      style: remote.style,
      weight: remote.weight,
      variable: remote.variable,
      byteSize: remote.byteSize,
      unavailable: true,
      reincarnation: remote.reincarnation,
    });
  }

  const textureStore = useCustomTextureStore.getState();
  for (const remote of manifest.textures ?? []) {
    const local = textureStore.textures.find((t) => t.contentId === remote.contentId);
    if (remote.deletedAt) {
      if (local && !local.deletedAt) textureStore.softDeleteByContentId(remote.contentId);
      continue;
    }
    if (local) continue;
    const bundleDir = uniqueId();
    textureStore.applyRemoteTexture({
      id: getTextureId(remote.name),
      name: remote.name,
      path: `${bundleDir}/${remote.filename}`,
      bundleDir,
      contentId: remote.contentId,
      unavailable: true,
      reincarnation: remote.reincarnation,
    });
  }

  const dictStore = useCustomDictionaryStore.getState();
  for (const remote of manifest.dictionaries ?? []) {
    const local = dictStore.dictionaries.find((d) => d.contentId === remote.contentId);
    if (remote.deletedAt) {
      if (local && !local.deletedAt) dictStore.softDeleteByContentId(remote.contentId);
      continue;
    }
    if (local) continue;
    const bundleDir = uniqueId();
    dictStore.applyRemoteDictionary({
      id: remote.contentId,
      contentId: remote.contentId,
      kind: remote.kind,
      name: remote.name,
      bundleDir,
      files: remote.files ?? {},
      lang: remote.lang,
      addedAt: remote.addedAt ?? Date.now(),
      unsupported: remote.unsupported,
      unsupportedReason: remote.unsupportedReason,
      plugin: remote.plugin,
      reincarnation: remote.reincarnation,
      unavailable: true,
    });
  }
};

const deleteRemoteBundle = async (provider: FileSyncProvider, dir: string): Promise<void> => {
  try {
    await provider.deleteDir(dir);
  } catch {
    // Missing dir or transient failure; a later run retries.
  }
};

/** Upload one local file to the remote path unless it already exists. */
const uploadIfMissing = async (
  provider: FileSyncProvider,
  appService: Awaited<ReturnType<EnvConfigType['getAppService']>>,
  remotePath: string,
  localPath: string,
  base: 'Fonts' | 'Images' | 'Dictionaries',
): Promise<void> => {
  if (await provider.head(remotePath)) return;
  await provider.ensureDir(ancestorsOf(remotePath));
  if (provider.uploadStream) {
    const absolute = await appService.resolveFilePath(localPath, base);
    if (await provider.uploadStream(remotePath, absolute)) return;
  }
  const data = (await appService.readFile(localPath, base, 'binary')) as ArrayBuffer;
  await provider.writeBinary(remotePath, data);
};

/** Download one remote file to the local path unless it already exists. */
const downloadIfMissing = async (
  provider: FileSyncProvider,
  appService: Awaited<ReturnType<EnvConfigType['getAppService']>>,
  remotePath: string,
  bundleDir: string,
  filename: string,
  base: 'Fonts' | 'Images' | 'Dictionaries',
): Promise<boolean> => {
  const localPath = `${bundleDir}/${filename}`;
  if (await appService.exists(localPath, base)) return false;
  const data = await provider.readBinary(remotePath);
  if (!data) return false;
  await appService.createDir(bundleDir, base, true);
  await appService.writeFile(localPath, base, data);
  return true;
};

const baseForKind = (kind: 'font' | 'texture' | 'dictionary') =>
  kind === 'font' ? 'Fonts' : kind === 'texture' ? 'Images' : 'Dictionaries';

/**
 * The per-asset stores are only hydrated when the reader / settings panels
 * mount, but the library sync pass runs before that. Seeding them from the
 * persisted `SystemSettings` arrays avoids applying remotes onto an empty store
 * (whose save-back would then drop the user's existing entries).
 */
const ensureStoresHydrated = async (envConfig: EnvConfigType): Promise<void> => {
  const settings = useSettingsStore.getState().settings;
  if (!settings) return;
  if (useCustomFontStore.getState().fonts.length === 0 && (settings.customFonts?.length ?? 0) > 0) {
    useCustomFontStore.setState({ fonts: settings.customFonts });
  }
  if (
    useCustomTextureStore.getState().textures.length === 0 &&
    (settings.customTextures?.length ?? 0) > 0
  ) {
    useCustomTextureStore.setState({ textures: settings.customTextures });
  }
  if (
    useCustomDictionaryStore.getState().dictionaries.length === 0 &&
    (settings.customDictionaries?.length ?? 0) > 0
  ) {
    await useCustomDictionaryStore.getState().loadCustomDictionaries(envConfig);
  }
};

export interface SyncAssetsOptions {
  provider: FileSyncProvider;
  backendKind: string;
  envConfig: EnvConfigType;
}

export interface SyncAssetsResult {
  applied: number;
  pushed: number;
  downloaded: number;
}

/**
 * Reconcile imported assets with the remote: pull metadata, fetch missing
 * bytes, push local changes, and propagate deletions. Safe to run every sync
 * pass — unchanged state does no writes.
 */
export const syncAssets = async (options: SyncAssetsOptions): Promise<SyncAssetsResult> => {
  const { provider, backendKind, envConfig } = options;
  const appService = await envConfig.getAppService();
  const root = provider.rootPath;

  await ensureStoresHydrated(envConfig);

  let remote: AssetsManifest | null = null;
  try {
    const raw = await provider.readText(buildAssetsManifestPath(root));
    if (raw) remote = JSON.parse(raw) as AssetsManifest;
  } catch (e) {
    console.warn('[assetSync] failed to read remote manifest', e);
  }

  if (remote) applyRemoteManifest(remote);

  const manifest = snapshotManifest();
  const hash = hashManifest(manifest);
  let pushed = 0;

  if (!remote || hash !== readSnapshot(backendKind)) {
    // Binaries first, manifest last, so a peer never sees an incomplete bundle.
    for (const font of manifest.fonts) {
      const dir = buildAssetDirPath(root, 'font', font.contentId);
      if (font.deletedAt) {
        await deleteRemoteBundle(provider, dir);
        continue;
      }
      const local = useCustomFontStore
        .getState()
        .fonts.find((f) => f.contentId === font.contentId && !f.deletedAt);
      if (!local || !(await appService.exists(local.path, 'Fonts'))) continue;
      await uploadIfMissing(
        provider,
        appService,
        buildAssetFilePath(root, 'font', font.contentId, font.filename),
        local.path,
        baseForKind('font'),
      );
      pushed++;
    }
    for (const texture of manifest.textures) {
      const dir = buildAssetDirPath(root, 'texture', texture.contentId);
      if (texture.deletedAt) {
        await deleteRemoteBundle(provider, dir);
        continue;
      }
      const local = useCustomTextureStore
        .getState()
        .textures.find((t) => t.contentId === texture.contentId && !t.deletedAt);
      if (!local || !(await appService.exists(local.path, 'Images'))) continue;
      await uploadIfMissing(
        provider,
        appService,
        buildAssetFilePath(root, 'texture', texture.contentId, texture.filename),
        local.path,
        baseForKind('texture'),
      );
      pushed++;
    }
    for (const dict of manifest.dictionaries) {
      const dir = buildAssetDirPath(root, 'dictionary', dict.contentId);
      if (dict.deletedAt) {
        await deleteRemoteBundle(provider, dir);
        continue;
      }
      const local = useCustomDictionaryStore
        .getState()
        .dictionaries.find((d) => d.contentId === dict.contentId && !d.deletedAt);
      if (!local) continue;
      for (const file of enumerateDictionaryFiles(local)) {
        if (!(await appService.exists(file.lfp, 'Dictionaries'))) continue;
        await uploadIfMissing(
          provider,
          appService,
          buildAssetFilePath(root, 'dictionary', dict.contentId, file.logical),
          file.lfp,
          baseForKind('dictionary'),
        );
        pushed++;
      }
    }

    try {
      await provider.ensureDir(ancestorsOf(buildAssetsManifestPath(root)));
      await provider.writeText(
        buildAssetsManifestPath(root),
        JSON.stringify(manifest),
        'application/json',
      );
    } catch (e) {
      console.warn('[assetSync] failed to write remote manifest', e);
      return { applied: 0, pushed: 0, downloaded: 0 };
    }
    writeSnapshot(backendKind, hash);
  }

  // Fetch any bytes a placeholder is still missing, then activate.
  let downloaded = 0;
  const fontStore = useCustomFontStore.getState();
  for (const font of fontStore.fonts.filter((f) => f.contentId && !f.deletedAt)) {
    const contentId = font.contentId!;
    const filename = getFilename(font.path);
    const fetched = await downloadIfMissing(
      provider,
      appService,
      buildAssetFilePath(root, 'font', contentId, filename),
      font.bundleDir ?? '',
      filename,
      'Fonts',
    );
    if (fetched) {
      downloaded++;
      await fontStore.activateFontByContentId(envConfig, contentId);
    } else if (!font.loaded) {
      await fontStore.activateFontByContentId(envConfig, contentId);
    }
  }

  const textureStore = useCustomTextureStore.getState();
  for (const texture of textureStore.textures.filter((t) => t.contentId && !t.deletedAt)) {
    const contentId = texture.contentId!;
    const filename = getFilename(texture.path);
    const fetched = await downloadIfMissing(
      provider,
      appService,
      buildAssetFilePath(root, 'texture', contentId, filename),
      texture.bundleDir ?? '',
      filename,
      'Images',
    );
    if (fetched) {
      downloaded++;
      await textureStore.activateTextureByContentId(envConfig, contentId);
    } else if (!texture.loaded) {
      await textureStore.activateTextureByContentId(envConfig, contentId);
    }
  }

  const dictStore = useCustomDictionaryStore.getState();
  for (const dict of dictStore.dictionaries.filter((d) => d.contentId && !d.deletedAt)) {
    const contentId = dict.contentId!;
    let any = false;
    for (const file of enumerateDictionaryFiles(dict)) {
      const fetched = await downloadIfMissing(
        provider,
        appService,
        buildAssetFilePath(root, 'dictionary', contentId, file.logical),
        dict.bundleDir,
        file.logical,
        'Dictionaries',
      );
      if (fetched) any = true;
    }
    if (any) {
      downloaded++;
      dictStore.markAvailableByContentId(contentId);
    }
  }

  return { applied: remote ? 1 : 0, pushed, downloaded };
};

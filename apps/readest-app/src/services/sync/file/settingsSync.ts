/**
 * Cross-device app-settings sync over a file backend (WebDAV today).
 *
 * The native replica channels carry settings only for signed-in Readest Cloud
 * users; local-first builds have no account, so portable preferences used to
 * stay on one device. This writes a small `Readest/settings.json` snapshot the
 * file sync engine can reconcile, so reader layout/typography, translation,
 * highlight colours, AI/TTS endpoint config and dictionary preferences follow
 * the user between devices.
 *
 * Merge policy is per-section last-writer-wins: each section carries its own
 * timestamp, so editing the AI config on one device and the layout on another
 * converges without one clobbering the other. Within a section the newest whole
 * object wins. Device-local fields (window widths, last-used notebook tab,
 * selected texture) and credentials/API keys are never written to the wire.
 */
import type { SystemSettings } from '@/types/settings';
import { useSettingsStore } from '@/store/settingsStore';
import {
  getOpenAITTSConfig,
  setOpenAITTSConfig,
  type OpenAITTSConfig,
} from '@/services/tts/providers/openaiConfig';
import type { FileSyncProvider } from './provider';
import { buildBasePath, buildSettingsPath } from './layout';

export const SETTINGS_SYNC_VERSION = 1;

const SECTION_NAMES = [
  'globalViewSettings',
  'globalReadSettings',
  'aiSettings',
  'dictionarySettings',
  'tts',
] as const;
type SectionName = (typeof SECTION_NAMES)[number];

interface RemoteSection {
  /** Wall-clock millis of the write that produced `v`. */
  t: number;
  /** The section value (secrets/device-local keys already stripped). */
  v: Record<string, unknown>;
}

interface RemoteSettingsPayload {
  version: number;
  sections: Partial<Record<SectionName, RemoteSection>>;
}

interface SectionStamp {
  hash: string;
  t: number;
}
type Snapshot = Partial<Record<SectionName, SectionStamp>>;

const snapshotKey = (backendKind: string) => `readest_file_settings_sync_v1:${backendKind}`;

const readSnapshot = (backendKind: string): Snapshot => {
  try {
    const raw = localStorage.getItem(snapshotKey(backendKind));
    return raw ? (JSON.parse(raw) as Snapshot) : {};
  } catch {
    return {};
  }
};

const writeSnapshot = (backendKind: string, snapshot: Snapshot): void => {
  try {
    localStorage.setItem(snapshotKey(backendKind), JSON.stringify(snapshot));
  } catch {
    // Storage unavailable; the next run re-publishes (idempotent).
  }
};

/** Drop the given keys from a shallow copy of `obj` (never mutates the input). */
const omit = (obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (keys.includes(key)) continue;
    out[key] = value;
  }
  return out;
};

/** Sort keys recursively so logically-equal objects hash equal regardless of key order. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);
    return out;
  }
  return value;
};

const hashValue = (value: unknown): string => {
  const text = JSON.stringify(canonical(value));
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  return `${(hash >>> 0).toString(36)}:${text.length}`;
};

/**
 * The portable slice of one section. `settings` is read fresh so the caller's
 * snapshot matches what is actually on disk.
 */
const pickSection = (section: SectionName, settings: SystemSettings): Record<string, unknown> => {
  switch (section) {
    case 'globalViewSettings':
      return omit(
        (settings.globalViewSettings ?? {}) as unknown as Record<string, unknown>,
        // Texture selection references a bundled image that has no cross-device
        // transport; sync of it, like sync of imported textures, is out of scope.
        ['backgroundTextureId'],
      );
    case 'globalReadSettings':
      return omit(
        (settings.globalReadSettings ?? {}) as unknown as Record<string, unknown>,
        // Per-device last-used notebook tab (upstream deliberately excludes it).
        ['notebookActiveTab'],
      );
    case 'aiSettings':
      return omit((settings.aiSettings ?? {}) as unknown as Record<string, unknown>, [
        'openrouterApiKey',
        'aiGatewayApiKey',
      ]);
    case 'dictionarySettings':
      return (settings.dictionarySettings ?? {}) as unknown as Record<string, unknown>;
    case 'tts':
      return omit(
        getOpenAITTSConfig() as unknown as Record<string, unknown>,
        // The endpoint key stays device-local, like the AI keys above.
        ['apiKey'],
      );
  }
};

/** Merge a remote section into a settings clone, preserving local secrets. */
const mergeSection = (
  next: SystemSettings,
  section: SectionName,
  value: Record<string, unknown>,
): void => {
  switch (section) {
    case 'globalViewSettings':
      next.globalViewSettings = {
        ...next.globalViewSettings,
        ...value,
      } as typeof next.globalViewSettings;
      break;
    case 'globalReadSettings':
      next.globalReadSettings = {
        ...next.globalReadSettings,
        ...value,
      } as typeof next.globalReadSettings;
      break;
    case 'aiSettings':
      next.aiSettings = { ...next.aiSettings, ...value } as typeof next.aiSettings;
      break;
    case 'dictionarySettings':
      next.dictionarySettings = {
        ...next.dictionarySettings,
        ...value,
      } as typeof next.dictionarySettings;
      break;
    case 'tts':
      // TTS config lives in localStorage, not SystemSettings; keep the local
      // API key and take the rest. Applies to sessions started after this.
      setOpenAITTSConfig({ ...getOpenAITTSConfig(), ...(value as Partial<OpenAITTSConfig>) });
      break;
  }
};

export interface SyncAppSettingsOptions {
  provider: FileSyncProvider;
  backendKind: string;
  /** Persist the merged settings (appService.saveSettings). */
  saveSettings: (next: SystemSettings) => Promise<void>;
}

export interface SyncAppSettingsResult {
  applied: boolean;
  pushed: boolean;
}

/**
 * Pull then push the portable settings snapshot. Safe to call every sync run:
 * unchanged sections are skipped, so a steady state does no network writes.
 */
export const syncAppSettings = async (
  options: SyncAppSettingsOptions,
): Promise<SyncAppSettingsResult> => {
  const { provider, backendKind } = options;
  const settings = useSettingsStore.getState().settings;
  if (!settings) return { applied: false, pushed: false };

  const path = buildSettingsPath(provider.rootPath);

  let remote: RemoteSettingsPayload | null = null;
  try {
    const raw = await provider.readText(path);
    if (raw) remote = JSON.parse(raw) as RemoteSettingsPayload;
  } catch (e) {
    console.warn('[settingsSync] failed to read remote settings', e);
  }

  const snapshot = readSnapshot(backendKind);
  const now = Date.now();
  const remoteSections = remote?.sections ?? {};
  const nextSections: Partial<Record<SectionName, RemoteSection>> = { ...remoteSections };
  const nextSettings: SystemSettings = { ...settings };
  let applied = false;
  let pushed = false;

  for (const section of SECTION_NAMES) {
    const local = pickSection(section, settings);
    const localHash = hashValue(local);
    const stamp = snapshot[section];
    const localChanged = !stamp || stamp.hash !== localHash;
    const remoteSection = remoteSections[section];

    if (remoteSection && (!stamp || remoteSection.t > stamp.t)) {
      // A local edit is assumed newer than a remote write unless the remote
      // timestamp is in the future (our run happens right after the edit).
      const localWins = localChanged && remoteSection.t <= now;
      if (!localWins) {
        mergeSection(nextSettings, section, remoteSection.v);
        snapshot[section] = { hash: hashValue(remoteSection.v), t: remoteSection.t };
        applied = true;
        continue;
      }
    }

    if (localChanged) {
      nextSections[section] = { t: now, v: local };
      snapshot[section] = { hash: localHash, t: now };
      pushed = true;
    }
  }

  if (applied) {
    useSettingsStore.getState().setSettings(nextSettings);
    await options.saveSettings(nextSettings);
  }

  if (pushed) {
    try {
      await provider.ensureDir([buildBasePath(provider.rootPath)]);
      const payload: RemoteSettingsPayload = {
        version: SETTINGS_SYNC_VERSION,
        sections: nextSections,
      };
      await provider.writeText(path, JSON.stringify(payload), 'application/json');
    } catch (e) {
      console.warn('[settingsSync] failed to write remote settings', e);
      return { applied, pushed: false };
    }
  }

  if (applied || pushed) writeSnapshot(backendKind, snapshot);

  return { applied, pushed };
};

import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { settingsKeyForBackend } from '@/services/sync/cloudSyncProvider';
import type { FileSyncBackendKind } from '@/services/sync/file/providerRegistry';
import type { SystemSettings } from '@/types/settings';
import { mergeSyncedGlobalSettings, subscribeSettingsSync } from '@/utils/settingsSync';

/**
 * Adopt the connection slices (server URL / credentials) of the backends that
 * the sending window reports as changed, from the shared on-disk settings.
 * Credentials deliberately never ride the cross-window broadcast; both windows
 * read the same `settings.json`.
 */
const adoptConnectionSlices = (
  local: SystemSettings,
  disk: SystemSettings,
  kinds: string[],
): SystemSettings => {
  const next = { ...local } as unknown as Record<string, unknown>;
  for (const kind of kinds) {
    const key = settingsKeyForBackend(kind as FileSyncBackendKind);
    if (key && key in disk) next[key] = disk[key as keyof SystemSettings];
  }
  return next as unknown as SystemSettings;
};

/**
 * Adopt global settings broadcast by other windows/tabs (issue #4580). Without
 * this, a window that loaded before another window changed a global setting
 * would clobber that change with its own stale copy on its next save. On the
 * web build the broadcast travels over a BroadcastChannel; the desktop build
 * uses Tauri window events.
 */
export const useSettingsSync = () => {
  const { envConfig } = useEnv();

  useEffect(() => {
    const unlistenPromise = subscribeSettingsSync(async (payload) => {
      const { settings, setSettings } = useSettingsStore.getState();
      // Settings may not be loaded yet on this window; skip until they are.
      if (!settings.globalViewSettings) return;
      let local = settings;
      if (payload.connectionChanged?.length) {
        try {
          const appService = await envConfig.getAppService();
          const disk = await appService.loadSettings();
          local = adoptConnectionSlices(local, disk, payload.connectionChanged);
        } catch (e) {
          console.warn('settings sync: reloading connection slices failed', e);
        }
      }
      setSettings(mergeSyncedGlobalSettings(local, payload));
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [envConfig]);
};

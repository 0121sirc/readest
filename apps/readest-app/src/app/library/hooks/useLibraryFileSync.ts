import { useEffect, useMemo, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useQuotaStats } from '@/hooks/useQuotaStats';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { debounce } from '@/utils/debounce';
import { getActiveFileSyncBackends } from '@/services/sync/cloudSyncProvider';
import { runFileLibrarySyncPass } from '@/services/sync/file/runLibrarySync';

/**
 * Library-scoped auto-sync for every enabled third-party cloud backend (#5062) —
 * the parity counterpart of {@link useBooksSync} (native cloud).
 *
 * The reader's per-book `useFileSync` keeps a book's progress/notes in sync while
 * reading, but never touches the shared `library.json` index. This hook fills
 * that gap: it runs a sync pass whenever the library changes — importing,
 * deleting, or closing a book all mutate the library array — so `library.json`
 * (book metadata + tombstones) stays current on every mirror. It also watches
 * `settings`, so a preferences-only edit publishes without one.
 *
 * Mounted once at the app root (see `FileSyncAutoTrigger` in `Providers`), not
 * on the library page: the reader must trigger it too, and no page should have
 * to remember to.
 *
 * All the execution (engine construction, transport readiness, device ids,
 * strategy, progress, per-backend failure isolation, the held mutex) lives in
 * {@link runFileLibrarySyncPass}. This hook only decides WHEN to run.
 *
 * Convergence note: a pull that changes the library re-fires this effect, which
 * is exactly what lets a pass that only carried data forward (backend N learns
 * from backends 1..N-1, but not the reverse) converge on the following pass.
 */

/** Quiet window before an auto library sync fires; collapses import bursts. */
const SYNC_DEBOUNCE_MS = 5_000;

export const useLibraryFileSync = () => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const settings = useSettingsStore((s) => s.settings);
  const library = useLibraryStore((s) => s.library);
  const libraryLoaded = useLibraryStore((s) => s.libraryLoaded);
  const { userProfilePlan } = useQuotaStats();

  const hasBackends = getActiveFileSyncBackends(settings, userProfilePlan ?? 'free').length > 0;

  // Keep one stable debounced trigger that always calls the latest pass (via
  // ref), so it isn't recreated — and lost — on every settings change.
  const passRef = useRef<() => void>(() => {});
  passRef.current = () =>
    void runFileLibrarySyncPass(envConfig, _, { ifAvailable: true }).catch((e) =>
      console.warn('file library auto-sync failed', e),
    );
  const debouncedSync = useMemo(() => debounce(() => passRef.current(), SYNC_DEBOUNCE_MS), []);
  useEffect(() => () => debouncedSync.cancel(), [debouncedSync]);

  // Library changes — import (adds a row), delete (sets deletedAt), book close
  // (bumps updatedAt) — all mutate `library`, so this single effect covers them
  // plus the initial load pull.
  //
  // `settings` is included so a preferences-only edit (layout, translation,
  // AI/TTS, dictionary — see FileSyncEngine's settings step) also reaches the
  // backend without waiting for the next book change. The pass is idempotent
  // and snapshot-guarded, so the extra trigger settles after one run.
  useEffect(() => {
    if (!hasBackends || !libraryLoaded) return;
    debouncedSync();
  }, [library, settings, libraryLoaded, hasBackends, debouncedSync]);
};

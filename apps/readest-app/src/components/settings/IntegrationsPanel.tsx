import clsx from 'clsx';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MdChevronRight } from 'react-icons/md';
import { RiDiscordLine, RiCloudLine, RiCloudFill } from 'react-icons/ri';
import { useEnv } from '@/context/EnvContext';
import { useAuth } from '@/context/AuthContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useKeyDownActions } from '@/hooks/useKeyDownActions';
import { useQuotaStats } from '@/hooks/useQuotaStats';
import { useSettingsStore } from '@/store/settingsStore';
import { useFileSyncStore } from '@/store/fileSyncStore';
import { saveSysSettings } from '@/helpers/settings';
import { isCloudSyncAllowed, isReadestAccountHidden } from '@/utils/access';
import { navigateToLogin, navigateToProfile } from '@/utils/nav';
import WebDAVForm from './integrations/WebDAVForm';
import { persistCloudProviderEnabled } from './integrations/cloudSync';
import {
  canToggleCloudProvider,
  getReadestCloudRowStatus,
  getThirdPartyRowStatus,
  shouldShowCloudProviderBadge,
} from './integrations/cloudSyncStatus';
import {
  getCloudSyncProviders,
  isReadestCloudEnabled,
  resolveCloudSyncGate,
  settingsKeyForBackend,
  type CloudSyncProviderKind,
} from '@/services/sync/cloudSyncProvider';
import type { FileSyncBackendKind } from '@/services/sync/file/providerRegistry';
import SubPageHeader from './SubPageHeader';
import { BoxedList, NavigationRow, SectionTitle, SettingLabel, Tips } from './primitives';

type SubPage = 'webdav' | 'readest-cloud' | null;

/**
 * Integrations panel — single point of discovery for external service config:
 * KOReader Sync, Readwise, Hardcover, and OPDS Catalogs.
 *
 * Pattern: boxed list of NavigationRows. Each row pushes the panel into an
 * inline sub-page (with breadcrumb back-navigation matching the Dictionaries
 * pattern) — no nested modals.
 *
 * TODO(design-system): Once we extract BoxedList / NavigationRow primitives,
 * this panel and CustomDictionaries should both consume them instead of
 * inlining the chassis.
 */
const IntegrationsPanel: React.FC = () => {
  const _ = useTranslation();
  const router = useRouter();
  const { envConfig, appService } = useEnv();
  const { user } = useAuth();
  const { settings, requestedSubPage, setRequestedSubPage } = useSettingsStore();
  // Surface a library-wide WebDAV sync that's mid-flight in the row's
  // status line. Keeps the user from feeling like the run was lost
  // when they back out of the WebDAV sub-page or close the dialog.
  const isWebDAVSyncing = useFileSyncStore((s) => s.byKind.webdav?.isSyncing ?? false);
  const webdavLastError = useFileSyncStore((s) => s.lastErrorByKind.webdav);
  // Third-party cloud sync will be a premium feature (any paid plan), but it is
  // temporarily UNGATED while the feature stabilises — `isCloudSyncAllowed`
  // returns true for every plan until `CLOUD_SYNC_REQUIRES_PREMIUM` is flipped
  // back on. The `?? 'free'` keeps the (re-gated) loading state non-premium.
  const { userProfilePlan, customizationPurchased } = useQuotaStats();
  const isCloudSyncPremium = isCloudSyncAllowed(userProfilePlan ?? 'free', customizationPurchased);
  // Local-first mode hides the official cloud / account-bound integrations and
  // leaves only the third-party file backends.
  const hideAccount = isReadestAccountHidden();
  const premiumBadge = shouldShowCloudProviderBadge({
    signedIn: !!user,
    planLoading: userProfilePlan === undefined,
    isPremium: isCloudSyncPremium,
  })
    ? _('Premium')
    : undefined;

  const [subPage, setSubPage] = useState<SubPage>(null);

  // Android Back / Esc: when any integrations sub-page (WebDAV,
  // Readwise, Hardcover, OPDS, Send-to-Readest) is open, intercept and
  // step back to the integrations list instead of letting <Dialog>'s
  // listener close the whole Settings dialog. The hook registers its
  // sync `native-key-down` listener *after* <Dialog>'s, and
  // `dispatchSync` walks listeners LIFO — so this one claims Back first
  // when enabled and `return true` consumes the event. When subPage is
  // null the hook is disabled and Back falls through to close the dialog
  // as before.
  useKeyDownActions({
    enabled: subPage !== null,
    onCancel: () => setSubPage(null),
  });

  const toggleDiscordPresence = () => {
    const discordRichPresenceEnabled = !settings.discordRichPresenceEnabled;
    saveSysSettings(envConfig, 'discordRichPresenceEnabled', discordRichPresenceEnabled);
    if (discordRichPresenceEnabled && !user) {
      navigateToLogin(router);
    }
  };

  // Deep-link consumption: when a caller (e.g. OPDS browser close handler)
  // sets `requestedSubPage` in the store before opening the dialog, drill
  // straight into that sub-page on mount and clear the request so it doesn't
  // stick to the next open. Recognised values match the SubPage union.
  useEffect(() => {
    if (!requestedSubPage) return;
    const isCloudRequest = requestedSubPage === 'webdav' || requestedSubPage === 'cloudsync';
    // Cloud-sync sub-pages are premium-gated. If the plan is still loading, wait
    // (don't consume the request); once known, only honor it for paid plans.
    if (isCloudRequest && !isCloudSyncPremium) {
      if (userProfilePlan === undefined) return;
      setRequestedSubPage(null);
      return;
    }
    if (requestedSubPage === 'webdav') {
      setSubPage('webdav');
    } else if (requestedSubPage === 'cloudsync') {
      // Back-compat with the brief unified "Cloud Sync" page; WebDAV is the
      // supported backend on every platform in this build.
      setSubPage('webdav');
    }
    setRequestedSubPage(null);
  }, [requestedSubPage, setRequestedSubPage, isCloudSyncPremium, userProfilePlan]);

  // Sub-page wrapper matches the list-view's `my-4 w-full` so the
  // SubPageHeader's "Integrations" label lands at the exact same Y position
  // as the list-view's h2 — clicking a row reads as a navigation morph
  // rather than a layout shift.
  if (subPage === 'webdav')
    return (
      <div className='my-4 w-full'>
        <SubPageHeader
          parentLabel={_('Integrations')}
          currentLabel={_('WebDAV')}
          description={_(
            'Sync your library, reading progress, and highlights with a WebDAV server.',
          )}
          onBack={() => setSubPage(null)}
        />
        <WebDAVForm />
        {settings.webdav?.enabled && (
          <div className='mt-5'>
            <Tips>
              <li>
                {_('{{provider}} keeps a full copy of your books, progress, and annotations.', {
                  provider: _('WebDAV'),
                })}
              </li>
              <li>
                {_(
                  'App settings, reading statistics, and dictionaries still sync through your Readest account while signed in.',
                )}
              </li>
            </Tips>
          </div>
        )}
      </div>
    );
  if (subPage === 'readest-cloud')
    return (
      <div className='my-4 w-full'>
        <SubPageHeader
          parentLabel={_('Integrations')}
          currentLabel={_('Readest Cloud')}
          description={_('Sync your library, reading progress, and highlights with Readest Cloud.')}
          onBack={() => setSubPage(null)}
        />
        <BoxedList>
          <NavigationRow
            title={_('Account and Storage')}
            status={_('Manage your plan and stored files')}
            onClick={() => navigateToProfile(router)}
          />
        </BoxedList>
      </div>
    );
  // Cloud sync providers are independently selectable (#5062): any subset of
  // {Readest Cloud, WebDAV, Google Drive, S3, OneDrive, iCloud} can sync the
  // library at once. A "configured" third-party provider (WebDAV creds / a Drive
  // token) can be switched on inline; an unconfigured one must be opened to
  // connect.
  const providers = getCloudSyncProviders(settings);
  const readestEnabled = isReadestCloudEnabled(settings);
  const cloudGate = resolveCloudSyncGate(settings, userProfilePlan ?? 'free');
  const enabledBackends = cloudGate.backends;

  /** Book files have a home when Readest Cloud is on or some backend uploads them. */
  const booksBackedUpBy = (kind: FileSyncBackendKind): boolean =>
    readestEnabled ||
    enabledBackends.some(
      (k) => k !== kind && (settings[settingsKeyForBackend(k)]?.syncBooks ?? false),
    );

  const webdavConfigured = !!(settings.webdav?.serverUrl && settings.webdav?.username);
  const webdavStatus = getThirdPartyRowStatus(_, {
    enabled: !!settings.webdav?.enabled,
    configured: webdavConfigured,
    syncing: isWebDAVSyncing,
    paused: cloudGate.paused,
    lastError: webdavLastError,
    syncBooks: settings.webdav?.syncBooks ?? false,
    booksBackedUpElsewhere: booksBackedUpBy('webdav'),
  });
  const readestStatus = getReadestCloudRowStatus(_, {
    signedIn: !!user,
    planLoading: userProfilePlan === undefined,
    enabled: readestEnabled,
  });

  const toggleCloudProvider = async (kind: CloudSyncProviderKind, next: boolean) => {
    await persistCloudProviderEnabled(envConfig, kind, next);
  };

  return (
    <div className='my-4 w-full space-y-6'>
      <div className='w-full px-4'>
        <h2 className='mb-1.5 text-lg font-semibold tracking-tight'>{_('Integrations')}</h2>
        <p className='text-base-content/70 text-sm leading-relaxed'>
          {_('Connect Readest to external services for sync, highlights, and catalogs.')}
        </p>
      </div>

      <div className='w-full' data-setting-id='settings.integrations.cloudSync'>
        <SectionTitle className='mb-2'>{_('Cloud Sync')}</SectionTitle>
        <div className='card eink-bordered border-base-200 bg-base-100 overflow-hidden border'>
          <div
            className='divide-base-200 divide-y'
            role='group'
            aria-label={_('Cloud sync providers')}
          >
            {!hideAccount && (
              <CloudProviderRow
                icon={RiCloudFill}
                title={_('Readest Cloud')}
                status={readestStatus}
                checked={!!user && readestEnabled}
                canToggle={!!user}
                onToggle={(next) => toggleCloudProvider('readest', next)}
                onOpen={() => (user ? setSubPage('readest-cloud') : navigateToLogin(router))}
                toggleLabel={_('Sync with Readest Cloud')}
              />
            )}
            <CloudProviderRow
              icon={RiCloudLine}
              title={_('WebDAV')}
              status={webdavStatus}
              badge={premiumBadge}
              checked={!!settings.webdav?.enabled}
              canToggle={canToggleCloudProvider({
                isPremium: isCloudSyncPremium,
                isConfigured: webdavConfigured,
                isEnabled: !!settings.webdav?.enabled,
              })}
              onToggle={(next) => toggleCloudProvider('webdav', next)}
              onOpen={() => (isCloudSyncPremium ? setSubPage('webdav') : navigateToProfile(router))}
              toggleLabel={_('Sync with WebDAV')}
            />
          </div>
        </div>
        {providers.length === 0 && (
          <div className='mt-5'>
            <Tips>
              <li>
                {_(
                  'Library sync is off. Your books, progress, and annotations stay on this device.',
                )}
              </li>
              {!hideAccount && (
                <li>
                  {_(
                    'App settings, reading statistics, and dictionaries still sync through your Readest account while signed in.',
                  )}
                </li>
              )}
            </Tips>
          </div>
        )}
      </div>

      {!hideAccount && appService?.isDesktopApp && (
        <div className='w-full' data-setting-id='settings.integrations.discord'>
          <SectionTitle className='mb-2'>{_('Discord')}</SectionTitle>
          <div className='card eink-bordered border-base-200 bg-base-100 overflow-hidden border'>
            <div className='divide-base-200 divide-y'>
              <IntegrationToggleRow
                icon={RiDiscordLine}
                title={_('Show on Discord')}
                description={_("Display what I'm reading on Discord")}
                checked={settings.discordRichPresenceEnabled}
                onChange={toggleDiscordPresence}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface CloudProviderRowProps {
  icon: React.ElementType;
  title: string;
  status: string;
  /** This provider syncs the library. */
  checked: boolean;
  /** Can be toggled inline (configured, and allowed by the plan). */
  canToggle: boolean;
  onToggle: (next: boolean) => void;
  onOpen: () => void;
  /** Accessible label for the checkbox (e.g. "Sync with WebDAV"). */
  toggleLabel: string;
  /** End-aligned tier chip (e.g. "Premium") — uniform column before the checkbox. */
  badge?: string;
}

/**
 * A cloud-sync provider row. Two controls: a trailing checkbox that turns
 * this provider's library sync on or off (several may be on at once) —
 * enabled only when it's already configured — and the row body / chevron
 * that opens its config sub-page (connect, sync options, disconnect).
 */
const CloudProviderRow: React.FC<CloudProviderRowProps> = ({
  icon: Icon,
  title,
  status,
  checked,
  canToggle,
  onToggle,
  onOpen,
  toggleLabel,
  badge,
}) => {
  return (
    <div className='group flex w-full items-center gap-3 px-4 py-3'>
      <button
        type='button'
        onClick={onOpen}
        className={clsx(
          'flex min-w-0 flex-1 items-center gap-3 text-left',
          'focus-visible:ring-base-content/15 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset',
        )}
      >
        <span
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
            'bg-base-200 text-base-content/70',
            'transition-colors duration-150',
            'group-hover:bg-base-300/70',
          )}
        >
          <Icon className='h-5 w-5' />
        </span>
        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <SettingLabel>{title}</SettingLabel>
          <span className='text-base-content/65 truncate text-[0.85em]'>{status}</span>
        </div>
      </button>
      {badge && <span className='badge badge-sm badge-ghost shrink-0'>{badge}</span>}
      <input
        type='checkbox'
        className='checkbox checkbox-sm shrink-0'
        checked={checked}
        disabled={!canToggle}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={toggleLabel}
        title={toggleLabel}
      />
      <button
        type='button'
        onClick={onOpen}
        aria-label={title}
        className={clsx(
          'text-base-content/50 hover:text-base-content/80 shrink-0 rounded-sm',
          'focus-visible:ring-base-content/15 focus-visible:outline-hidden focus-visible:ring-2',
        )}
      >
        <MdChevronRight className='h-5 w-5' />
      </button>
    </div>
  );
};

interface IntegrationToggleRowProps {
  icon: React.ElementType;
  title: string;
  description: string;
  checked: boolean;
  onChange: () => void;
}

/**
 * Sibling of IntegrationRow for settings that are a simple on/off toggle
 * (no sub-page). Keeps the same circular-badge chassis so toggle and
 * navigation rows read as one consistent list.
 */
const IntegrationToggleRow: React.FC<IntegrationToggleRowProps> = ({
  icon: Icon,
  title,
  description,
  checked,
  onChange,
}) => {
  return (
    <label className='flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left'>
      <span
        className={clsx(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          'bg-base-200 text-base-content/70',
        )}
      >
        <Icon className='h-5 w-5' />
      </span>
      <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <SettingLabel>{title}</SettingLabel>
        <span className='text-base-content/65 truncate text-[0.85em]'>{description}</span>
      </div>
      <input type='checkbox' className='toggle shrink-0' checked={checked} onChange={onChange} />
    </label>
  );
};

export default IntegrationsPanel;

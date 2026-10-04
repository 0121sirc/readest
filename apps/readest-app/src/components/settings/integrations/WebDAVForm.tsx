import clsx from 'clsx';
import React, { useState } from 'react';
import { MdVisibility, MdVisibilityOff } from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useTranslation, type TranslationFunc } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import {
  checkConnection,
  normalizeRootPath,
  WebDAVConnectResult,
} from '@/services/sync/providers/webdav/client';
import {
  buildWebDAVConnectSettings,
  isWebDAVEndpointChanged,
  type WebDAVConnectFormValues,
} from '@/services/sync/providers/webdav/connectSettings';
import { replaceLocalLibraryWithRemote } from '@/services/sync/file/runLibrarySync';
import Alert from '@/components/Alert';
import ModalPortal from '@/components/ModalPortal';
import { SectionTitle } from '../primitives';
import FileSyncForm from './FileSyncForm';
import WebDAVBrowsePane from './WebDAVBrowsePane';
import { persistCloudProviderEnabled } from './cloudSync';

/**
 * Translate a connection-probe failure into a user-facing string. Each branch is
 * a literal `_('...')` call so the i18next-scanner picks the keys up.
 */
const formatConnectError = (_: TranslationFunc, result: WebDAVConnectResult): string => {
  switch (result.code) {
    case 'SERVER_URL_REQUIRED':
      return _('Server URL is required');
    case 'AUTH_FAILED':
      return _('Authentication failed');
    case 'ROOT_NOT_FOUND':
      return _('Root directory not found');
    case 'UNEXPECTED_STATUS':
      return _('Unexpected server response (status {{status}})', { status: result.status ?? 0 });
    case 'NETWORK':
    default:
      return result.message ? `${_('Network error')}: ${result.message}` : _('Network error');
  }
};

/**
 * WebDAV provider panel, embedded in the Integrations WebDAV sub-page (which
 * owns the header). Two states:
 *
 * - **Active** (`webdav.enabled`): the shared {@link FileSyncForm} sync controls
 *   + the {@link WebDAVBrowsePane} + a Disconnect button.
 * - **Inactive**: the URL/credentials form (pre-filled from saved settings, so a
 *   previously-configured server reconnects in one click). Connecting turns
 *   WebDAV on; every other provider is left exactly as it was (#5062). A Connect
 *   that targets a *different* endpoint pauses on a confirmation first — the
 *   local library belongs to the endpoint being replaced, so the user picks
 *   between merging it into the new target and letting the new target take over.
 */
const WebDAVForm: React.FC = () => {
  const _ = useTranslation();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const { envConfig } = useEnv();

  const stored = settings.webdav;
  const isActive = !!stored?.enabled;

  const [url, setUrl] = useState(stored?.serverUrl || '');
  const [username, setUsername] = useState(stored?.username || '');
  const [password, setPassword] = useState(stored?.password || '');
  const [rootPath, setRootPath] = useState(stored?.rootPath || '/');
  const [isConnecting, setIsConnecting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Self-hosted servers routinely use a self-signed certificate; absent means
  // allowed, so the checkbox starts on.
  const [allowInsecureTls, setAllowInsecureTls] = useState(stored?.allowInsecureTls !== false);
  // A Connect that targets a NEW endpoint (different server, root or account)
  // pauses here until the user picks a side; `null` means no decision pending.
  const [pendingTarget, setPendingTarget] = useState<WebDAVConnectFormValues | null>(null);
  const [replaceOnConnect, setReplaceOnConnect] = useState(false);

  /** Persist the target, then either adopt it or merge with it. */
  const finishConnect = async (form: WebDAVConnectFormValues, replace: boolean) => {
    try {
      // Build the WebDAV connect settings (preserves deviceId / sub-toggles), then
      // switch WebDAV on. Every other provider is left untouched (#5062).
      // persistCloudProviderEnabled owns activation, persistence, and the
      // cross-window provider broadcast.
      await persistCloudProviderEnabled(envConfig, 'webdav', true, (s) => ({
        ...s,
        webdav: buildWebDAVConnectSettings(s.webdav, form),
      }));

      if (replace) {
        // The new endpoint owns this device now: purge the library, then pull
        // the new target and let its portable settings win. Runs inside the
        // sync mutex, so the debounced auto-sync cannot upload what we just
        // deleted to the endpoint we just adopted.
        await replaceLocalLibraryWithRemote(envConfig, _, 'webdav');
        eventDispatcher.dispatch('toast', {
          type: 'info',
          message: _('Connected. The local library was replaced by the server content.'),
        });
      } else {
        eventDispatcher.dispatch('toast', { type: 'info', message: _('Connected') });
      }
    } finally {
      setIsConnecting(false);
    }
  };

  const handleConnect = async () => {
    // The submit button is disabled while connecting, but an implicit submit
    // (Enter in a field) is not, and the endpoint decision below keeps
    // `isConnecting` true — neither may start a second probe.
    if (isConnecting || !url || !username) return;
    setIsConnecting(true);
    const normalizedRoot = normalizeRootPath(rootPath);
    const result = await checkConnection(
      { serverUrl: url, username, password, insecureTls: allowInsecureTls },
      normalizedRoot,
    );
    if (!result.success) {
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: `${_('Failed to connect')}: ${formatConnectError(_, result)}`,
      });
      setIsConnecting(false);
      return;
    }

    const target: WebDAVConnectFormValues = {
      serverUrl: url,
      username,
      password,
      rootPath: normalizedRoot,
      allowInsecureTls,
    };

    // A different endpoint means the library on this device belongs to the one
    // being replaced. Ask which side takes over before anything is written —
    // `isConnecting` stays true so the form cannot be resubmitted meanwhile.
    if (isWebDAVEndpointChanged(stored, target)) {
      setReplaceOnConnect(false);
      setPendingTarget(target);
      return;
    }

    await finishConnect(target, false);
  };

  const handleDisconnect = async () => {
    // Switch WebDAV off only — other providers keep syncing. Credentials stay
    // so a later reconnect is one click.
    await persistCloudProviderEnabled(envConfig, 'webdav', false);
    setShowPassword(false);
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Disconnected') });
  };

  const persistWebdav = async (patch: Partial<typeof stored>) => {
    const latest = useSettingsStore.getState().settings;
    const next = { ...latest, webdav: { ...latest.webdav, ...patch } };
    setSettings(next);
    await saveSettings(envConfig, next);
  };

  if (isActive) {
    return (
      <div className='space-y-5'>
        <FileSyncForm kind='webdav' stored={stored} persist={persistWebdav} />

        <WebDAVBrowsePane settings={stored} onUpdateSettings={persistWebdav} />

        <div className='flex justify-end'>
          <button
            type='button'
            onClick={handleDisconnect}
            className={clsx(
              'eink-bordered',
              'h-10 rounded-lg px-4 text-sm font-medium',
              'text-error hover:bg-error/10',
              'transition-colors duration-150',
              'focus-visible:ring-error/40 focus-visible:outline-hidden focus-visible:ring-2',
            )}
          >
            {_('Disconnect')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <form
        className='space-y-4'
        onSubmit={(e) => {
          e.preventDefault();
          handleConnect();
        }}
      >
        <div className='space-y-1.5'>
          <SectionTitle as='label' htmlFor='webdav-server-url' className='block'>
            {_('Server URL')}
          </SectionTitle>
          <input
            id='webdav-server-url'
            type='text'
            placeholder='https://dav.example.com'
            className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
            spellCheck='false'
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>

        <div className='space-y-1.5'>
          <SectionTitle as='label' htmlFor='webdav-username' className='block'>
            {_('Username')}
          </SectionTitle>
          <input
            id='webdav-username'
            type='text'
            placeholder={_('Your Username')}
            className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
            spellCheck='false'
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete='username'
          />
        </div>

        <div className='space-y-1.5'>
          <SectionTitle as='label' htmlFor='webdav-password' className='block'>
            {_('Password')}
          </SectionTitle>
          <div className='relative'>
            <input
              id='webdav-password'
              type={showPassword ? 'text' : 'password'}
              placeholder={_('Your Password')}
              className='input eink-bordered h-11 w-full pe-11 text-sm focus:outline-hidden'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete='current-password'
            />
            <button
              type='button'
              onClick={() => setShowPassword((v) => !v)}
              className={clsx(
                'absolute end-2 top-1/2 -translate-y-1/2',
                'flex h-8 w-8 items-center justify-center rounded-sm',
                'text-base-content/60 hover:text-base-content',
                'hover:bg-base-200/60 transition-colors duration-150',
                'focus-visible:ring-base-content/15 focus-visible:outline-hidden focus-visible:ring-2',
              )}
              aria-label={showPassword ? _('Hide password') : _('Show password')}
              title={showPassword ? _('Hide password') : _('Show password')}
              tabIndex={-1}
            >
              {showPassword ? (
                <MdVisibilityOff className='h-4 w-4' />
              ) : (
                <MdVisibility className='h-4 w-4' />
              )}
            </button>
          </div>
        </div>

        <div className='space-y-1.5'>
          <SectionTitle as='label' htmlFor='webdav-root' className='block'>
            {_('Root Directory')}
          </SectionTitle>
          <input
            id='webdav-root'
            type='text'
            placeholder='/'
            className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
            spellCheck='false'
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
          />
        </div>

        <label className='flex cursor-pointer items-center justify-between gap-3'>
          <span className='text-sm'>
            {_('Allow self-signed certificates')}
            <span className='text-base-content/60 block text-xs'>
              {_('Skip TLS verification when the server uses a self-signed certificate')}
            </span>
          </span>
          <input
            type='checkbox'
            className='toggle toggle-sm'
            checked={allowInsecureTls}
            onChange={(e) => setAllowInsecureTls(e.target.checked)}
            aria-label={_('Allow self-signed certificates')}
          />
        </label>

        <div className='flex justify-end pt-1'>
          <button
            type='submit'
            disabled={isConnecting || !url || !username}
            className={clsx(
              'btn btn-contrast',
              'h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
              'focus-visible:ring-base-content/40 focus-visible:outline-hidden focus-visible:ring-2',
              isConnecting && 'opacity-60',
            )}
          >
            {isConnecting ? <span className='loading loading-spinner loading-sm' /> : _('Connect')}
          </button>
        </div>
      </form>

      {pendingTarget && (
        <ModalPortal>
          <Alert
            title={_('WebDAV server changed')}
            message={_(
              'This device was syncing with a different server, root directory or account. Choose which side the library should follow.',
            )}
            confirmLabel={replaceOnConnect ? _('Connect and Replace') : _('Connect and Merge')}
            confirmButtonClassName={replaceOnConnect ? 'btn-error' : 'btn-warning'}
            onCancel={() => {
              // Declining the connection entirely: nothing is written, the form
              // stays editable with the values already typed in.
              setPendingTarget(null);
              setIsConnecting(false);
            }}
            onConfirm={() => {
              const target = pendingTarget;
              const replace = replaceOnConnect;
              setPendingTarget(null);
              void finishConnect(target, replace);
            }}
          >
            <label
              className={clsx(
                'eink-bordered flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors',
                replaceOnConnect
                  ? 'not-eink:border-error/40 not-eink:bg-error/10'
                  : 'not-eink:border-base-content/10 not-eink:bg-base-100/60',
              )}
            >
              <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
                <span
                  className={clsx('text-sm font-medium', replaceOnConnect && 'not-eink:text-error')}
                >
                  {_('Let the server replace the local library')}
                </span>
                <span className='text-neutral-content text-xs'>
                  {replaceOnConnect
                    ? _(
                        'Deletes every local book, reading progress and note, then downloads the content of the server. This cannot be undone.',
                      )
                    : _('Keeps the books on this device and merges them with the server.')}
                </span>
              </div>
              <input
                type='checkbox'
                className={clsx(
                  'toggle toggle-sm shrink-0',
                  replaceOnConnect && 'not-eink:toggle-error',
                )}
                checked={replaceOnConnect}
                onChange={(e) => setReplaceOnConnect(e.target.checked)}
                aria-label={_('Let the server replace the local library')}
              />
            </label>
          </Alert>
        </ModalPortal>
      )}
    </>
  );
};

export default WebDAVForm;

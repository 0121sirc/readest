import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SystemSettings } from '@/types/settings';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';

/**
 * Reconnecting WebDAV to a DIFFERENT server, root directory or account used to
 * be indistinguishable from a reconnect: the config was swapped silently and
 * the next auto-sync merged the previous endpoint's local library into the new
 * one. These tests pin the confirmation that now sits between a successful
 * probe and the write — including which side wins the library.
 *
 * Renders the real form so the wiring (probe -> dialog -> persist -> reset) is
 * what is asserted, not just the helpers behind it.
 */

type ConnectResult = { success: boolean; code?: string; status?: number; message?: string };

// `vi.mock` is hoisted above the module body, so the doubles the factories
// close over must be hoisted with them.
const { saveSettings, checkConnection, replaceLocalLibraryWithRemote } = vi.hoisted(() => ({
  saveSettings: vi.fn(async () => {}),
  checkConnection: vi.fn(
    async (_options: unknown, _root: string): Promise<ConnectResult> => ({ success: true }),
  ),
  replaceLocalLibraryWithRemote: vi.fn(async (_env: unknown, _t: unknown, _kind: string) => {}),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: { getAppService: async () => ({ saveSettings }) },
    appService: null,
  }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/utils/settingsSync', () => ({
  broadcastGlobalSettings: vi.fn(),
}));

// The active branch renders the browse pane, which reads the signed-in user;
// there is no AuthProvider in this tree.
vi.mock('@/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/context/AuthContext')>()),
  useAuth: () => ({ user: null, token: null }),
}));

// Only the probe is stubbed — the browse pane shares this module and would
// otherwise be handed a factory missing its exports.
vi.mock('@/services/sync/providers/webdav/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/sync/providers/webdav/client')>()),
  checkConnection,
}));

vi.mock('@/services/sync/file/runLibrarySync', () => ({
  replaceLocalLibraryWithRemote,
  syncBackendExtras: vi.fn(async () => {}),
}));

import WebDAVForm from '@/components/settings/integrations/WebDAVForm';

const savedAtEndpointA = {
  version: 1,
  webdav: {
    enabled: false,
    serverUrl: 'https://dav.example.com',
    username: 'alice',
    password: 'hunter2',
    rootPath: '/Readest',
    deviceId: 'device-uuid-1',
  },
} as unknown as SystemSettings;

const serverUrl = () => useSettingsStore.getState().settings.webdav.serverUrl;
const enabled = () => useSettingsStore.getState().settings.webdav.enabled;

const targetEndpointB = () =>
  fireEvent.change(screen.getByLabelText('Server URL'), {
    target: { value: 'https://other.example.com' },
  });

const submitConnect = () => fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

const toasts: string[] = [];
const toastListener = (event: CustomEvent) => {
  toasts.push(String((event.detail as { message?: string })?.message ?? ''));
};

beforeEach(() => {
  vi.clearAllMocks();
  checkConnection.mockResolvedValue({ success: true });
  toasts.length = 0;
  eventDispatcher.on('toast', toastListener);
  useSettingsStore.setState({ settings: savedAtEndpointA } as never);
});

afterEach(() => {
  eventDispatcher.off('toast', toastListener);
  cleanup();
});

describe('WebDAVForm endpoint change', () => {
  test('asks which side wins before writing a new endpoint', async () => {
    render(<WebDAVForm />);

    targetEndpointB();
    submitConnect();

    expect(await screen.findByRole('heading', { name: 'WebDAV server changed' })).toBeTruthy();
    // Nothing is persisted while the decision is pending — the stored endpoint
    // is still the one the local library belongs to.
    expect(serverUrl()).toBe('https://dav.example.com');
    expect(enabled()).toBe(false);
    expect(replaceLocalLibraryWithRemote).not.toHaveBeenCalled();
  });

  test('a failed probe fails the connection instead of opening the dialog', async () => {
    checkConnection.mockResolvedValue({ success: false, code: 'AUTH_FAILED' });
    render(<WebDAVForm />);

    targetEndpointB();
    submitConnect();

    await waitFor(() =>
      expect(toasts.some((message) => message.startsWith('Failed to connect'))).toBe(true),
    );
    expect(screen.queryByRole('heading', { name: 'WebDAV server changed' })).toBeNull();
    expect(serverUrl()).toBe('https://dav.example.com');
  });

  test('Confirm with the toggle off connects and keeps the local library', async () => {
    render(<WebDAVForm />);

    targetEndpointB();
    submitConnect();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect and Merge' }));

    await waitFor(() => expect(toasts).toContain('Connected'));
    expect(serverUrl()).toBe('https://other.example.com');
    expect(enabled()).toBe(true);
    // The sub-toggle bookkeeping survives a reconnect: still the same device.
    expect(useSettingsStore.getState().settings.webdav.deviceId).toBe('device-uuid-1');
    expect(replaceLocalLibraryWithRemote).not.toHaveBeenCalled();
  });

  test('Confirm with the toggle on adopts the new endpoint and purges locally', async () => {
    render(<WebDAVForm />);

    targetEndpointB();
    submitConnect();
    await screen.findByRole('button', { name: 'Connect and Merge' });
    fireEvent.click(screen.getByLabelText('Let the server replace the local library'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect and Replace' }));

    await waitFor(() => expect(replaceLocalLibraryWithRemote).toHaveBeenCalledTimes(1));
    expect(replaceLocalLibraryWithRemote.mock.calls[0]![2]).toBe('webdav');
    expect(serverUrl()).toBe('https://other.example.com');
    expect(enabled()).toBe(true);
    expect(toasts).toContain('Connected. The local library was replaced by the server content.');
  });

  test('Cancel aborts the connection and writes nothing', async () => {
    render(<WebDAVForm />);

    targetEndpointB();
    submitConnect();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'WebDAV server changed' })).toBeNull(),
    );
    expect(serverUrl()).toBe('https://dav.example.com');
    expect(enabled()).toBe(false);
    expect(replaceLocalLibraryWithRemote).not.toHaveBeenCalled();
    // The form stays editable with what the user typed.
    expect((screen.getByLabelText('Server URL') as HTMLInputElement).value).toBe(
      'https://other.example.com',
    );
  });

  test('reconnecting the SAME endpoint skips the dialog (password change)', async () => {
    render(<WebDAVForm />);

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'new-secret' } });
    submitConnect();

    await waitFor(() => expect(toasts).toContain('Connected'));
    expect(screen.queryByRole('heading', { name: 'WebDAV server changed' })).toBeNull();
    expect(serverUrl()).toBe('https://dav.example.com');
    expect(enabled()).toBe(true);
    expect(useSettingsStore.getState().settings.webdav.password).toBe('new-secret');
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __setWebSourceLabelForTests,
  broadcastGlobalSettings,
  type SettingsSyncPayload,
  subscribeSettingsSync,
} from '@/utils/settingsSync';
import type { SystemSettings } from '@/types/settings';

// The web build keeps multiple tabs' global settings in sync over a
// BroadcastChannel (Tauri uses window events). The channel must reach other
// tabs and never echo back to the sender.

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  name: string;
  private listeners = new Set<(event: MessageEvent) => void>();

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    for (const channel of FakeBroadcastChannel.instances) {
      if (channel === this || channel.name !== this.name) continue;
      for (const listener of channel.listeners) listener({ data } as MessageEvent);
    }
  }

  close(): void {
    FakeBroadcastChannel.instances = FakeBroadcastChannel.instances.filter((c) => c !== this);
  }

  static reset(): void {
    FakeBroadcastChannel.instances = [];
  }
}

const settings = {
  bookshelves: [{ id: 'shelf', name: 'Shelf', collapsed: false }],
  globalViewSettings: { fontSize: 18 },
  globalReadSettings: { clickToPaginate: true },
  webdav: { enabled: true, serverUrl: 'https://dav.example.com', username: 'alice' },
} as unknown as SystemSettings;

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('web settings broadcast', () => {
  test('delivers global settings to another tab and skips its own echo', async () => {
    const received: SettingsSyncPayload[] = [];
    __setWebSourceLabelForTests('receiver');
    const unlisten = await subscribeSettingsSync((payload) => received.push(payload));

    // Same module, act as the sender for the broadcast.
    __setWebSourceLabelForTests('sender');
    await broadcastGlobalSettings(settings, {
      includeCloudSyncProviders: true,
      connectionChanged: ['webdav'],
    });

    expect(received).toHaveLength(1);
    const payload = received[0]!;
    expect(payload.sourceLabel).toBe('sender');
    expect(payload.globalViewSettings).toEqual({ fontSize: 18 });
    expect(payload.globalReadSettings).toEqual({ clickToPaginate: true });
    expect(payload.cloudSyncProviders?.webdav.enabled).toBe(true);
    // Credentials never ride the broadcast; the receiver reloads from disk.
    expect(payload.connectionChanged).toEqual(['webdav']);
    expect(JSON.stringify(payload)).not.toContain('alice');

    unlisten();
  });

  test('a tab ignores the message it sent itself', async () => {
    const received: SettingsSyncPayload[] = [];
    __setWebSourceLabelForTests('only-tab');
    const unlisten = await subscribeSettingsSync((payload) => received.push(payload));
    await broadcastGlobalSettings(settings);
    expect(received).toHaveLength(0);
    unlisten();
  });
});

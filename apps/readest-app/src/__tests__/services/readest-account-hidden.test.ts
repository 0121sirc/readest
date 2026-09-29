import { afterEach, describe, expect, it } from 'vitest';
import { isCloudSyncAllowed, isCustomizationAllowed, isReadestAccountHidden } from '@/utils/access';
import { isReadestCloudEnabled } from '@/services/sync/cloudSyncProvider';
import type { SystemSettings } from '@/types/settings';

/**
 * Local-first mode (`isReadestAccountHidden`): hide the Readest account / cloud
 * surface, force the official cloud off in the sync graph, and unlock the
 * third-party file backends so they work without a plan or a sign-in.
 */

const clearOverrides = () => {
  delete process.env['NEXT_PUBLIC_DISABLE_READEST_ACCOUNT'];
  delete (globalThis as { __READEST_RUNTIME_CONFIG?: unknown }).__READEST_RUNTIME_CONFIG;
  delete (window as unknown as { __READEST_RUNTIME_CONFIG?: unknown }).__READEST_RUNTIME_CONFIG;
};

afterEach(clearOverrides);

describe('isReadestAccountHidden', () => {
  it('is off under the unit-test runner by default', () => {
    expect(isReadestAccountHidden()).toBe(false);
  });

  it('is on when the build flag is set', () => {
    process.env['NEXT_PUBLIC_DISABLE_READEST_ACCOUNT'] = 'true';
    expect(isReadestAccountHidden()).toBe(true);
  });

  it('prefers the runtime config over the build flag', () => {
    process.env['NEXT_PUBLIC_DISABLE_READEST_ACCOUNT'] = 'true';
    (window as unknown as { __READEST_RUNTIME_CONFIG?: { disableReadestAccount?: boolean } })[
      '__READEST_RUNTIME_CONFIG'
    ] = { disableReadestAccount: false };
    expect(isReadestAccountHidden()).toBe(false);
  });
});

describe('local-first gates', () => {
  it('forces Readest Cloud off and unlocks third-party sync / premium', () => {
    process.env['NEXT_PUBLIC_DISABLE_READEST_ACCOUNT'] = 'true';

    expect(isReadestCloudEnabled({} as SystemSettings)).toBe(false);
    // A signed-out `free` user can still run WebDAV/S3 sync.
    expect(isCloudSyncAllowed('free', false)).toBe(true);
    expect(isCustomizationAllowed('free', false)).toBe(true);
  });

  it('leaves the upstream behaviour untouched when off', () => {
    expect(isReadestCloudEnabled({} as SystemSettings)).toBe(true);
    expect(isCloudSyncAllowed('free', false)).toBe(false);
  });
});

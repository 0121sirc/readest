import { afterEach, describe, expect, test, vi } from 'vitest';
import { withWebLock } from '@/utils/webLock';

// Web Locks give cross-tab mutual exclusion; the util must degrade to running
// the task directly where the API is absent (older browsers / webviews).

const setLocks = (locks: unknown): void => {
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
};

afterEach(() => {
  setLocks(undefined);
  vi.restoreAllMocks();
});

describe('withWebLock', () => {
  test('runs the task directly when Web Locks is unavailable', async () => {
    setLocks(undefined);
    let ran = false;
    const result = await withWebLock('x', async () => {
      ran = true;
      return 1;
    });
    expect(ran).toBe(true);
    expect(result).toBe(1);
  });

  test('runs the task when the lock is acquired', async () => {
    setLocks({
      request: async (name: string, _opts: unknown, cb: (lock: unknown) => unknown) => cb({ name }),
    });
    const ran: number[] = [];
    const result = await withWebLock(
      'x',
      async () => {
        ran.push(1);
        return 2;
      },
      { ifAvailable: true },
    );
    expect(result).toBe(2);
    expect(ran).toHaveLength(1);
  });

  test('skips the task when ifAvailable and the lock is already held', async () => {
    setLocks({
      request: async (_name: string, _opts: unknown, cb: (lock: null) => unknown) => cb(null),
    });
    let ran = false;
    const result = await withWebLock(
      'x',
      async () => {
        ran = true;
        return 3;
      },
      { ifAvailable: true },
    );
    expect(result).toBeUndefined();
    expect(ran).toBe(false);
  });
});

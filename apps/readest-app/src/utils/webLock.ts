/**
 * Cross-tab / cross-window mutex over the Web Locks API.
 *
 * Every browser tab of the same origin shares one lock namespace, so a
 * file-sync pass that takes `readest:file-sync` can't run concurrently with the
 * same pass in another tab — the two would otherwise race on the same remote
 * `library.json` and re-upload the same books. Where `navigator.locks` is
 * unavailable (older browsers, some webviews) the task just runs, matching the
 * pre-existing single-tab behaviour.
 *
 * `ifAvailable` skips the task (resolving `undefined`) instead of waiting when
 * another context already holds the lock — used by background auto-sync so a
 * second tab doesn't queue a duplicate pass behind the first.
 */
export const withWebLock = async <T>(
  name: string,
  task: () => Promise<T>,
  opts: { ifAvailable?: boolean } = {},
): Promise<T | undefined> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return task();

  if (opts.ifAvailable) {
    return locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return undefined;
      return task();
    });
  }
  return locks.request(name, task);
};

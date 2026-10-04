import { WebDAVSettings } from '@/types/settings';
import { normalizeRootPath } from './client';

export interface WebDAVConnectFormValues {
  serverUrl: string;
  username: string;
  password: string;
  /** Already passed through `normalizeRootPath` by the caller. */
  rootPath: string;
  /** Whether to accept the server's self-signed / invalid TLS certificate. */
  allowInsecureTls?: boolean;
}

/**
 * Build the updated `webdav` block for a successful Connect submit.
 *
 * The form's Connect handler only owns the four credential/path fields the
 * user just typed. Everything else — `deviceId`, `syncBooks`, `strategy`,
 * `syncProgress`, `syncNotes`, `lastSyncedAt` — was earned by prior use
 * and MUST be preserved across a disconnect/reconnect cycle.
 *
 * Spreading `previous` first lets the form fields shadow the captured
 * credentials while every bookkeeping field rides through untouched.
 *
 * Deliberately does NOT touch `enabled`: activation belongs to
 * `withCloudProviderEnabled`, which the connect flow applies on top. If the
 * builder pre-set `enabled`, activation would never see the
 * disabled -> enabled transition and its side effects (the syncBooks
 * auto-flip, the providerSelectedAt stamp) would silently skip the most
 * common path.
 *
 * Pulled out as a pure helper specifically to unit-test the "reconnect
 * preserves prior state" invariant: the inline version in WebDAVForm
 * regressed in PR #4204 by replacing the whole webdav block, which
 * silently rotated the deviceId.
 */
export const buildWebDAVConnectSettings = (
  previous: Partial<WebDAVSettings> | undefined,
  form: WebDAVConnectFormValues,
): WebDAVSettings => {
  return {
    ...(previous ?? {}),
    serverUrl: form.serverUrl.trim(),
    username: form.username,
    password: form.password,
    rootPath: form.rootPath,
    // Only written when the form supplied it; otherwise prior state (or the
    // absent-means-allow default in the transport) stands.
    ...(form.allowInsecureTls !== undefined ? { allowInsecureTls: form.allowInsecureTls } : {}),
  } as WebDAVSettings;
};

/**
 * Does this Connect submit point the backend somewhere NEW — a different
 * server, root directory or account?
 *
 * Password-only edits are not a new target: the same remote keeps syncing and
 * the connect flow must stay a one-click reconnect. A real endpoint change is
 * different enough that the local library belongs to the old target, which is
 * why the connect flow asks whether to merge or let the new target replace it.
 *
 * `rootPath` is compared normalised on both sides: the connect handler already
 * normalises what the user typed, but the *saved* value may predate that (or
 * arrive as `''` / a trailing slash through a settings restore), and none of
 * those describe a different directory.
 */
export const isWebDAVEndpointChanged = (
  previous: Partial<WebDAVSettings> | undefined,
  form: Pick<WebDAVConnectFormValues, 'serverUrl' | 'rootPath' | 'username'>,
): boolean => {
  // Nothing saved yet: a first-time connect cannot be "changed".
  if (!previous?.serverUrl) return false;

  return (
    previous.serverUrl.trim() !== form.serverUrl.trim() ||
    normalizeRootPath(previous.rootPath ?? '') !== normalizeRootPath(form.rootPath) ||
    previous.username !== form.username
  );
};

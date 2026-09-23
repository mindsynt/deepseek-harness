/**
 * Path canonicalization for workspace identity.
 * @module @deepseek-ai/dsh-workspace/src/paths
 */

import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/**
 * Identity of the built-in local host: a workspace whose directory lives on
 * the Harness host machine. A record that omits `hostId` reads as this value,
 * so media written before the field existed keeps opening.
 */
export const LOCAL_HOST_ID = 'local'

/**
 * Resolve a caller-supplied workspace host identity to its stored spelling.
 * @param hostId - Caller-supplied identity; `undefined` and `''` both name
 * {@link LOCAL_HOST_ID}.
 * @returns the stored identity, never empty.
 */
export function resolveWorkspaceHostId(hostId: string | undefined): string {
  return hostId === undefined || hostId === '' ? LOCAL_HOST_ID : hostId
}

/**
 * Check whether a path names one fixed Host location without process cwd or
 * current-drive resolution.
 * @param path - Candidate Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns Whether the path is fully qualified on that platform.
 */
export function fullyQualifiedWorkspacePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/**
 * Derive a non-empty default title from a canonical Workspace path.
 * @param path - Canonical Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns The final segment when present, otherwise the complete root spelling.
 */
export function defaultWorkspaceTitle(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.basename(path) || pathApi.parse(path).root
}

/**
 * Canonicalize a fully qualified directory path via `fs.realpath`: trailing
 * slashes, `..` segments, and symlinks are all resolved. This is the
 * uniqueness canon of a workspace whose host is {@link LOCAL_HOST_ID} —
 * workspace paths are stored canonicalized, uniqueness is string equality of
 * canonicalized paths (a symlink to an existing workspace's directory
 * collides), and attach-time session `cwd` checks go through the same canon.
 * Relative paths reject before `realpath` can resolve them from the Host cwd
 * or current Windows drive. A path that does not exist rejects with the
 * original `ENOENT` — this is `create`'s reject path (a workspace must point
 * at an existing directory).
 * @param path - The path to canonicalize.
 * @returns the canonical absolute path.
 */
export async function realpathNormalize(path: string): Promise<string> {
  if (!fullyQualifiedWorkspacePath(path)) {
    throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
  }
  return await realpath(path)
}

/**
 * Canonicalize a path a non-local host interprets, by string alone: the
 * caller's absolutely rooted POSIX spelling with trailing slashes removed.
 * Remote paths belong to that host's execution world, so this function runs no
 * `fs.realpath` and no `stat`: `..`, `.`, interior repeated slashes, and
 * symlinks stay unresolved, and the path need not exist on the Harness host.
 * Two spellings the remote world would treat as one directory therefore remain
 * two workspaces until a host's filesystem can canonicalize them. Relative
 * paths reject, because they would resolve against the Harness process cwd
 * instead of the host's.
 * @param path - The path to canonicalize.
 * @returns the canonical spelling; a slash-only root keeps its single slash.
 */
export function remotePathNormalize(path: string): string {
  if (!posix.isAbsolute(path)) {
    throw new TypeError(`Remote workspace path is not fully qualified: '${path}'`)
  }
  const withoutTrailingSlashes = path.replace(/\/+$/, '')
  return withoutTrailingSlashes === '' ? '/' : withoutTrailingSlashes
}

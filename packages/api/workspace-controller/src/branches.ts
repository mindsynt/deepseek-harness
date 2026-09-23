/** Checked-out git branch facts for Workspace directories, addressed by host. */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FileSystem, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { RemoteHostId } from '@deepseek-ai/dsh-ssh-host-registry'
import { LOCAL_HOST_ID } from '@deepseek-ai/dsh-workspace'

/** Commits shown for a detached HEAD, matching the abbreviated form git prints. */
const SHORT_COMMIT_LENGTH = 8

/** The `.git` entry of a working tree and the `HEAD` file inside its git directory. */
const DOT_GIT = '.git'
const HEAD_FILE = 'HEAD'

/**
 * Resolve one backend path, treating every filesystem fault as absent.
 * @param fs - backend addressing the Workspace's execution world.
 * @param path - absolute path, or one relative to `cwd`.
 * @param cwd - base a relative `path` resolves against.
 * @returns the resolved target, or undefined when the backend cannot resolve it.
 */
async function resolveIn(fs: FileSystem, path: string, cwd: string): Promise<FsTarget | undefined> {
  try {
    return await fs.resolve(path, { cwd })
  } catch (_error: unknown) {
    // A Workspace need not be a checkout, and unusable metadata only means no branch to show.
    return undefined
  }
}

/**
 * Inspect one backend path, treating every filesystem fault as absent.
 * @param fs - backend addressing the Workspace's execution world.
 * @param path - absolute path, or one relative to `cwd`.
 * @param cwd - base a relative `path` resolves against.
 * @returns the target and its metadata, or undefined when the path cannot be inspected.
 */
async function inspect(
  fs: FileSystem,
  path: string,
  cwd: string,
): Promise<{ readonly target: FsTarget; readonly info: FsInfo } | undefined> {
  const target = await resolveIn(fs, path, cwd)
  if (target === undefined) return undefined
  try {
    const info = await fs.stat(target)
    return info === undefined ? undefined : { target, info }
  } catch (_error: unknown) {
    // A Workspace need not be a checkout, and unusable metadata only means no branch to show.
    return undefined
  }
}

/**
 * Read one file as UTF-8 text, treating every filesystem fault as absent.
 * @param fs - backend addressing the Workspace's execution world.
 * @param target - resolved file target.
 * @returns the file's text, or undefined when it cannot be read.
 */
async function readText(fs: FileSystem, target: FsTarget): Promise<string | undefined> {
  try {
    return await fs.readText(target)
  } catch (_error: unknown) {
    // Unreadable metadata names no branch; the Workspace list that carries the label still renders.
    return undefined
  }
}

/** Extract the git directory a `gitdir:` pointer file names. */
function gitDirectoryOf(pointer: string): string | undefined {
  return /^gitdir:[ \t]*(\S.*?)[ \t]*$/mu.exec(pointer)?.[1]
}

/**
 * Resolve the git directory backing one working tree.
 *
 * `.git` is a directory for an ordinary checkout and a `gitdir:` pointer file
 * for a worktree or submodule, whose git directory lives elsewhere. Both
 * spellings resolve through the addressed backend, so a remote World's path
 * syntax is never mixed with the Harness host's.
 *
 * @param fs - backend addressing the Workspace's execution world.
 * @param root - Workspace directory.
 * @returns the git directory target, or undefined when the directory is not a checkout.
 */
async function gitDirectory(fs: FileSystem, root: string): Promise<FsTarget | undefined> {
  const dotGit = await inspect(fs, DOT_GIT, root)
  if (dotGit === undefined) return undefined
  if (dotGit.info.type === 'directory') return dotGit.target
  if (dotGit.info.type !== 'file') return undefined
  const pointer = await readText(fs, dotGit.target)
  if (pointer === undefined) return undefined
  const directory = gitDirectoryOf(pointer)
  return directory === undefined ? undefined : resolveIn(fs, directory, root)
}

/**
 * Resolve the directory whose `HEAD` carries one Workspace's checked-out branch.
 *
 * An ordinary checkout keeps `HEAD` in `.git`; a worktree or submodule points at
 * its git directory from a `gitdir:` file.
 *
 * @param fs - backend addressing the Workspace's execution world.
 * @param root - Workspace directory.
 * @returns the directory holding `HEAD`, named in `fs`'s execution world, or
 *   undefined when the path is not a checkout.
 */
export async function gitHeadWatch(fs: FileSystem, root: string): Promise<string | undefined> {
  const directory = await gitDirectory(fs, root)
  return directory === undefined ? undefined : fs.processPath(directory)
}

/**
 * Read the checked-out git branch of one Workspace directory.
 *
 * Returns the branch under `refs/heads`, or the abbreviated commit when HEAD is
 * detached. A path that is not a git checkout, or whose metadata cannot be read
 * in the addressed world, yields undefined: the branch is a display label, so no
 * filesystem fault here may fail the Workspace list that carries it.
 *
 * @param fs - backend addressing the Workspace's execution world.
 * @param root - canonical Workspace directory.
 * @returns branch name, abbreviated detached commit, or undefined.
 */
export async function readWorkspaceBranch(fs: FileSystem, root: string): Promise<string | undefined> {
  const directory = await gitDirectory(fs, root)
  if (directory === undefined) return undefined
  const file = await resolveIn(fs, HEAD_FILE, fs.processPath(directory))
  if (file === undefined) return undefined
  const head = (await readText(fs, file))?.trim()
  if (head === undefined) return undefined
  const branch = /^ref: refs\/heads\/(.+)$/u.exec(head)
  if (branch?.[1] !== undefined) return branch[1]
  return /^[0-9a-f]{40}$/u.test(head) ? head.slice(0, SHORT_COMMIT_LENGTH) : undefined
}

/**
 * Report whether a Workspace host identity names this Harness host's own
 * execution world.
 * @param hostId - Workspace host identity; omitted names the built-in local host.
 * @returns whether the identity addresses this Harness host.
 */
export function isLocalHost(hostId: string | undefined): hostId is undefined | typeof LOCAL_HOST_ID {
  return hostId === undefined || hostId === LOCAL_HOST_ID
}

/**
 * Resolve the execution world one Workspace path is read in. This is the single
 * place a host identity becomes a filesystem: an omitted or built-in local
 * identity is this Harness host's own backend, any other identity is that remote
 * host's open execution world.
 *
 * A world this Host cannot reach — no local filesystem composed, or the named
 * host has no open execution world — yields undefined and never the Harness
 * host's backend: a branch is a display label, and reading the wrong machine's
 * checkout would name a branch the Workspace does not have.
 *
 * @param ctx - Host context carrying `ctx.fs` and the remote host registry.
 * @param hostId - Workspace host identity.
 * @returns the addressed backend, or undefined when this Host cannot reach it.
 */
export function fileSystemFor(ctx: Context, hostId: string | undefined): FileSystem | undefined {
  if (isLocalHost(hostId)) return ctx.get('fs')
  return ctx.get('remoteHosts')?.get(brandString<RemoteHostId>(hostId))?.world.fs
}

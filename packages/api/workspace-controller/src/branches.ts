/** Checked-out git branch facts for Workspace directories. */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/** Commits shown for a detached HEAD, matching the abbreviated form git prints. */
const SHORT_COMMIT_LENGTH = 8

/**
 * Report whether one path is a directory, treating every filesystem fault as "not one".
 * @param path - candidate path.
 * @returns true only when the path exists and is a directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (_error: unknown) {
    // A Workspace need not be a checkout, and unusable metadata only means no branch to show.
    return false
  }
}

/**
 * Read one file as UTF-8 text, treating every filesystem fault as absent.
 * @param path - file to read.
 * @returns the file's text, or undefined when it cannot be read.
 */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (_error: unknown) {
    // Unreadable metadata names no branch; the Workspace list that carries the label still renders.
    return undefined
  }
}

/**
 * Locate the `HEAD` file backing one working tree.
 *
 * `.git` is a directory for an ordinary checkout and a `gitdir:` pointer file
 * for a worktree or submodule, whose git directory lives elsewhere.
 *
 * @param root - Workspace directory.
 * @returns absolute `HEAD` path, or undefined when the directory is not a checkout.
 */
async function gitHeadFile(root: string): Promise<string | undefined> {
  const dotGit = join(root, '.git')
  if (await isDirectory(dotGit)) return join(dotGit, 'HEAD')
  const pointer = await readText(dotGit)
  if (pointer === undefined) return undefined
  const directory = resolveGitDirectory(root, pointer)
  return directory === undefined ? undefined : join(directory, 'HEAD')
}

/** Resolve a `gitdir:` pointer to the git directory it names. */
function resolveGitDirectory(root: string, pointer: string): string | undefined {
  const directory = /^gitdir:[ \t]*(\S.*?)[ \t]*$/mu.exec(pointer)?.[1]
  if (directory === undefined) return undefined
  return isAbsolute(directory) ? directory : resolve(root, directory)
}

/**
 * Resolve the directory whose `HEAD` carries one Workspace's checked-out branch.
 *
 * An ordinary checkout keeps `HEAD` in `.git`; a worktree or submodule points at
 * its git directory from a `gitdir:` file.
 *
 * @param root - Workspace directory.
 * @returns the directory holding `HEAD`, or undefined when the path is not a checkout.
 */
export async function gitHeadWatch(root: string): Promise<string | undefined> {
  const dotGit = join(root, '.git')
  if (await isDirectory(dotGit)) return dotGit
  const pointer = await readText(dotGit)
  if (pointer === undefined) return undefined
  return resolveGitDirectory(root, pointer)
}

/**
 * Read the checked-out git branch of one Workspace directory.
 *
 * Returns the branch under `refs/heads`, or the abbreviated commit when HEAD is
 * detached. A path that is not a git checkout, or whose metadata cannot be
 * read, yields undefined: the branch is a display label, so no filesystem fault
 * here may fail the Workspace list that carries it.
 *
 * @param root - canonical Workspace directory.
 * @returns branch name, abbreviated detached commit, or undefined.
 */
export async function readWorkspaceBranch(root: string): Promise<string | undefined> {
  const file = await gitHeadFile(root)
  if (file === undefined) return undefined
  const head = (await readText(file))?.trim()
  if (head === undefined) return undefined
  const branch = /^ref: refs\/heads\/(.+)$/u.exec(head)
  if (branch?.[1] !== undefined) return branch[1]
  return /^[0-9a-f]{40}$/u.test(head) ? head.slice(0, SHORT_COMMIT_LENGTH) : undefined
}

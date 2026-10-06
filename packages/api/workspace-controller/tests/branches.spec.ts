/** Workspace branch labels: the checkout shapes one Workspace path can present. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkspaceBranch } from '../src/branches.ts'

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Create one temporary directory registered for teardown. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-branch-'))
  roots.push(dir)
  return dir
}

/** Write one file, creating missing parents. */
function file(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

describe('readWorkspaceBranch', () => {
  it('reads the branch a checked-out HEAD names, including nested names', async () => {
    const root = tempDir()
    file(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/nested-name\n')
    expect(await readWorkspaceBranch(root)).toBe('feature/nested-name')
  })

  it('reports a detached HEAD as its abbreviated commit', async () => {
    const root = tempDir()
    file(join(root, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n')
    expect(await readWorkspaceBranch(root)).toBe('01234567')
  })

  it('follows the gitdir pointer a worktree or submodule writes', async () => {
    const parent = tempDir()
    const gitDir = join(parent, 'metadata', 'worktrees', 'linked')
    file(join(gitDir, 'HEAD'), 'ref: refs/heads/linked\n')
    const root = join(parent, 'tree')
    mkdirSync(root, { recursive: true })
    file(join(root, '.git'), `gitdir: ${gitDir}\n`)
    expect(await readWorkspaceBranch(root)).toBe('linked')
  })

  it('resolves a relative gitdir pointer against the workspace directory', async () => {
    const parent = tempDir()
    file(join(parent, 'metadata', 'HEAD'), 'ref: refs/heads/relative\n')
    const root = join(parent, 'tree')
    mkdirSync(root, { recursive: true })
    file(join(root, '.git'), 'gitdir: ../metadata\n')
    expect(await readWorkspaceBranch(root)).toBe('relative')
  })

  it('yields nothing for a directory that is not a checkout', async () => {
    const root = tempDir()
    file(join(root, 'package.json'), '{}\n')
    expect(await readWorkspaceBranch(root)).toBeUndefined()
  })

  it('yields nothing when checkout metadata cannot name a branch', async () => {
    const root = tempDir()
    file(join(root, '.git', 'HEAD'), 'ref: refs/stash\n')
    expect(await readWorkspaceBranch(root)).toBeUndefined()
  })

  it('yields nothing when the pointer file is not a gitdir reference', async () => {
    const root = tempDir()
    file(join(root, '.git'), 'submodule of something else\n')
    expect(await readWorkspaceBranch(root)).toBeUndefined()
  })

  it('yields nothing when the named git directory has no HEAD', async () => {
    const root = tempDir()
    file(join(root, '.git'), 'gitdir: /nonexistent/git/dir\n')
    expect(await readWorkspaceBranch(root)).toBeUndefined()
  })
})

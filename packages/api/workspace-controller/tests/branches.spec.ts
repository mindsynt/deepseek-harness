/** Workspace branch labels: the checkout shapes one Workspace path can present. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { gitHeadWatch, readWorkspaceBranch } from '../src/branches.ts'
import { scriptedWorld } from './scripted-world.ts'

const roots: string[] = []
const contexts: Context[] = []
const realms: Fiber[] = []

afterEach(async () => {
  await Promise.all(realms.splice(0).map(fiber => fiber.dispose()))
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
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

/** The Harness host's own backend, composed as `ctx.fs` in a context of its own. */
async function localWorld(): Promise<FileSystem> {
  const context = new Context()
  contexts.push(context)
  await context.plugin(LocalFileSystem)
  const fs = context.get('fs')
  if (fs === undefined) throw new Error('fixture did not compose a local filesystem')
  return fs
}

describe('readWorkspaceBranch', () => {
  let fs: FileSystem

  beforeEach(async () => {
    fs = await localWorld()
  })

  it('reads the branch a checked-out HEAD names, including nested names', async () => {
    const root = tempDir()
    file(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/nested-name\n')
    expect(await readWorkspaceBranch(fs, root)).toBe('feature/nested-name')
  })

  it('reports a detached HEAD as its abbreviated commit', async () => {
    const root = tempDir()
    file(join(root, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n')
    expect(await readWorkspaceBranch(fs, root)).toBe('01234567')
  })

  it('follows the gitdir pointer a worktree or submodule writes', async () => {
    const parent = tempDir()
    const gitDir = join(parent, 'metadata', 'worktrees', 'linked')
    file(join(gitDir, 'HEAD'), 'ref: refs/heads/linked\n')
    const root = join(parent, 'tree')
    mkdirSync(root, { recursive: true })
    file(join(root, '.git'), `gitdir: ${gitDir}\n`)
    expect(await readWorkspaceBranch(fs, root)).toBe('linked')
  })

  it('resolves a relative gitdir pointer against the workspace directory', async () => {
    const parent = tempDir()
    file(join(parent, 'metadata', 'HEAD'), 'ref: refs/heads/relative\n')
    const root = join(parent, 'tree')
    mkdirSync(root, { recursive: true })
    file(join(root, '.git'), 'gitdir: ../metadata\n')
    expect(await readWorkspaceBranch(fs, root)).toBe('relative')
  })

  it('yields nothing for a directory that is not a checkout', async () => {
    const root = tempDir()
    file(join(root, 'package.json'), '{}\n')
    expect(await readWorkspaceBranch(fs, root)).toBeUndefined()
  })

  it('yields nothing when checkout metadata cannot name a branch', async () => {
    const root = tempDir()
    file(join(root, '.git', 'HEAD'), 'ref: refs/stash\n')
    expect(await readWorkspaceBranch(fs, root)).toBeUndefined()
  })

  it('yields nothing when the pointer file is not a gitdir reference', async () => {
    const root = tempDir()
    file(join(root, '.git'), 'submodule of something else\n')
    expect(await readWorkspaceBranch(fs, root)).toBeUndefined()
  })

  it('yields nothing when the named git directory has no HEAD', async () => {
    const root = tempDir()
    file(join(root, '.git'), 'gitdir: /nonexistent/git/dir\n')
    expect(await readWorkspaceBranch(fs, root)).toBeUndefined()
  })
})

describe('readWorkspaceBranch — another execution world', () => {
  it('reads a checkout through the world the path is addressed in', async () => {
    const root = tempDir()
    file(join(root, '.git', 'HEAD'), 'ref: refs/heads/remote\n')
    const context = new Context()
    contexts.push(context)
    const realm = context.isolate('fs', Symbol('branch remote world'))
    realms.push(await realm.plugin(LocalFileSystem, { cwd: root }))
    expect(await readWorkspaceBranch(realm.fs, root)).toBe('remote')
  })

  it('reads HEAD from the addressed world alone, never from a same-spelled host path', async () => {
    const world = scriptedWorld({ files: { '/srv/app/.git/HEAD': 'ref: refs/heads/remote-only\n' } })
    expect(await readWorkspaceBranch(world, '/srv/app')).toBe('remote-only')
  })

  it('resolves a relative gitdir pointer inside the addressed world', async () => {
    const world = scriptedWorld({
      files: { '/srv/app/.git': 'gitdir: ../meta\n', '/srv/meta/HEAD': 'ref: refs/heads/pointer\n' },
    })
    expect(await readWorkspaceBranch(world, '/srv/app')).toBe('pointer')
  })
})

describe('readWorkspaceBranch — metadata the addressed world withholds', () => {
  it('yields nothing when the world cannot resolve the path', async () => {
    const world = scriptedWorld({ faults: { resolve: () => true } })
    expect(await readWorkspaceBranch(world, '/srv/app')).toBeUndefined()
  })

  it('yields nothing when the world cannot stat the path', async () => {
    const world = scriptedWorld({
      files: { '/srv/app/.git/HEAD': 'ref: refs/heads/main\n' },
      faults: { stat: () => true },
    })
    expect(await readWorkspaceBranch(world, '/srv/app')).toBeUndefined()
  })

  it('yields nothing when .git is neither a directory nor a file', async () => {
    const world = scriptedWorld({ special: ['/srv/app/.git'] })
    expect(await readWorkspaceBranch(world, '/srv/app')).toBeUndefined()
  })

  it('yields nothing when the pointer file cannot be read', async () => {
    const world = scriptedWorld({
      files: { '/srv/app/.git': 'gitdir: ../meta\n' },
      faults: { readText: path => path.endsWith('/.git') },
    })
    expect(await readWorkspaceBranch(world, '/srv/app')).toBeUndefined()
  })

  it('yields nothing when HEAD cannot be read', async () => {
    const world = scriptedWorld({
      files: { '/srv/app/.git/HEAD': 'ref: refs/heads/main\n' },
      faults: { readText: path => path.endsWith('/HEAD') },
    })
    expect(await readWorkspaceBranch(world, '/srv/app')).toBeUndefined()
  })

  it('yields nothing when the named git directory cannot be resolved', async () => {
    const world = scriptedWorld({
      files: { '/srv/app/.git': 'gitdir: ../meta\n' },
      faults: { resolve: path => path.startsWith('/srv/meta') },
    })
    expect(await readWorkspaceBranch(world, '/srv/app')).toBeUndefined()
  })

  it('yields nothing when HEAD cannot be resolved inside the git directory', async () => {
    const world = scriptedWorld({
      directories: ['/srv/app/.git'],
      faults: { resolve: path => path.endsWith('/HEAD') },
    })
    expect(await readWorkspaceBranch(world, '/srv/app')).toBeUndefined()
  })
})

describe('gitHeadWatch', () => {
  it('names the git directory the addressed world holds HEAD in', async () => {
    const root = tempDir()
    file(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const fs = await localWorld()
    expect(await gitHeadWatch(fs, root)).toBe(join(root, '.git'))
  })

  it('names the git directory a pointer file selects', async () => {
    const parent = tempDir()
    file(join(parent, 'metadata', 'HEAD'), 'ref: refs/heads/linked\n')
    const root = join(parent, 'tree')
    mkdirSync(root, { recursive: true })
    file(join(root, '.git'), 'gitdir: ../metadata\n')
    const fs = await localWorld()
    expect(await gitHeadWatch(fs, root)).toBe(join(parent, 'metadata'))
  })

  it('yields nothing for a directory that is not a checkout', async () => {
    const root = tempDir()
    file(join(root, 'package.json'), '{}\n')
    const fs = await localWorld()
    expect(await gitHeadWatch(fs, root)).toBeUndefined()
  })
})

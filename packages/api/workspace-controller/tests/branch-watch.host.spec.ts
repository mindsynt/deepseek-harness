/** Live branch observation: a settled HEAD write publishes the branch it names. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LOCAL_HOST_ID } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { WorkspaceBranchWatch } from '../src/branch-watch.ts'
import type { WorkspaceBranchTarget } from '../src/branch-watch.ts'
import type { WorkspaceBranchView } from '../src/types.ts'

/** Settled-write window the cases below run under. */
const DEBOUNCE_MS = 20
/** Upper bound for one filesystem event to arrive and settle. */
const SETTLE_TIMEOUT_MS = 15_000
/** Per-case bound: a loaded machine may deliver a watched event well after it happened. */
const CASE_TIMEOUT_MS = 30_000
/** Filesystem-event polling interval while a case waits. */
const WAIT_INTERVAL_MS = 10

const roots: string[] = []
const watches: WorkspaceBranchWatch[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(watches.splice(0).map(watch => watch.dispose()))
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Create one temporary directory registered for teardown. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-branch-watch-'))
  roots.push(dir)
  return dir
}

/** Write one checkout HEAD (creating `.git`). */
function head(root: string, content: string): void {
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), content)
}

/**
 * Wait for a filesystem event to settle, bounded so a missed event fails the
 * case with the fact it waited for instead of hanging the suite.
 * @param check - condition that becomes true once the event arrived.
 * @param what - description used in the timeout diagnostic.
 */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, WAIT_INTERVAL_MS))
  }
  throw new Error(`timed out after ${String(SETTLE_TIMEOUT_MS)}ms waiting for ${what}`)
}

/** One watcher and the changes it published. */
async function bench(
  options: { readonly fileSystem?: boolean } = {},
): Promise<{ readonly changes: WorkspaceBranchView[]; readonly watch: WorkspaceBranchWatch }> {
  const ctx = new Context()
  contexts.push(ctx)
  if (options.fileSystem !== false) await ctx.plugin(LocalFileSystem, { cwd: tmpdir() })
  const changes: WorkspaceBranchView[] = []
  const watch = new WorkspaceBranchWatch(ctx, DEBOUNCE_MS, (change) => { changes.push(change) })
  watches.push(watch)
  return { changes, watch }
}

const WID = 'watch-w1' as WorkspaceId

/** One target on the Harness host itself. */
function onHost(path: string): WorkspaceBranchTarget {
  return { workspaceId: WID, hostId: LOCAL_HOST_ID, path }
}

describe('WorkspaceBranchWatch', () => {
  it('publishes the branch behind a settled HEAD write', async () => {
    const root = tempDir()
    head(root, 'ref: refs/heads/main\n')
    const { changes, watch } = await bench()
    await watch.sync([onHost(root)])
    // Installing a watcher publishes what the checkout currently names.
    expect(changes).toEqual([{ workspaceId: WID, branch: 'main' }])

    head(root, 'ref: refs/heads/feature/nested\n')
    await waitFor(() => changes.length === 2, 'the branch change')
    expect(changes.at(-1)).toEqual({ workspaceId: WID, branch: 'feature/nested' })
  }, CASE_TIMEOUT_MS)

  it('stays silent when a settled write names the branch already held', async () => {
    const root = tempDir()
    head(root, 'ref: refs/heads/main\n')
    const { changes, watch } = await bench()
    await watch.sync([onHost(root)])

    // Different bytes that still name the same branch: the event fires, the label does not move.
    head(root, 'ref: refs/heads/main \n')
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 10))
    expect(changes).toEqual([{ workspaceId: WID, branch: 'main' }])
  }, CASE_TIMEOUT_MS)

  it('publishes a Workspace that stopped being a checkout', async () => {
    const root = tempDir()
    head(root, 'ref: refs/heads/dev\n')
    const { changes, watch } = await bench()
    await watch.sync([onHost(root)])

    rmSync(join(root, '.git'), { recursive: true, force: true })
    await waitFor(() => changes.length === 2, 'the checkout removal')
    expect(changes.at(-1)).toEqual({ workspaceId: WID })
  }, CASE_TIMEOUT_MS)

  it('observes a checkout created on a registered path since the last sync', async () => {
    const root = tempDir()
    const { changes, watch } = await bench()
    const targets = [onHost(root)]
    await watch.sync(targets)
    expect(changes).toEqual([])

    head(root, 'ref: refs/heads/late\n')
    await watch.sync(targets)
    expect(changes).toEqual([{ workspaceId: WID, branch: 'late' }])
  }, CASE_TIMEOUT_MS)

  it('follows a checkout whose git directory moved', async () => {
    const root = tempDir()
    const first = join(root, 'meta-one')
    const second = join(root, 'meta-two')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    writeFileSync(join(first, 'HEAD'), 'ref: refs/heads/one\n')
    writeFileSync(join(second, 'HEAD'), 'ref: refs/heads/two\n')
    writeFileSync(join(root, '.git'), `gitdir: ${first}\n`)
    const { changes, watch } = await bench()
    const targets = [onHost(root)]
    await watch.sync(targets)
    expect(changes).toEqual([{ workspaceId: WID, branch: 'one' }])

    // A worktree whose pointer is rewritten is observed at its new git directory.
    writeFileSync(join(root, '.git'), `gitdir: ${second}\n`)
    await watch.sync(targets)
    expect(changes).toEqual([
      { workspaceId: WID, branch: 'one' },
      { workspaceId: WID, branch: 'two' },
    ])
  }, CASE_TIMEOUT_MS)

  it('re-resolves an unchanged Workspace set without publishing', async () => {
    const root = tempDir()
    head(root, 'ref: refs/heads/main\n')
    const { changes, watch } = await bench()
    const targets = [onHost(root)]
    await watch.sync(targets)
    await watch.sync(targets)
    await watch.sync(targets)
    expect(changes).toEqual([{ workspaceId: WID, branch: 'main' }])
  }, CASE_TIMEOUT_MS)

  it('drops observation when a Workspace set no longer names the path', async () => {
    const root = tempDir()
    head(root, 'ref: refs/heads/main\n')
    const { changes, watch } = await bench()
    await watch.sync([onHost(root)])
    await watch.sync([])

    head(root, 'ref: refs/heads/ignored\n')
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 10))
    expect(changes).toEqual([{ workspaceId: WID, branch: 'main' }])
  }, CASE_TIMEOUT_MS)

  it('stops publishing once disposed', async () => {
    const root = tempDir()
    head(root, 'ref: refs/heads/main\n')
    const { changes, watch } = await bench()
    await watch.sync([onHost(root)])
    await watch.dispose()

    head(root, 'ref: refs/heads/after\n')
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 10))
    expect(changes).toEqual([{ workspaceId: WID, branch: 'main' }])
    // A sync after disposal installs nothing.
    await watch.sync([onHost(root)])
    expect(changes).toEqual([{ workspaceId: WID, branch: 'main' }])
  }, CASE_TIMEOUT_MS)

  it('does not watch a checkout another host owns', async () => {
    const root = tempDir()
    head(root, 'ref: refs/heads/main\n')
    const { changes, watch } = await bench()

    // The same spelling on the Harness host: a watch installed here would fire
    // for it, so silence proves the remote target was not watched at all.
    await watch.sync([{ workspaceId: WID, hostId: 'alpha', path: root }])
    expect(changes).toEqual([])
    head(root, 'ref: refs/heads/ignored\n')
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 10))
    expect(changes).toEqual([])
  }, CASE_TIMEOUT_MS)

  it('watches nothing when no filesystem is composed on this Host', async () => {
    const root = tempDir()
    head(root, 'ref: refs/heads/main\n')
    const { changes, watch } = await bench({ fileSystem: false })

    await watch.sync([onHost(root)])
    expect(changes).toEqual([])
    head(root, 'ref: refs/heads/ignored\n')
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 10))
    expect(changes).toEqual([])
  }, CASE_TIMEOUT_MS)
})

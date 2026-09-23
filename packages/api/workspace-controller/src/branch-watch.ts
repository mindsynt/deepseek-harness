/** Live git-branch observation for registered Workspace directories. */

import { watch, type FSWatcher } from 'chokidar'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { fileSystemFor, gitHeadWatch, isLocalHost, readWorkspaceBranch } from './branches.ts'
import type { WorkspaceBranchView } from './types.ts'

/** Milliseconds a HEAD write settles before the branch is read, and the watcher poll interval. */
const MAX_SETTLE_POLL_MS = 10

/** One registered Workspace whose checkout is observed. */
export interface WorkspaceBranchTarget {
  readonly workspaceId: WorkspaceId
  /** Identity of the host whose filesystem interprets {@link path}. */
  readonly hostId: string
  /** Canonical Workspace directory. */
  readonly path: string
}

/**
 * Watch the checkout of every registered Workspace and report branch changes.
 *
 * `git checkout` replaces `HEAD` outside any DSH operation, so no DSH event
 * carries it. One watcher per Workspace follows the directory holding `HEAD` —
 * the git directory itself, or the Workspace root while `.git` is absent, so a
 * checkout created later is observed too — and a settled write there re-reads
 * the branch.
 *
 * Only Workspaces on this Harness host are watched. A remote checkout lives in
 * another execution world, where a directory watch rooted here would observe the
 * Harness host's own path instead and never fire; those Workspaces keep their
 * on-demand read.
 */
export class WorkspaceBranchWatch {
  private readonly watchers = new Map<WorkspaceId, { readonly directory: string; readonly watcher: FSWatcher }>()
  /** Last branch observed per Workspace, including "no checkout" as undefined. */
  private readonly observed = new Map<WorkspaceId, string | undefined>()
  private targets: readonly WorkspaceBranchTarget[] = []
  private syncing: Promise<void> = Promise.resolve()
  private closed = false

  /**
   * @param ctx - Host context carrying the Harness host's own filesystem.
   * @param debounceMs - settled-write window before a HEAD change is read.
   * @param publish - destination for a changed branch.
   */
  constructor(
    private readonly ctx: Context,
    private readonly debounceMs: number,
    private readonly publish: (change: WorkspaceBranchView) => void,
  ) {}

  /**
   * Reconcile watchers with the current registered Workspace set.
   *
   * A Workspace whose watched directory did not move keeps its watcher, so a
   * repeated call only re-resolves the paths.
   * @param targets - current registered Workspaces.
   * @returns after watchers match the set.
   */
  sync(targets: readonly WorkspaceBranchTarget[]): Promise<void> {
    if (this.closed) return Promise.resolve()
    // Serialize reconciliation: watcher creation is asynchronous, and an
    // overlapping call must not install a second watcher for one Workspace.
    this.syncing = this.syncing.then(() => this.reconcile(targets))
    return this.syncing
  }

  /**
   * Stop observing every Workspace.
   * @returns after every watcher closed.
   */
  async dispose(): Promise<void> {
    this.closed = true
    await this.syncing
    const closing = [...this.watchers.values()].map(entry => entry.watcher.close())
    this.watchers.clear()
    this.observed.clear()
    await Promise.all(closing)
  }

  private async reconcile(targets: readonly WorkspaceBranchTarget[]): Promise<void> {
    if (this.closed) return
    this.targets = targets
    const wanted = new Set(targets.map(target => target.workspaceId))
    for (const workspaceId of [...this.watchers.keys()]) {
      if (!wanted.has(workspaceId)) await this.withdraw(workspaceId)
    }
    for (const workspaceId of [...this.observed.keys()]) {
      if (!wanted.has(workspaceId)) this.observed.delete(workspaceId)
    }
    for (const target of targets) await this.observe(target.workspaceId)
  }

  /** Resolve one Workspace and install its watcher where it is missing or moved. */
  private async observe(workspaceId: WorkspaceId): Promise<void> {
    const target = this.targets.find(candidate => candidate.workspaceId === workspaceId)
    /* v8 ignore next 2 -- an event already queued when its Workspace left the registry has no path to resolve. */
    if (target === undefined) return
    // Only this Host's own checkouts are watched: a chokidar watch rooted at a
    // remote Workspace path would follow a directory of that spelling here and
    // never fire for the writes happening on the other host.
    const fs = isLocalHost(target.hostId) ? fileSystemFor(this.ctx, target.hostId) : undefined
    if (fs === undefined) {
      await this.withdraw(workspaceId)
      return
    }
    const directory = await gitHeadWatch(fs, target.path)
    /* v8 ignore next -- the plugin can dispose while the workspace path resolves. */
    if (this.closed) return
    const installed = this.watchers.get(workspaceId)
    if (directory === undefined) {
      // A path that is not a checkout has no branch to keep live; its next
      // reconciliation observes one created since.
      await this.withdraw(workspaceId)
      return
    }
    if (installed?.directory === directory) return
    if (installed !== undefined) await this.withdraw(workspaceId)
    const watcher = watch(directory, {
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.debounceMs,
        pollInterval: Math.max(1, Math.min(this.debounceMs, MAX_SETTLE_POLL_MS)),
      },
    })
    this.watchers.set(workspaceId, { directory, watcher })
    watcher.on('all', () => { void this.settled(workspaceId, fs) })
    // An install publishes what it observes; a client that already holds the
    // same label drops the repeat.
    await this.readBranch(workspaceId, fs)
  }

  private async withdraw(workspaceId: WorkspaceId): Promise<void> {
    const installed = this.watchers.get(workspaceId)
    if (installed === undefined) return
    this.watchers.delete(workspaceId)
    await installed.watcher.close()
  }

  private async settled(workspaceId: WorkspaceId, fs: FileSystem): Promise<void> {
    await this.observe(workspaceId)
    await this.readBranch(workspaceId, fs)
  }

  private async readBranch(workspaceId: WorkspaceId, fs: FileSystem): Promise<void> {
    const target = this.targets.find(candidate => candidate.workspaceId === workspaceId)
    /* v8 ignore next 2 -- an event already queued when its Workspace left the registry has no path to read. */
    if (target === undefined) return
    const branch = await readWorkspaceBranch(fs, target.path)
    if (this.observed.get(workspaceId) === branch) return
    this.observed.set(workspaceId, branch)
    this.publish(branch === undefined ? { workspaceId } : { workspaceId, branch })
  }
}

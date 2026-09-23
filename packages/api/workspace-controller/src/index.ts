/** Host Workspace Remote owner: explicit commands and reconnect-safe state. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceBranchWatch } from './branch-watch.ts'
import { fileSystemFor, readWorkspaceBranch } from './branches.ts'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { WorkspaceFeed } from './feed.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceBranchesValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceValue,
} from './types.ts'

export type * from './types.ts'
export { DirectoryPickerController } from './directory-picker.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Workspace business API and Remote namespace owner. */
    workspaceController: WorkspaceController
  }
}

/** Settled-write window, in milliseconds, before a replaced `HEAD` is read. */
export interface Config {
  /** Milliseconds a `HEAD` write settles before the branch behind it is read and published. */
  branchWatchDebounceMs: number
}

/** Host service backing the generated `ctx.remote.workspace` namespace. */
export class WorkspaceController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry']
  static Config: z<Config> = z.object({
    branchWatchDebounceMs: z.number().step(1).min(0).default(200),
  })

  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed
  private readonly branchWatch: WorkspaceBranchWatch

  /**
   * @param ctx - Host context containing the Workspace registry.
   * @param config - validated settled-write window for branch observation.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    this.commands = new WorkspaceCommands(ctx)
    this.feed = new WorkspaceFeed(ctx)
    // A checkout replaces HEAD outside every DSH operation, so the branch is
    // observed on disk and pushed; the unary verb below seeds a cold client.
    this.branchWatch = new WorkspaceBranchWatch(ctx, config.branchWatchDebounceMs, (change) => {
      ctx.emit('workspace/branch-changed', change)
    })
    const observe = (): void => {
      void this.branchWatch.sync(ctx.workspaceRegistry.list().map(workspace => ({
        workspaceId: workspace.id,
        hostId: workspace.hostId,
        path: workspace.path,
      })))
    }
    observe()
    ctx.on('domain/changed', observe)
    ctx.effect(() => async () => { await this.branchWatch.dispose() }, 'workspace-controller.branch-watch')
    // This package is the Loader entry for both Remote owners it hosts: the
    // directory-picking seam is abstract and never an entry itself. The child
    // stays pending until a picking backend is composed, so a host without one
    // registers no picking namespace instead of answering an unservable verb.
    ctx.plugin(DirectoryPickerController)
  }

  /**
   * Create or idempotently resolve one Workspace over an existing directory.
   * @param request - directory path to register and the host that interprets it.
   * @returns the Workspace and whether this call created it.
   */
  @Remote('create')
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Rename one Workspace to a unique non-blank title.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  @Remote('rename')
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    return this.commands.rename(request)
  }

  /**
   * Remove one Workspace registration while retaining files and Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  @Remote('delete')
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.commands.delete(request)
  }

  /**
   * Move one Workspace within the registry display order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  @Remote('insertBefore')
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    return this.commands.insertBefore(request)
  }

  /**
   * Move one accounted Session within a Workspace.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  @Remote('insertSessionBefore')
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    return this.commands.insertSessionBefore(request)
  }

  /**
   * Hide one known Session from Workspace grouping surfaces.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  @Remote('archiveSession')
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.archiveSession(request)
  }

  /**
   * Restore one archived Session to Workspace grouping surfaces.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  @Remote('unarchiveSession')
  unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.unarchiveSession(request)
  }

  /**
   * Read the checked-out git branch of every registered Workspace, each in the
   * execution world its host identity addresses.
   *
   * A branch is external checkout state that no Workspace mutation announces,
   * so it stays out of the durable projection and is read on demand instead.
   * A Workspace whose world this Host cannot reach contributes no label: the
   * branch is decorative, and reading the Harness host's own filesystem instead
   * would name a branch the Workspace does not have.
   * @returns one entry per registered Workspace, each omitting `branch` when its path is not a checkout.
   */
  @Remote('branches')
  async branches(): Promise<WorkspaceBranchesValue> {
    const items = await Promise.all(this.ctx.workspaceRegistry.list().map(async (workspace) => {
      const fs = fileSystemFor(this.ctx, workspace.hostId)
      const branch = fs === undefined ? undefined : await readWorkspaceBranch(fs, workspace.path)
      return branch === undefined
        ? { workspaceId: workspace.id }
        : { workspaceId: workspace.id, branch }
    }))
    return { items }
  }

  /**
   * Stream a complete Workspace baseline followed by ordered increments.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    return this.feed.follow(signal)
  }
}

export default WorkspaceController

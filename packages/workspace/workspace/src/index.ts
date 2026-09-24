/**
 * Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
 * stable registry order, and header-validated session membership over the
 * domain data form.
 * @module @deepseek-ai/dsh-workspace
 */

import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceEntity } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'

export { WorkspaceMoveInvalidError } from './entity.ts'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath, LOCAL_HOST_ID, realpathNormalize, remotePathNormalize, resolveWorkspaceHostId } from './paths.ts'
import { workspaceDomainSpec } from './spec.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
import type { SessionActivity, Workspace, WorkspaceId as WorkspaceIdBrand } from './types.ts'

export type {
  SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap, Workspace,
} from './types.ts'
export { workspaceDomainState, workspaceRecord, workspaceDomainSpec } from './spec.ts'
export type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
export { LOCAL_HOST_ID, realpathNormalize } from './paths.ts'

/** Identifies one workspace record (see `src/types.ts` for the brand rationale). */
export type WorkspaceId = WorkspaceIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - Raw workspace id string.
 * @returns the same string, branded at compile time.
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

/**
 * An archiveSession or pinSession request named a session neither live nor in
 * session persistence — a definite miss only; storage faults propagate as
 * themselves.
 */
export class WorkspaceUnknownSessionError extends Error {
  /**
   * @param sessionId - The unknown session id.
   * @param verb - The registry operation that named the session.
   */
  constructor(readonly sessionId: SessionId, verb: 'archive' | 'pin') {
    super(`cannot ${verb} session '${sessionId}': live sessions and session persistence hold no such session`)
    this.name = 'WorkspaceUnknownSessionError'
  }
}

/**
 * An archiveSession request named a session that at least one
 * `workspace/session-activity` listener reported active. Nothing was written;
 * `activity` names what must stop before the session can be archived.
 */
export class WorkspaceActiveSessionError extends Error {
  /**
   * @param sessionId - The active session id.
   * @param activity - The reported activity, in listener order.
   */
  constructor(readonly sessionId: SessionId, readonly activity: readonly SessionActivity[]) {
    super(`cannot archive session '${sessionId}': the session is active (${activity.map(entry => entry.kind).join(', ')})`)
    this.name = 'WorkspaceActiveSessionError'
  }
}

/** A pinSession request named a session currently in the archive set; pinning and archival are mutually exclusive. */
export class WorkspaceArchivedSessionPinError extends Error {
  /**
   * @param sessionId - The archived session id.
   */
  constructor(readonly sessionId: SessionId) {
    super(`cannot pin session '${sessionId}': the session is archived`)
    this.name = 'WorkspaceArchivedSessionPinError'
  }
}

/** A workspace reorder named a source or anchor absent from the durable registry order. */
export class WorkspaceOrderInvalidError extends Error {
  /**
   * @param workspaceId - Missing source or anchor id.
   */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.name = 'WorkspaceOrderInvalidError'
  }
}


/** The session an archive request is about to write into the archive set. */
export interface SessionActivityRequest {
  readonly sessionId: SessionId
}

/** Caller choices for {@link WorkspaceRegistry.archiveSession}. */
export interface ArchiveSessionOptions {
  /**
   * Ask the composed providers to stop the session's running work instead of
   * refusing the archive because of it. The archive is written first, then
   * the stops are requested; running work is never awaited to settlement, and
   * a provider failure is logged without undoing the archive.
   */
  readonly stopActivity?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
  }

  interface Events {
    /**
     * Ask the composed providers what still runs for a session before it is
     * archived. A listener prepends its own {@link SessionActivity} entries to
     * the result of `next()`; the registry's innermost callback returns an
     * empty list, so a composition without providers archives freely. Any
     * non-empty result refuses the archive without a write.
     * @param request - the session about to be archived.
     * @param next - delegate to the remaining providers.
     * @mode waterfall
     */
    'workspace/session-activity'(
      request: SessionActivityRequest,
      next: () => Promise<readonly SessionActivity[]>,
    ): Promise<readonly SessionActivity[]>
    /**
     * Stop a session's running work because the caller archived it with
     * `stopActivity`; the archive set is durable when this dispatches. Each
     * provider stops its own families — cancelling a turn, its subagent
     * descendants, owned jobs, or active schedules — through the same cancel
     * paths the user's own stop actions use, so the session log ends every
     * open turn regularly and a later unarchive can continue the
     * conversation. Listeners issue their stop requests without waiting for
     * running work to settle; a listener may await its own durability
     * barrier. A rejection is logged by the registry and does not undo the
     * archive.
     * @param request - the session being archived.
     * @mode parallel
     */
    'workspace/session-stop'(request: SessionActivityRequest): Promise<void> | void
  }
}

interface BootstrapGroup {
  readonly path: string
  readonly headers: SessionHeader[]
  readonly newestAt: number
}

/**
 * Canonical-path observations for one session header. A workspace reads the
 * slot its own host interprets; both canons can exist for one cwd because a
 * path may exist on the Harness host and also name a directory on a remote one.
 */
interface SessionPathFacts {
  /** `fs.realpath` canon when the cwd names an existing Harness-host directory. */
  local?: string
  /** String canon a non-local host interprets; present for an absolutely rooted cwd. */
  remote?: string
  /** Why the cwd produced no local canon; reported by the filtered-candidate warning. */
  invalidReason?: string
}

const sameIds = (left: readonly WorkspaceId[], right: readonly WorkspaceId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

/** Uniqueness key of one workspace: the host identity plus that host's canonical path. */
const hostPathKey = (hostId: string, path: string): string => JSON.stringify([hostId, path])

const compareHeaders = (left: SessionHeader, right: SessionHeader): number =>
  right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id))

/**
 * Durable workspace registry. Startup waits for `sessionPersistence`, builds
 * one header index carrying each session's local and non-local path canons,
 * and completes the one-time history bootstrap before the service becomes
 * active. The persistence dependency is mandatory so an unavailable peer can
 * never be mistaken for an empty history and commit the initialized marker.
 */
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private global?: DomainGlobal<WorkspaceDomainState>
  private state?: WorkspaceDomainState
  private readonly entities = new Map<WorkspaceId, WorkspaceEntity>()
  private readonly headers = new Map<SessionId, SessionHeader>()
  private readonly sessionPathFacts = new Map<SessionId, SessionPathFacts>()
  private operationTail: Promise<void> = Promise.resolve()

  private readonly host: WorkspaceEntityHost = {
    table: () => this.requireTable(),
    sessionPath: (id, hostId) => this.sessionPath(id, hostId),
    readSessionHeader: id => this.readSessionHeader(id),
    rememberSessionPath: (id, hostId, path) => {
      const facts = this.sessionPathFacts.get(id) ?? {}
      if (hostId === LOCAL_HOST_ID) {
        facts.local = path
        delete facts.invalidReason
      } else {
        facts.remote = path
      }
      this.sessionPathFacts.set(id, facts)
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /** Open the domain, finish bootstrap when required, and rebuild the ordered cache. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()

    await this.recoverPendingMutation()
    this.validateStoredState(this.state)
    if (!this.state.initialized) {
      const headers = await this.listStoredHeaders()
      await this.replaceHeaderIndex(headers)
      await this.bootstrap(headers)
    } else if (this.table.size > 0) {
      await this.replaceHeaderIndex(await this.listStoredHeaders())
    }

    await this.indexLiveSessions()
    this.validateStoredState(this.requireState())
    this.rebuildEntities()
    this.reportFilteredCandidates()
  }

  /**
   * Create or reuse a workspace for a directory on one host. On the built-in
   * local host the fully qualified path is canonicalized through `fs.realpath`
   * and must name an existing directory, so a relative, nonexistent, or
   * non-directory path rejects. On any other host the path is canonicalized by
   * string alone (absolutely rooted POSIX spelling, trailing slashes removed)
   * and no Harness-host filesystem access happens, because that host's
   * execution world owns the directory. Repeated calls for the same
   * `(hostId, canonical path)` pair return the existing entity without
   * changing its title; the same canonical path on two hosts is two
   * workspaces. A newly created workspace is prepended to the durable registry
   * order. Different canonical paths may share a display title. The registry
   * does not verify that a non-local `hostId` names a registered host.
   * @param path - Directory to own, in a fully qualified path spelling.
   * @param title - Display title used only when a new record is created.
   * @param hostId - Identity of the host that interprets `path`; omitted or
   * empty names the built-in local host.
   * @returns the existing or newly durable workspace.
   */
  // TODO: `title` lost its last production caller when the gateway's
  // create-by-name branch was deleted
  // (.agents/notes/archived/simplification/2026-07-31-one-route-to-add-a-workspace.md);
  // drop the parameter with its @param clause and the `create(path, title?)`
  // lines in this package's README pair.
  async create(path: string, title?: string, hostId?: string): Promise<Workspace> {
    const host = resolveWorkspaceHostId(hostId)
    const canonical = await this.canonicalizeForCreate(path, host)
    return await this.enqueueOperation(() => this.createCanonical(host, canonical, title))
  }

  /**
   * Initialize the default Workspace only while both the registry and Session
   * history are empty. Repeated requests reuse its durable identity; deleting
   * that registration permanently disables automatic creation.
   * @param resolveDirectory - resolve the absolute directory; called only for
   * eligible creation, inside the registry mutation queue. Missing directories
   * are created recursively before registration, and the initial title is the
   * requested directory's own final segment — not the canonical one, so a
   * symlink at that path does not retitle the Workspace after its target.
   * After resolution, caller cancellation does not roll back creation or registration.
   * @returns the initialized Workspace, or undefined when automatic creation is ineligible.
   */
  initializeDefault(resolveDirectory: () => Promise<string>): Promise<Workspace | undefined> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (state.defaultWorkspaceId !== undefined) return this.entities.get(state.defaultWorkspaceId)
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined) throw new Error('default Workspace initialization requires the Session store')
      if (state.workspaceIds.length > 0 || state.archivedSessionIds.length > 0
        || sessions.list().length > 0 || (await this.listStoredHeaders()).length > 0) return undefined

      const path = await resolveDirectory()
      if (!fullyQualifiedWorkspacePath(path)) throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
      await mkdir(path, { recursive: true })
      const canonical = await realpathNormalize(path)
      // A Session can start outside the registry queue while directory preparation awaits I/O.
      if ((await this.listStoredHeaders()).length > 0 || sessions.list().length > 0) return undefined
      return this.createCanonical(LOCAL_HOST_ID, canonical, undefined, true)
    })
  }

  /**
   * Look up a workspace by id.
   * @param id - Workspace id.
   * @returns the workspace, or `undefined` when unknown.
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id)
  }

  /**
   * Synchronous workspace projection in durable registry order. Every
   * entity's `sessionIds` getter is already filtered by the startup/live
   * canonical-cwd header index; this method performs no persistence reads.
   * @returns a fresh ordered array of workspace entities.
   */
  list(): Workspace[] {
    return this.requireState().workspaceIds.map((id) => {
      const entity = this.entities.get(id)
      if (entity === undefined) {
        throw new Error(`workspace registry order references missing workspace '${id}'`)
      }
      return entity
    })
  }

  /**
   * Delete one workspace registration while retaining its directory and every
   * session log. The durable order is updated before the table deletion; a
   * failed table write restores the prior order and keeps the entity
   * published. Unknown ids are an idempotent no-op for domain callers.
   * @param id - Workspace registration to remove.
   * @returns `true` when a record was deleted, `false` when it was unknown.
   */
  delete(id: WorkspaceId): Promise<boolean> {
    return this.enqueueOperation(() => this.deleteKnown(id))
  }

  /**
   * Move one workspace within the durable display order, DOM-insertBefore-like.
   * With an anchor it lands before that workspace; without one it appends.
   * @param id - Workspace to move.
   * @param beforeId - Workspace anchor; omitted appends.
   * @returns the complete committed workspace order.
   */
  insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id)
      if (beforeId !== undefined && !state.workspaceIds.includes(beforeId)) {
        throw new WorkspaceOrderInvalidError(beforeId)
      }
      if (beforeId === id) return state.workspaceIds
      const without = state.workspaceIds.filter(workspaceId => workspaceId !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      const workspaceIds = [...without.slice(0, at), id, ...without.slice(at)]
      if (sameIds(workspaceIds, state.workspaceIds)) return state.workspaceIds
      await this.setState({ ...state, workspaceIds })
      return workspaceIds
    })
  }

  /**
   * The registry-global archive set: sessions hidden from every grouping
   * surface. Archiving never touches workspace accounting — an archived
   * session keeps its `sessionIds` slot so unarchiving restores its position.
   * @returns the archived session ids in archive order.
   */
  get archivedSessionIds(): readonly SessionId[] {
    return this.requireState().archivedSessionIds
  }

  /**
   * Archive one session durably. The session must exist (live or in session
   * persistence); its workspace accounting — or lack of one — is irrelevant.
   * Without `stopActivity` the session must also be inactive: the
   * `workspace/session-activity` waterfall is asked once, and any reported
   * activity rejects with {@link WorkspaceActiveSessionError} before anything
   * is written. With `stopActivity` the archive is written without an
   * activity check, and the `workspace/session-stop` providers are then asked
   * to stop the session's work: the durable archive set is what a provider's
   * `agent/pre-step` gate reads, so every wake the stops induce is already
   * blocked. Archiving drops the session's pin in the same durable write
   * (pinning and archival are mutually exclusive). An already archived id
   * resolves without writing, asking, or stopping.
   * @param sessionId - The session to archive.
   * @param options - Whether running work is stopped instead of refusing.
   * @returns resolution after durability and, with `stopActivity`, after every stop request was issued.
   */
  archiveSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another archive.
      if (this.requireState().archivedSessionIds.includes(sessionId)) return
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'archive')
      }
      if (options.stopActivity !== true) {
        const activity = await this.ctx.waterfall(
          'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
        )
        if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        archivedSessionIds: [...state.archivedSessionIds, sessionId],
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
      if (options.stopActivity === true) await this.stopSessionActivity(sessionId)
    })
  }

  /**
   * Unarchive one session durably by dropping it from the registry-global
   * archive set; the accounting slot was never touched, so the session
   * returns to its recorded position. Unarchiving runs no session-existence
   * check because removing an id cannot introduce an unknown one, so an
   * entry whose session is gone still resolves. An id that is not archived
   * resolves without writing.
   * @param sessionId - The session to unarchive.
   * @returns resolution after durability.
   */
  unarchiveSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with a concurrent archive.
      const state = this.requireState()
      if (!state.archivedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * The registry-global pin set: sessions surfaced ahead of every unpinned
   * session on grouping surfaces. Pinning never touches workspace accounting.
   * @returns Session ids in pin order (most recently pinned first).
   */
  get pinnedSessionIds(): readonly SessionId[] {
    return this.requireState().pinnedSessionIds
  }

  /**
   * Pin one session durably, prepending it to the registry-global pin set.
   * The session must exist (live or in session persistence) and must not be
   * archived. An already pinned id resolves without writing or reordering.
   * @param sessionId - The session to pin.
   * @returns resolution after durability.
   */
  pinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another pin or archive.
      if (this.requireState().pinnedSessionIds.includes(sessionId)) return
      if (this.requireState().archivedSessionIds.includes(sessionId)) {
        throw new WorkspaceArchivedSessionPinError(sessionId)
      }
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'pin')
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        pinnedSessionIds: [sessionId, ...state.pinnedSessionIds],
      })
    })
  }

  /**
   * Unpin one session durably by dropping it from the registry-global pin
   * set. Unpinning runs no session-existence check because removing an id
   * cannot introduce an unknown one, so an entry whose session is gone still
   * resolves. An id that is not pinned resolves without writing.
   * @param sessionId - The session to unpin.
   * @returns resolution after durability.
   */
  unpinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with a concurrent pin.
      const state = this.requireState()
      if (!state.pinnedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * Whether a session is live, header-indexed, or present in a fresh
   * persistence listing. Only a definite miss returns false — a failing
   * `sessionPersistence.list()` propagates so storage faults never
   * masquerade as an unknown session.
   */
  private async sessionKnown(id: SessionId): Promise<boolean> {
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    if (this.headers.has(id)) return true
    await this.indexHeaders(await this.listStoredHeaders())
    return this.headers.has(id)
  }

  /** Request every provider's stop; a failing provider is logged, never a reason to keep the session visible. */
  private async stopSessionActivity(sessionId: SessionId): Promise<void> {
    try {
      await this.ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error: unknown) {
      // ctx.parallel settles every listener and rejects with one AggregateError.
      /* v8 ignore next -- the plain arm guards a rethrowing dispatcher. */
      const failures = error instanceof AggregateError ? error.errors : [error]
      for (const failure of failures) {
        this.ctx.logger.warn(`workspace: stopping session '${sessionId}' for archive failed: ${String(failure)}`)
      }
    }
  }

  /**
   * Resolve by canonical directory path on one host without creating or
   * mutating a workspace. On the built-in local host a missing path rejects
   * during `realpath`; a non-local host canonicalizes the path string alone,
   * so no Harness-host filesystem access happens. An existing unowned
   * directory — or, on a non-local host, any unowned canonical spelling —
   * returns `undefined`.
   * @param path - Directory path in a fully qualified spelling.
   * @param hostId - Identity of the host that interprets `path`; omitted or
   * empty means the built-in local host.
   * @returns the workspace owning the canonical path on that host, when one exists.
   */
  async resolveByPath(path: string, hostId?: string): Promise<Workspace | undefined> {
    const host = resolveWorkspaceHostId(hostId)
    const canonical = await this.canonicalizeForLookup(path, host)
    for (const entity of this.entities.values()) {
      if (entity.hostId === host && entity.path === canonical) return entity
    }
    return undefined
  }

  /**
   * Canonicalize a create request's path and require an existing directory,
   * because a local workspace must point at one. A non-local host's world owns
   * that check, so only the path string is canonicalized.
   */
  private async canonicalizeForCreate(path: string, hostId: string): Promise<string> {
    if (hostId !== LOCAL_HOST_ID) return remotePathNormalize(path)
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return canonical
  }

  /** Canonicalize a lookup path under one host without requiring the directory to exist. */
  private async canonicalizeForLookup(path: string, hostId: string): Promise<string> {
    return hostId === LOCAL_HOST_ID ? await realpathNormalize(path) : remotePathNormalize(path)
  }

  private async createCanonical(hostId: string, canonical: string, title?: string, firstUse = false): Promise<WorkspaceEntity> {
    for (const entity of this.entities.values()) {
      if (entity.hostId === hostId && entity.path === canonical) return entity
    }

    const workspaceName = title ?? defaultWorkspaceTitle(canonical)
    const table = this.requireTable()
    const state = this.requireState()
    const id = WorkspaceId(randomUUID())
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      hostId,
      path: canonical,
      title: workspaceName,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    const entity = new WorkspaceEntity(this.host, id, record)
    this.entities.set(id, entity)
    const pendingState: WorkspaceDomainState = {
      ...state,
      pendingMutation: { operation: 'create', workspaceId: id },
    }
    try {
      await this.setState(pendingState)
    } catch (error) {
      this.entities.delete(id)
      throw error
    }
    try {
      await table.put(id, record)
    } catch (error) {
      this.entities.delete(id)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record write and pending-marker rollback both failed`,
        )
      }
      throw error
    }

    try {
      await this.setState({
        ...state,
        pendingMutation: undefined,
        initialized: true,
        ...(firstUse ? { defaultWorkspaceId: id } : {}),
        workspaceIds: [id, ...state.workspaceIds],
      })
    } catch (error) {
      this.entities.delete(id)
      try {
        await table.delete(id)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and record rollback both failed; the pending marker remains recoverable`,
        )
      }
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and pending-marker rollback both failed`,
        )
      }
      throw error
    }
    return entity
  }

  private async deleteKnown(id: WorkspaceId): Promise<boolean> {
    const entity = this.entities.get(id)
    if (entity === undefined) return false
    const state = this.requireState()
    const nextState = {
      ...state,
      pendingMutation: undefined,
      initialized: true,
      workspaceIds: state.workspaceIds.filter(workspaceId => workspaceId !== id),
    }
    await this.setState({
      ...nextState,
      pendingMutation: { operation: 'delete', workspaceId: id },
    })
    this.entities.delete(id)
    try {
      await this.requireTable().delete(id)
    } catch (error) {
      this.entities.set(id, entity)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        // The durable marker still says to finish deletion, so the cache must
        // agree with that recoverable direction rather than republish a row
        // absent from the persisted order.
        this.entities.delete(id)
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record deletion and registry-order rollback both failed`,
        )
      }
      throw error
    }
    try {
      await this.setState(nextState)
    } catch (error) {
      // The deletion committed at the table write and was already published
      // to Host streams. Keep the durable marker for startup recovery rather
      // than reporting failure after the requested state became true.
      this.ctx.logger.warn(
        `workspace '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`,
      )
    }
    return true
  }

  /**
   * Complete the one mutation explicitly named by durable state. Unexplained
   * order/table divergence still reaches {@link validateStoredState} and
   * fails loud; this path never guesses which operation created a row from its shape alone.
   */
  private async recoverPendingMutation(): Promise<void> {
    const state = this.requireState()
    const pending = state.pendingMutation
    if (pending === undefined) return
    if (state.workspaceIds.includes(pending.workspaceId)) {
      throw new Error(
        `workspace domain is inconsistent: pending ${pending.operation} workspace `
        + `'${pending.workspaceId}' is still present in registry order`,
      )
    }
    await this.requireTable().delete(pending.workspaceId)
    await this.setState({ ...state, pendingMutation: undefined })
  }

  private async bootstrap(headers: readonly SessionHeader[]): Promise<void> {
    const table = this.requireTable()
    const state = this.requireState()
    const groupsByPath = new Map<string, SessionHeader[]>()
    for (const header of headers) {
      const path = this.sessionPath(header.id, LOCAL_HOST_ID)
      if (path === undefined) continue
      const group = groupsByPath.get(path)
      if (group === undefined) groupsByPath.set(path, [header])
      else group.push(header)
    }
    const groups: BootstrapGroup[] = [...groupsByPath].map(([path, groupHeaders]) => {
      groupHeaders.sort(compareHeaders)
      const newest = groupHeaders[0] as SessionHeader
      return { path, headers: groupHeaders, newestAt: newest.createdAt }
    }).sort((left, right) =>
      right.newestAt - left.newestAt || left.path.localeCompare(right.path))

    const byPath = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      byPath.set(hostPathKey(record.hostId, record.path), id)
      for (const sessionId of record.sessionIds) accounted.set(sessionId, id)
    }

    for (const group of groups) {
      const groupKey = hostPathKey(LOCAL_HOST_ID, group.path)
      let id = byPath.get(groupKey)
      if (id === undefined) {
        const sessionIds = group.headers
          .map(header => header.id)
          .filter(sessionId => !accounted.has(sessionId))
        if (sessionIds.length === 0) continue
        id = WorkspaceId(randomUUID())
        const createdAt = new Date(group.newestAt).toISOString()
        const record: WorkspaceRecord = {
          hostId: LOCAL_HOST_ID,
          path: group.path,
          title: defaultWorkspaceTitle(group.path),
          sessionIds,
          createdAt,
          updatedAt: createdAt,
        }
        await table.put(id, record)
        byPath.set(groupKey, id)
        for (const sessionId of sessionIds) accounted.set(sessionId, id)
        continue
      }

      const current = table.get(id) as WorkspaceRecord
      const historical = group.headers
        .map(header => header.id)
        .filter(sessionId => accounted.get(sessionId) === undefined || accounted.get(sessionId) === id)
      const historicalSet = new Set(historical)
      const sessionIds = [
        ...historical,
        ...current.sessionIds.filter(sessionId => !historicalSet.has(sessionId)),
      ]
      if (sameSessionIds(current.sessionIds, sessionIds)) continue
      await table.update(id, record => ({
        ...record,
        sessionIds,
        updatedAt: new Date().toISOString(),
      }))
      for (const sessionId of historical) accounted.set(sessionId, id)
    }

    const groupRank = new Map(groups.map(group => [group.path, group.newestAt]))
    const priorRank = new Map(state.workspaceIds.map((id, index) => [id, index]))
    const workspaceIds = [...table.entries()]
      .sort(([leftId, left], [rightId, right]) => {
        const leftTime = groupRank.get(left.path) ?? Date.parse(left.createdAt)
        const rightTime = groupRank.get(right.path) ?? Date.parse(right.createdAt)
        return rightTime - leftTime
          || (priorRank.get(leftId) ?? Number.MAX_SAFE_INTEGER)
            - (priorRank.get(rightId) ?? Number.MAX_SAFE_INTEGER)
          || String(leftId).localeCompare(String(rightId))
      })
      .map(([id]) => id)

    if (!sameIds(state.workspaceIds, workspaceIds)) {
      await this.setState({
        initialized: false,
        workspaceIds,
        archivedSessionIds: state.archivedSessionIds,
        pinnedSessionIds: state.pinnedSessionIds,
      })
    }
    await this.setState({
      initialized: true,
      workspaceIds,
      archivedSessionIds: state.archivedSessionIds,
      pinnedSessionIds: state.pinnedSessionIds,
    })
  }

  private validateStoredState(state: WorkspaceDomainState): void {
    const table = this.requireTable()
    const order = new Set<WorkspaceId>()
    for (const id of state.workspaceIds) {
      if (order.has(id)) {
        throw new Error(`workspace domain is inconsistent: registry order repeats workspace '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`workspace domain is inconsistent: registry order references missing workspace '${id}'`)
      }
      order.add(id)
    }
    if (state.initialized && order.size !== table.size) {
      const orphan = [...table.keys()].find(id => !order.has(id))
      throw new Error(
        `workspace domain is inconsistent: workspace '${orphan as WorkspaceId}' is absent from registry order`,
      )
    }

    const paths = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      const key = hostPathKey(record.hostId, record.path)
      const pathHolder = paths.get(key)
      if (pathHolder !== undefined) {
        throw new Error(
          `workspace domain is inconsistent: host '${record.hostId}' path '${record.path}' is claimed `
          + `by both workspace '${pathHolder}' and workspace '${id}'`,
        )
      }
      paths.set(key, id)
      for (const sessionId of record.sessionIds) {
        const holder = accounted.get(sessionId)
        if (holder !== undefined) {
          throw new Error(
            `workspace domain is inconsistent: session '${sessionId}' is accounted `
            + `by both workspace '${holder}' and workspace '${id}'`,
          )
        }
        accounted.set(sessionId, id)
      }
    }
  }

  private rebuildEntities(): void {
    this.entities.clear()
    for (const id of this.requireState().workspaceIds) {
      const record = this.requireTable().get(id) as WorkspaceRecord
      this.entities.set(id, new WorkspaceEntity(this.host, id, record))
    }
  }

  private async replaceHeaderIndex(headers: readonly SessionHeader[]): Promise<void> {
    this.headers.clear()
    this.sessionPathFacts.clear()
    await this.indexHeaders(headers)
  }

  private async indexHeaders(headers: readonly SessionHeader[]): Promise<void> {
    for (const header of headers) await this.indexHeader(header)
  }

  private async indexHeader(header: SessionHeader): Promise<void> {
    this.headers.set(header.id, header)
    if (header.cwd === undefined) {
      this.sessionPathFacts.set(header.id, { invalidReason: 'header has no cwd' })
      return
    }
    const facts: SessionPathFacts = {}
    if (posix.isAbsolute(header.cwd)) facts.remote = remotePathNormalize(header.cwd)
    try {
      const path = await realpathNormalize(header.cwd)
      if (!(await stat(path)).isDirectory()) {
        this.sessionPathFacts.set(header.id, {
          ...facts,
          invalidReason: `cwd '${header.cwd}' is not a directory`,
        })
        return
      }
      this.sessionPathFacts.set(header.id, { ...facts, local: path })
    } catch {
      this.sessionPathFacts.set(header.id, {
        ...facts,
        invalidReason: `cwd '${header.cwd}' does not resolve`,
      })
    }
  }

  /**
   * The canonical cwd one host would derive for a session header, or
   * `undefined` when the header is unindexed or its cwd has no canon under
   * that host's rules.
   */
  private sessionPath(id: SessionId, hostId: string): string | undefined {
    const facts = this.sessionPathFacts.get(id)
    if (facts === undefined) return undefined
    return hostId === LOCAL_HOST_ID ? facts.local : facts.remote
  }

  /** Every stored session's header, projected from the persistence snapshot listing. */
  private async listStoredHeaders(): Promise<SessionHeader[]> {
    const snapshots = await this.ctx.sessionPersistence.list()
    return snapshots.map(snapshot => snapshot.header)
  }

  private async indexLiveSessions(): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return
    await this.indexHeaders(sessions.list().map(session => session.header))
  }

  private reportFilteredCandidates(): void {
    for (const entity of this.entities.values()) {
      const record = this.requireTable().get(entity.id) as WorkspaceRecord
      for (const sessionId of record.sessionIds) {
        const facts = this.sessionPathFacts.get(sessionId)
        const path = this.sessionPath(sessionId, record.hostId)
        if (path === record.path) continue
        const reason = path === undefined
          ? facts?.invalidReason ?? 'session header is missing'
          : `cwd '${path}' canonicalizes differently from workspace path '${record.path}'`
        this.ctx.logger.warn(
          `workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`,
        )
      }
    }
  }

  private async readSessionHeader(id: SessionId): Promise<SessionHeader> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      this.headers.set(id, live.header)
      return live.header
    }
    const cached = this.headers.get(id)
    if (cached !== undefined) return cached

    const headers = await this.listStoredHeaders()
    await this.indexHeaders(headers)
    const header = this.headers.get(id)
    if (header === undefined) {
      throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
    }
    return header
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }

  private requireState(): WorkspaceDomainState {
    if (this.state === undefined) throw new Error('workspace registry is not started yet')
    return this.state
  }

  private async setState(state: WorkspaceDomainState): Promise<void> {
    await (this.global as DomainGlobal<WorkspaceDomainState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(async () => {
      // A committed delete may leave only its marker cleanup pending. Retry
      // recovery before another create/delete can overwrite that pending operation record.
      await this.recoverPendingMutation()
      return await operation()
    })
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

const sameSessionIds = (left: readonly SessionId[], right: readonly SessionId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

export default WorkspaceRegistry

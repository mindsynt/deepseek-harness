/**
 * Durable sidecar mapping each Session to the execution-world host that owns
 * its working directory. The Session log header stays untouched: adding a field
 * would make released header readers reject new logs, and a format-version bump
 * would carry a migration package, an archived predecessor, a persistence
 * change record, snapshot successors, and both SDK projections. Host identity
 * therefore lives beside the log in a storage domain, written in the same
 * operation that creates the Session and read on resume, adopt, and every later
 * host-addressed consumer.
 * @module @deepseek-ai/dsh-session-controller/session-hosts
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'

/**
 * Identity of the Harness host's own execution world, matching the Workspace
 * domain's `LOCAL_HOST_ID`. A Session created from a bare cwd, or one whose
 * record predates this sidecar, belongs here.
 */
export const LOCAL_HOST_ID = 'local'

/**
 * Host identity of one Session. Mirrors the Workspace record's token rule — no
 * whitespace and no path separator, so the two durable records spell the same
 * host alike — and normalizes an empty string to the built-in local host.
 */
const sessionHostId = z.string()
  .transform(value => (value === '' ? LOCAL_HOST_ID : value))
  .refine(value => !/[\s/\\]/.test(value), {
    message: 'hostId must be a non-empty token without whitespace or a path separator',
  })

/**
 * Durable shape of one Session-to-host record, keyed by the Session identity.
 * `hostId` names the execution world that interprets the Session's recorded
 * cwd; a Session without a record resolves through the Workspace accounting for
 * it and then to {@link LOCAL_HOST_ID}, which is the behaviour every Session
 * written before this sidecar keeps.
 */
export const sessionHostRecord = z.object({ hostId: sessionHostId })

/** One stored Session-to-host record. */
export type SessionHostRecord = z.infer<typeof sessionHostRecord>

/** The table name this domain's single record set uses. */
const SESSION_HOSTS_TABLE = 'session_hosts'

/**
 * The session-host domain spec: one `session_hosts` table keyed by
 * {@link SessionId}. Opened through `ctx.storageDomain`; this object is the
 * single source of the domain's identity, version, and record schema.
 */
export const sessionHostDomainSpec = defineDomain({
  name: 'session_host',
  version: 1,
  tables: { session_hosts: domainTable<SessionId, SessionHostRecord>(sessionHostRecord) },
})

/**
 * Durable Session-to-host sidecar. The domain opens once, lazily, on first use,
 * and closes with the owning fiber; record reads are synchronous table lookups
 * over the opened handle, and writes go through the domain's durable `put`. An
 * unavailable storage domain or a failed open or write throws: a Session must
 * never be created with an unknown host silently dropped.
 */
export class SessionHostStore {
  private opened: Promise<Domain<typeof sessionHostDomainSpec>> | undefined

  /** @param ctx - Host context carrying the storage domain and Workspace registry. */
  constructor(private readonly ctx: Context) {
    // Registered at construction so the domain's lifetime is owned even when
    // the open itself fails or never happens.
    ctx.effect(() => async () => {
      const domain = await this.opened?.catch(() => undefined)
      await domain?.close()
    }, 'session-controller: session-host domain')
  }

  /**
   * Resolve the execution-world host that owns one Session: the durable record
   * first, then the Workspace accounting for the Session, then the built-in
   * local host. A Session without a record — one written before this sidecar —
   * therefore keeps the behaviour it had before host identity was recorded.
   * @param sessionId - Session whose host is resolved.
   * @returns the host identity that interprets the Session cwd.
   * @throws when the storage domain or Workspace registry is unavailable.
   */
  async resolveHost(sessionId: SessionId): Promise<string> {
    const recorded = await this.hostOf(sessionId)
    if (recorded !== undefined) return recorded
    for (const workspace of this.workspaces()) {
      if (workspace.sessionIds.includes(sessionId)) return workspace.hostId
    }
    return LOCAL_HOST_ID
  }

  /**
   * Read one Session's recorded host.
   * @param sessionId - Session whose record is read.
   * @returns the recorded host, or `undefined` when the Session has no record.
   * @throws when the storage domain is unavailable or the domain open failed.
   */
  async hostOf(sessionId: SessionId): Promise<string | undefined> {
    const table: KvTable<SessionId, SessionHostRecord> = (await this.requireDomain()).table(SESSION_HOSTS_TABLE)
    return table.get(sessionId)?.hostId
  }

  /**
   * Durably record the host that owns one Session. Host identity is immutable
   * for a Session, because its cwd is interpreted in that world, so a second
   * record naming a different host fails instead of rewriting the first.
   * @param sessionId - Session being recorded.
   * @param hostId - host that owns the Session cwd.
   * @throws when the storage domain is unavailable or the write fails, or an
   *   existing record names a different host.
   */
  async remember(sessionId: SessionId, hostId: string): Promise<void> {
    const table = (await this.requireDomain()).table(SESSION_HOSTS_TABLE)
    const existing = table.get(sessionId)?.hostId
    if (existing !== undefined && existing !== hostId) {
      throw new Error(`session "${sessionId}" already belongs to host "${existing}", not "${hostId}"`)
    }
    if (existing !== undefined) return
    await table.put(sessionId, { hostId })
  }

  /** Open the sidecar domain once; every later call reuses that handle. */
  private async requireDomain(): Promise<Domain<typeof sessionHostDomainSpec>> {
    this.opened ??= this.openDomain()
    return await this.opened
  }

  private async openDomain(): Promise<Domain<typeof sessionHostDomainSpec>> {
    const storage = this.ctx.get('storageDomain')
    if (storage === undefined) {
      throw new Error('session-controller: the session-host sidecar requires the storage-domain service')
    }
    return await storage.open(sessionHostDomainSpec)
  }

  /** The Workspace registry every Session host falls back to. */
  private workspaces(): readonly Workspace[] {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      throw new Error('session-controller: the session-host sidecar requires the Workspace registry')
    }
    return registry.list()
  }
}

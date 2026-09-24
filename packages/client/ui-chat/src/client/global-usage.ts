/**
 * Cross-session usage aggregation for the composer cost reading.
 *
 * Session projections are per-session by design; this policy joins every
 * listed Session's `usageByRoute` value into one projection. Cached/list
 * values are used as they stand, and sessions without a value are asked to
 * load their complete projection baseline once (the Host folds the stored
 * log). The current Session's live value is merged by the consumer, which is
 * fresher than the manager's projection row for an open Session.
 *
 * @module @deepseek-ai/dsh-client-ui-chat/global-usage
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { UsageByDayProjection, UsageByRouteProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Concurrent projection baseline reads; keeps a large session list from flooding the Host. */
const REFRESH_CONCURRENCY = 3

/** One session's projection block as the session list exposes it. */
export interface GlobalUsageSessionBlock {
  readonly values: Readonly<{
    usageByRoute?: UsageByRouteProjection
    usageByDay?: UsageByDayProjection
  }>
  readonly state: 'idle' | 'loading' | 'ready' | 'error'
}

/** The session list read face this policy needs. */
export interface GlobalUsageList {
  /**
   * Read the current list snapshot.
   * @returns listed Session ids and their projection blocks.
   */
  getSnapshot(): {
    readonly phase?: string
    readonly ids: readonly SessionId[]
    readonly projectionsBySession: Readonly<Record<SessionId, GlobalUsageSessionBlock | undefined>>
    readonly byId?: Readonly<Record<SessionId, { readonly origin?: 'subagent' } | undefined>>
  }
  /**
   * Observe list changes.
   * @param listener - invoked after the list snapshot changes.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
}

/** Host operations and list source one aggregation run needs. */
export interface GlobalUsageDeps {
  /** Shared session list state. */
  list: GlobalUsageList
  /**
   * Load one Session's complete projection baseline.
   * @param sessionId - listed Session to load.
   * @returns settlement after the projection store received the baseline.
   */
  refreshProjections(sessionId: SessionId): Promise<void>
}

/** Aggregated cross-session usage state. */
export interface GlobalUsageSnapshot {
  /** `loading` while missing Session values are still being read. */
  status: 'idle' | 'loading' | 'ready'
  /** Current per-session route values; missing/loading sessions are absent. */
  bySession: ReadonlyMap<SessionId, UsageByRouteProjection>
  /** Current per-session day values; missing/loading sessions are absent. */
  daysBySession: ReadonlyMap<SessionId, UsageByDayProjection>
  /** Listed Sessions whose origin is a subagent. */
  subagentSessions: ReadonlySet<SessionId>
}

/** Run one pool of async items with a fixed concurrency. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        await worker(items[index] as T)
      }
    },
  )
  await Promise.all(workers)
}

/**
 * Join every listed Session's route usage into one observable projection.
 */
export class GlobalUsagePolicy {
  /** Snapshot consumed by the composer cost reading through the inject hooks. */
  readonly snapshot = createSnapshotStore<GlobalUsageSnapshot>({
    status: 'idle',
    bySession: new Map(),
    daysBySession: new Map(),
    subagentSessions: new Set(),
  })

  private requested = false
  private running = false
  private rerun = false
  private disposed = false
  private generation = 0
  /** Sessions whose baseline read has been attempted; a Host without the unit must not retry forever. */
  private readonly attempted = new Set<SessionId>()
  /** Sessions whose last baseline read failed; the next scheduling pass retries them once. */
  private readonly retryErrors = new Set<SessionId>()
  private readonly unsubscribe: () => void

  /**
   * @param deps - session list and projection baseline loader.
   */
  constructor(private readonly deps: GlobalUsageDeps) {
    this.unsubscribe = deps.list.subscribe(() => { this.schedule() })
  }

  /** Start aggregation lazily; idempotent until the connection resets. */
  ensure(): void {
    if (this.disposed) return
    this.requested = true
    this.schedule()
  }

  /**
   * Drop loaded values and wait for the owning surface to ask again after a
   * connection or Host generation change. Scheduling here would race the
   * connection-reset handlers that are still replacing the Session list.
   */
  reset(): void {
    if (this.disposed) return
    this.generation += 1
    this.requested = false
    this.attempted.clear()
    this.retryErrors.clear()
    this.rerun = false
    this.snapshot.set({
      status: 'idle',
      bySession: new Map(),
      daysBySession: new Map(),
      subagentSessions: new Set(),
    })
  }

  /** Release the list subscription and stop publishing. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
  }

  /** Start one run, folding into the current run when one is already active. */
  private schedule(): void {
    if (!this.requested) return
    if (this.running) {
      this.rerun = true
      return
    }
    for (const sessionId of this.retryErrors) this.attempted.delete(sessionId)
    this.retryErrors.clear()
    void this.run()
  }

  /** Collect every available value, read missing baselines, and publish. */
  private async run(): Promise<void> {
    const generation = this.generation
    this.running = true
    try {
      for (;;) {
        this.rerun = false
        const list = this.deps.list.getSnapshot()
        const bySession = new Map<SessionId, UsageByRouteProjection>()
        const daysBySession = new Map<SessionId, UsageByDayProjection>()
        const subagentSessions = new Set<SessionId>()
        const missing: SessionId[] = []
        for (const sessionId of list.ids) {
          const block = list.projectionsBySession[sessionId]
          const routeProjection = block?.values.usageByRoute
          const dayProjection = block?.values.usageByDay
          if (routeProjection !== undefined) bySession.set(sessionId, routeProjection)
          if (dayProjection !== undefined) daysBySession.set(sessionId, dayProjection)
          if (list.byId?.[sessionId]?.origin === 'subagent') subagentSessions.add(sessionId)
          if ((routeProjection === undefined || dayProjection === undefined) && !this.attempted.has(sessionId)) {
            missing.push(sessionId)
          }
        }
        const listPending = list.phase !== undefined && list.phase !== 'ready' && list.ids.length === 0
        this.publish(
          missing.length === 0 && !listPending ? 'ready' : 'loading',
          bySession,
          daysBySession,
          subagentSessions,
        )
        if (missing.length === 0) {
          if (!this.isRerunRequested()) return
          continue
        }
        for (const sessionId of missing) this.attempted.add(sessionId)
        await runPool(missing, REFRESH_CONCURRENCY, async (sessionId) => {
          try {
            await this.deps.refreshProjections(sessionId)
          } catch (_error: unknown) {
            // The projection store records the failure; collect it below.
          }
        })
        if (this.disposed) return
        if (!this.requested) return
        if (generation !== this.generation) return
        const refreshed = this.deps.list.getSnapshot()
        for (const sessionId of missing) {
          if (refreshed.projectionsBySession[sessionId]?.state === 'error') this.retryErrors.add(sessionId)
        }
      }
    } finally {
      this.running = false
      const rerun = this.rerun
      this.rerun = false
      if (rerun && !this.disposed && this.requested) this.schedule()
    }
  }

  /** Read the folded-rerun marker; a method keeps the field's flow type open across awaits. */
  private isRerunRequested(): boolean {
    return this.rerun
  }

  /** Publish one state; the caller owns value freshness. */
  private publish(
    status: GlobalUsageSnapshot['status'],
    bySession: ReadonlyMap<SessionId, UsageByRouteProjection>,
    daysBySession: ReadonlyMap<SessionId, UsageByDayProjection>,
    subagentSessions: ReadonlySet<SessionId>,
  ): void {
    this.snapshot.set({ status, bySession, daysBySession, subagentSessions })
  }
}

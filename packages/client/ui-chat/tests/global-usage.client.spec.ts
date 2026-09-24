import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  UsageByDayEntry, UsageByDayProjection, UsageByRouteEntry, UsageByRouteProjection, UsageByRouteSlot,
} from '@deepseek-ai/dsh-token-meter/client'
import {
  GlobalUsagePolicy, type GlobalUsageSessionBlock,
} from '../src/client/global-usage.ts'

const SID = 'session-1' as SessionId
const OTHER = 'session-2' as SessionId
const THIRD = 'session-3' as SessionId

const SLOT: UsageByRouteSlot = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

function route(provider: string, model: string, tokens: number): UsageByRouteEntry {
  const usage = { ...SLOT, uncachedInputTokens: tokens }
  return {
    provider,
    model,
    totals: usage,
    slots: Array.from({ length: 48 }, (_unused, index) => index === 0 ? usage : SLOT),
  }
}

function routeProjection(...routes: UsageByRouteEntry[]): UsageByRouteProjection {
  return { routes }
}

function dayRoute(provider: string, model: string, day: number, tokens: number): UsageByDayEntry {
  const usage = { ...SLOT, uncachedInputTokens: tokens }
  return {
    provider,
    model,
    totals: usage,
    days: [{ day, slots: Array.from({ length: 48 }, (_unused, index) => index === 0 ? usage : SLOT) }],
  }
}

function dayProjection(...routes: UsageByDayEntry[]): UsageByDayProjection {
  return { routes }
}

interface ListState {
  phase: 'pending' | 'ready'
  ids: readonly SessionId[]
  projectionsBySession: Readonly<Record<SessionId, GlobalUsageSessionBlock | undefined>>
  byId?: Readonly<Record<SessionId, { readonly origin?: 'subagent' } | undefined>>
}

function block(
  routeValue?: UsageByRouteProjection,
  dayValue?: UsageByDayProjection,
): GlobalUsageSessionBlock {
  return {
    state: 'ready',
    values: {
      ...routeValue === undefined ? {} : { usageByRoute: routeValue },
      ...dayValue === undefined ? {} : { usageByDay: dayValue },
    },
  }
}

const FULL = block(
  routeProjection(route('deepseek', 'chat', 11)),
  dayProjection(dayRoute('deepseek', 'chat', 100, 11)),
)

function listOf(
  ids: readonly SessionId[],
  blocks: Readonly<Record<SessionId, GlobalUsageSessionBlock | undefined>> = {},
  phase: ListState['phase'] = 'ready',
  byId?: ListState['byId'],
) {
  return createSnapshotStore<ListState>({ phase, ids, projectionsBySession: blocks, ...(byId === undefined ? {} : { byId }) })
}

/** Wait for policy microtasks and subscriptions to settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** A complete baseline pair for one route/day. */
function fullBlock(provider: string, model: string, day: number, tokens: number): GlobalUsageSessionBlock {
  return block(
    routeProjection(route(provider, model, tokens)),
    dayProjection(dayRoute(provider, model, day, tokens)),
  )
}

describe('GlobalUsagePolicy', () => {
  it('merges listed values, loads only missing sessions once, and records subagent origin', async () => {
    const list = listOf([SID, OTHER], { [SID]: FULL }, 'ready', { [OTHER]: { origin: 'subagent' } })
    const refreshProjections = vi.fn(async (sessionId: SessionId) => {
      list.update((draft) => {
        draft.projectionsBySession = { ...draft.projectionsBySession, [sessionId]: fullBlock('other', 'model', 200, 7) }
      })
    })
    const policy = new GlobalUsagePolicy({ list, refreshProjections })
    expect(policy.snapshot.getSnapshot().status).toBe('idle')

    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })
    expect(refreshProjections).toHaveBeenCalledExactlyOnceWith(OTHER)
    expect([...policy.snapshot.getSnapshot().bySession.keys()]).toEqual([SID, OTHER])
    expect([...policy.snapshot.getSnapshot().daysBySession.keys()]).toEqual([SID, OTHER])
    expect([...policy.snapshot.getSnapshot().subagentSessions]).toEqual([OTHER])
    policy.dispose()
  })

  it('reports loading while the list itself is still arriving, then settles on the ready list', async () => {
    const list = listOf([], {}, 'pending')
    const policy = new GlobalUsagePolicy({ list, refreshProjections: vi.fn() })
    policy.ensure()
    await settle()
    expect(policy.snapshot.getSnapshot().status).toBe('loading')

    list.update((draft) => { draft.phase = 'ready' })
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })
    policy.dispose()
  })

  it('does not retry a session whose baseline arrived without the usage units', async () => {
    const list = listOf([SID, OTHER], { [SID]: FULL })
    const refreshProjections = vi.fn(async () => {})
    const policy = new GlobalUsagePolicy({ list, refreshProjections })
    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })
    expect(refreshProjections).toHaveBeenCalledExactlyOnceWith(OTHER)

    list.update((draft) => { draft.projectionsBySession = { ...draft.projectionsBySession } })
    await settle()
    expect(refreshProjections).toHaveBeenCalledTimes(1)
    policy.dispose()
  })

  it('picks up a Session added after the first run', async () => {
    const list = listOf([])
    const refreshProjections = vi.fn(async (sessionId: SessionId) => {
      list.update((draft) => {
        draft.projectionsBySession = { ...draft.projectionsBySession, [sessionId]: fullBlock('deepseek', 'chat', 1, 3) }
      })
    })
    const policy = new GlobalUsagePolicy({ list, refreshProjections })
    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })

    list.update((draft) => { draft.ids = [SID] })
    await vi.waitFor(() => { expect(refreshProjections).toHaveBeenCalledExactlyOnceWith(SID) })
    await vi.waitFor(() => { expect([...policy.snapshot.getSnapshot().bySession.keys()]).toEqual([SID]) })
    policy.dispose()
  })

  it('keeps the completed value when a baseline read rejects', async () => {
    const list = listOf([SID, OTHER], { [SID]: FULL })
    const refreshProjections = vi.fn(async () => { throw new Error('baseline failed') })
    const policy = new GlobalUsagePolicy({ list, refreshProjections })
    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })
    expect([...policy.snapshot.getSnapshot().bySession.keys()]).toEqual([SID])
    policy.dispose()
  })

  it('clears attempts on reset and re-asks only after the surface calls ensure again', async () => {
    const list = listOf([SID, OTHER, THIRD], { [SID]: FULL })
    const refreshProjections = vi.fn(async () => {})
    const policy = new GlobalUsagePolicy({ list, refreshProjections })
    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })
    expect(refreshProjections).toHaveBeenCalledTimes(2)

    policy.reset()
    expect(policy.snapshot.getSnapshot().status).toBe('idle')
    await settle()
    expect(refreshProjections).toHaveBeenCalledTimes(2)
    policy.ensure()
    await vi.waitFor(() => { expect(refreshProjections).toHaveBeenCalledTimes(4) })
    policy.dispose()
  })

  it('ignores list changes while no surface has asked for aggregation', async () => {
    const list = listOf([SID], { [SID]: FULL })
    const refreshProjections = vi.fn()
    const policy = new GlobalUsagePolicy({ list, refreshProjections })
    list.update((draft) => { draft.ids = [] })
    await settle()
    expect(refreshProjections).not.toHaveBeenCalled()
    expect(policy.snapshot.getSnapshot().status).toBe('idle')
    policy.dispose()
  })

  it('folds a list change observed during a run into another pass', async () => {
    const listeners = new Set<() => void>()
    let calls = 0
    const list = {
      getSnapshot: () => {
        calls += 1
        if (calls === 2) for (const listener of [...listeners]) listener()
        return {
          phase: 'ready' as const,
          ids: [SID],
          projectionsBySession: { [SID]: FULL },
        }
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const policy = new GlobalUsagePolicy({ list, refreshProjections: vi.fn() })
    policy.ensure()
    await settle()
    expect(calls).toBe(1)

    policy.ensure()
    await settle()
    expect(calls).toBe(3)
    policy.dispose()
  })

  it('stops an in-flight run when the connection reset lands without a new ask', async () => {
    const list = listOf([SID])
    const deferred = Promise.withResolvers<undefined>()
    const refreshProjections = vi.fn(async () => { await deferred.promise })
    const policy = new GlobalUsagePolicy({ list, refreshProjections })
    policy.ensure()
    await vi.waitFor(() => { expect(refreshProjections).toHaveBeenCalledTimes(1) })

    policy.reset()
    deferred.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    await settle()
    expect(policy.snapshot.getSnapshot().status).toBe('idle')
    expect(policy.snapshot.getSnapshot().bySession.size).toBe(0)
    policy.dispose()
  })

  it('stops an in-flight run once the policy is disposed', async () => {
    const list = listOf([SID])
    const deferred = Promise.withResolvers<undefined>()
    const refreshProjections = vi.fn(async () => { await deferred.promise })
    const policy = new GlobalUsagePolicy({ list, refreshProjections })
    policy.ensure()
    await vi.waitFor(() => { expect(refreshProjections).toHaveBeenCalledTimes(1) })

    policy.dispose()
    deferred.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    await settle()
    expect(policy.snapshot.getSnapshot().status).toBe('loading')
    policy.dispose()
  })

  it('retries a failed baseline once a later list change schedules a new pass', async () => {
    const list = listOf([SID])
    const refreshProjections = vi.fn(async (sessionId: SessionId) => {
      list.update((draft) => {
        draft.projectionsBySession = refreshProjections.mock.calls.length === 1
          ? { [sessionId]: { state: 'error', values: {} } }
          : { ...draft.projectionsBySession, [sessionId]: fullBlock('deepseek', 'chat', 1, 9) }
      })
    })
    const policy = new GlobalUsagePolicy({ list, refreshProjections })
    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })
    expect(refreshProjections).toHaveBeenCalledTimes(1)

    list.update((draft) => { draft.projectionsBySession = { ...draft.projectionsBySession } })
    await vi.waitFor(() => { expect(refreshProjections).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().bySession.size).toBe(1) })
    policy.dispose()
  })

  it('fences an in-flight run when reset asks for a fresh generation', async () => {
    const list = listOf([SID])
    const first = Promise.withResolvers<undefined>()
    const refreshProjections = vi.fn(async (sessionId: SessionId) => {
      if (refreshProjections.mock.calls.length === 1) {
        await first.promise
        return
      }
      list.update((draft) => {
        draft.projectionsBySession = { [sessionId]: fullBlock('deepseek', 'chat', 1, 4) }
      })
    })
    const policy = new GlobalUsagePolicy({ list, refreshProjections })
    policy.ensure()
    await vi.waitFor(() => { expect(refreshProjections).toHaveBeenCalledTimes(1) })

    policy.reset()
    policy.ensure()
    first.resolve(undefined)
    await vi.waitFor(() => { expect(refreshProjections).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().bySession.size).toBe(1) })
    policy.dispose()
  })

  it('ignores lifecycle calls after disposal', async () => {
    const list = listOf([SID], { [SID]: FULL })
    const policy = new GlobalUsagePolicy({ list, refreshProjections: vi.fn() })
    policy.dispose()
    policy.ensure()
    policy.reset()
    policy.dispose()
    await settle()
    expect(policy.snapshot.getSnapshot().status).toBe('idle')
  })
})

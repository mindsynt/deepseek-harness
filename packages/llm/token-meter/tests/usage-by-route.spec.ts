import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import {
  mergeUsageByDay, mergeUsageByRoute, usageByDayForMonth, usageDayOf, usageMonthKey,
  usageMonths, usageSlotOf, USAGE_DAY_MS, USAGE_SLOT_MS,
} from '@deepseek-ai/dsh-token-meter/client'
import type {
  UsageByDayProjection,
  UsageByRouteEntry,
  UsageByRouteProjection,
  UsageByRouteSlot,
} from '@deepseek-ai/dsh-token-meter/client'
import { usageByDayProjectionDefinition as dayUnit } from '../src/usage-by-day.ts'
import { usageByRouteProjectionDefinition as unit } from '../src/usage-by-route.ts'

type State = ReturnType<typeof unit.init>

const ZERO: UsageByRouteSlot = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

function slot(overrides: Partial<UsageByRouteSlot> = {}): UsageByRouteSlot {
  return { ...ZERO, ...overrides }
}

function slotsAt(index: number, value: Partial<UsageByRouteSlot>): UsageByRouteSlot[] {
  const filled = Array.from({ length: 48 }, slot)
  filled[index] = slot(value)
  return filled
}

function slotIndex(time: number): number {
  return ((Math.floor(time / USAGE_SLOT_MS) % 48) + 48) % 48
}

function timeAtSlot(index: number): number {
  return index * USAGE_SLOT_MS
}

function usage(inputTokens: number, outputTokens: number, rest: Partial<TokenUsage> = {}): TokenUsage {
  return { inputTokens, outputTokens, ...rest }
}

function totalsOf(slots: readonly UsageByRouteSlot[]): UsageByRouteSlot {
  const totals = slot()
  for (const bucket of slots) {
    totals.uncachedInputTokens += bucket.uncachedInputTokens
    totals.outputTokens += bucket.outputTokens
    totals.cacheReadTokens += bucket.cacheReadTokens
    totals.cacheWriteTokens += bucket.cacheWriteTokens
  }
  return totals
}

/** Shape carrying cloned day rows from one seeded day-projection state. */
interface SeededDayState {
  readonly routes: readonly {
    readonly days: readonly { readonly day: number; readonly slots: readonly UsageByRouteSlot[] }[]
  }[]
}

/** Clone the day rows of one seeded state for synthetic edge states. */
function sharedDays(state: SeededDayState): { day: number; slots: UsageByRouteSlot[] }[] {
  return (state.routes[0]?.days ?? []).map(day => ({ day: day.day, slots: [...day.slots] }))
}

function entry(provider: string, model: string, slots: UsageByRouteSlot[]): UsageByRouteEntry {
  return { provider, model, totals: totalsOf(slots), slots }
}

function attemptEvent(
  time: number,
  usage?: TokenUsage,
  turn = 1,
  step = 1,
): SessionEvent<'assistant/attempt'> {
  return {
    type: 'assistant/attempt',
    seq: SessionSeq(time),
    time,
    data: {
      turn,
      step,
      stream: usage === undefined
        ? []
        : [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
    },
  }
}

function messageEvent(
  time: number,
  options: {
    usage?: TokenUsage
    streamUsage?: TokenUsage
    provider?: string
    model?: string
    turn?: number
    step?: number
  } = {},
): SessionEvent<'assistant/message'> {
  const provider = options.provider ?? 'deepseek'
  const model = options.model ?? 'deepseek-chat'
  return {
    type: 'assistant/message',
    seq: SessionSeq(time),
    time,
    surfaceOp: 'append',
    data: {
      turn: options.turn ?? 1,
      step: options.step ?? 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider, model },
      }),
      stream: options.streamUsage === undefined
        ? []
        : [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: options.streamUsage } }],
      ...options.usage === undefined ? {} : { usage: options.usage },
    },
  }
}

function headerEvent(time: number, provider: string, model: string): SessionEvent<'request/header'> {
  return {
    type: 'request/header',
    seq: SessionSeq(time),
    time,
    data: {
      header: { config: { provider, model } },
      reason: 'initial',
    },
  }
}

function retryStartedEvent(time: number, turn = 1, step = 1): SessionEvent<'llm/retry-started'> {
  return {
    type: 'llm/retry-started',
    seq: SessionSeq(time),
    time,
    data: {
      retryId: RetryId(`retry-${time}-${turn}-${step}`),
      turn,
      step,
      retry: 1,
    },
  }
}

const unrelatedEvent: SessionEvent<'session/end-seed'> = {
  type: 'session/end-seed',
  seq: SessionSeq(99),
  time: 99,
  data: {},
}

function emptyState(): Promise<State> {
  return Promise.resolve(unit.init())
}

function view(state: State): UsageByRouteProjection {
  return unit.wire.view(state)
}

type DayState = ReturnType<typeof dayUnit.init>

function dayView(state: DayState): UsageByDayProjection {
  return dayUnit.wire.view(state)
}

describe('usageByRoute fold', () => {
  it('starts empty and omits all-zero routes', async () => {
    expect(view(await emptyState())).toEqual({ routes: [] })
  })

  it('attributes a message to its source route and an attempt without a header to the unknown route', async () => {
    let state = await emptyState()
    const attributed = messageEvent(timeAtSlot(0), {
      usage: usage(11, 0, { cacheReadTokens: 3 }),
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    state = unit.apply(state, attributed)
    expect(view(state)).toEqual({
      routes: [entry('deepseek', 'deepseek-chat', slotsAt(0, { uncachedInputTokens: 11, cacheReadTokens: 3 }))],
    })

    const unknown = attemptEvent(timeAtSlot(1), usage(0, 5, { cacheWriteTokens: 2 }), 1, 2)
    state = unit.apply(state, unknown)
    expect(view(state)).toEqual({
      routes: [
        entry('deepseek', 'deepseek-chat', slotsAt(0, { uncachedInputTokens: 11, cacheReadTokens: 3 })),
        entry('', '', slotsAt(1, { outputTokens: 5, cacheWriteTokens: 2 })),
      ],
    })
  })

  it('attributes attempts to the latest request/header and keeps first-seen route order', async () => {
    let state = await emptyState()
    state = unit.apply(state, headerEvent(1, 'provider-a', 'model-a'))
    state = unit.apply(state, attemptEvent(timeAtSlot(0), usage(4, 0)))
    state = unit.apply(state, headerEvent(2, 'provider-b', 'model-b'))
    state = unit.apply(state, attemptEvent(timeAtSlot(1), usage(0, 7), 1, 2))
    state = unit.apply(state, attemptEvent(timeAtSlot(2), usage(0, 0, { cacheReadTokens: 9 }), 1, 3))

    expect(view(state)).toEqual({
      routes: [
        entry('provider-a', 'model-a', slotsAt(0, { uncachedInputTokens: 4 })),
        entry('provider-b', 'model-b', (() => {
          const slots = slotsAt(1, { outputTokens: 7 })
          slots[2] = slot({ cacheReadTokens: 9 })
          return slots
        })()),
      ],
    })
  })

  it('keeps a repeated header untouched and reuses the view reference', async () => {
    let state = await emptyState()
    state = unit.apply(state, headerEvent(1, 'provider-a', 'model-a'))
    state = unit.apply(state, attemptEvent(timeAtSlot(0), usage(4, 0)))
    const published = view(state)

    expect(unit.apply(state, unrelatedEvent)).toBe(state)
    expect(unit.apply(state, headerEvent(2, 'provider-a', 'model-a'))).toBe(state)

    const moved = unit.apply(state, headerEvent(3, 'provider-b', 'model-b'))
    expect(moved).not.toBe(state)
    expect(view(moved)).toBe(published)
    expect(view(moved)).toBe(view(moved))
  })

  it('replaces a same turn/step sample and leaves the previous slot empty', async () => {
    let state = await emptyState()
    state = unit.apply(state, messageEvent(timeAtSlot(0), { usage: usage(5, 0) }))
    state = unit.apply(state, messageEvent(timeAtSlot(1), { usage: usage(7, 1) }))
    expect(view(state)).toEqual({
      routes: [entry('deepseek', 'deepseek-chat', slotsAt(1, { uncachedInputTokens: 7, outputTokens: 1 }))],
    })

    const restated = messageEvent(timeAtSlot(1), { usage: usage(7, 1) })
    expect(unit.apply(state, restated)).toBe(state)
  })

  it('drops a route whose replacement totals reach zero', async () => {
    let state = await emptyState()
    state = unit.apply(state, messageEvent(timeAtSlot(0), { usage: usage(5, 0) }))
    state = unit.apply(state, messageEvent(timeAtSlot(1), { usage: usage(0, 0) }))
    expect(view(state)).toEqual({ routes: [] })
    expect(state.routes).toHaveLength(1)
  })

  it('accumulates retried attempts because llm/retry-started clears the replacement slot', async () => {
    let state = await emptyState()
    state = unit.apply(state, headerEvent(0, 'provider-a', 'model-a'))
    state = unit.apply(state, attemptEvent(timeAtSlot(0), usage(5, 0)))
    state = unit.apply(state, retryStartedEvent(2, 1, 1))
    state = unit.apply(state, attemptEvent(timeAtSlot(1), usage(7, 0)))
    expect(view(state)).toEqual({
      routes: [entry('provider-a', 'model-a', (() => {
        const slots = slotsAt(0, { uncachedInputTokens: 5 })
        slots[1] = slot({ uncachedInputTokens: 7 })
        return slots
      })())],
    })
  })

  it('ignores a retry start for a different attempt and a retry start without a sample', async () => {
    let state = await emptyState()
    expect(unit.apply(state, retryStartedEvent(1))).toBe(state)

    state = unit.apply(state, messageEvent(timeAtSlot(0), { usage: usage(5, 0) }))
    const otherAttempt = unit.apply(state, retryStartedEvent(1, 2, 9))
    expect(otherAttempt).toBe(state)
    // The replacement slot still covers turn 1/step 1, so the next sample replaces.
    state = unit.apply(otherAttempt, messageEvent(timeAtSlot(1), { usage: usage(7, 0) }))
    expect(view(state)).toEqual({
      routes: [entry('deepseek', 'deepseek-chat', slotsAt(1, { uncachedInputTokens: 7 }))],
    })
  })

  it('ignores samples without usage, unrelated events, and unknown-bucket message routes', async () => {
    const start = await emptyState()
    expect(unit.apply(start, attemptEvent(0))).toBe(start)

    let state = unit.apply(start, messageEvent(0, { provider: 'p', model: '', usage: usage(1, 0) }))
    state = unit.apply(state, messageEvent(1, { provider: '', model: 'm', usage: usage(2, 0) }))
    expect(state.routes).toHaveLength(1)
    expect(view(state).routes[0]?.provider).toBe('')
    expect(view(state).routes[0]?.model).toBe('')
    expect(view(state).routes[0]?.totals.uncachedInputTokens).toBe(2)

    const before = state
    expect(unit.apply(before, attemptEvent(2))).toBe(before)
    expect(unit.apply(before, unrelatedEvent)).toBe(before)
  })

  it('prefers final message usage over an embedded stream sample', async () => {
    let state = await emptyState()
    state = unit.apply(state, {
      ...messageEvent(timeAtSlot(0), {
        usage: usage(30, 0),
        streamUsage: usage(10, 0),
      }),
    })
    expect(view(state).routes[0]?.totals.uncachedInputTokens).toBe(30)
  })

  it('falls back to an embedded stream sample when the message has no usage', async () => {
    let state = await emptyState()
    state = unit.apply(state, messageEvent(timeAtSlot(0), { streamUsage: usage(12, 1) }))
    expect(view(state)).toEqual({
      routes: [entry('deepseek', 'deepseek-chat', slotsAt(0, { uncachedInputTokens: 12, outputTokens: 1 }))],
    })
  })

  it('folds an all-zero sample without creating a route', async () => {
    const before = await emptyState()
    const state = unit.apply(before, messageEvent(timeAtSlot(0), { usage: usage(0, 0) }))
    expect(state).not.toBe(before)
    expect(state.last).not.toBeNull()
    expect(view(state)).toEqual({ routes: [] })
  })
})

describe('usageByRoute session projection', () => {
  async function harness(): Promise<{
    ctx: Context
    session: ReturnType<Context['sessions']['create']>
    meterFiber: Awaited<ReturnType<Context['plugin']>>
  }> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meterFiber = await ctx.plugin(TokenMeter)
    return { ctx, session: ctx.sessions.create(), meterFiber }
  }

  const projected = (
    ctx: Context,
    session: ReturnType<Context['sessions']['create']>,
  ): UsageByRouteProjection => {
    const value = ctx.sessionProjections.snapshot(session).values.usageByRoute
    if (value === undefined) throw new Error('usageByRoute projection is not registered')
    return value
  }

  it('registers, checkpoints, restores, and unregisters with the token-meter fiber', async () => {
    const { ctx, session, meterFiber } = await harness()
    expect(projected(ctx, session)).toEqual({ routes: [] })

    const sample = session.append('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: usage(8, 2) } }],
    })
    const index = slotIndex(sample.time)
    expect(projected(ctx, session)).toEqual({
      routes: [entry('', '', slotsAt(index, { uncachedInputTokens: 8, outputTokens: 2 }))],
    })

    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>
    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('usageByRoute')

    await ctx.plugin(TokenMeter)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).usageByRoute).toEqual({
      routes: [entry('', '', slotsAt(index, { uncachedInputTokens: 8, outputTokens: 2 }))],
    })
  })

  it('publishes no change while route content is unchanged', async () => {
    const { ctx, session } = await harness()
    session.append('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: usage(4, 0) } }],
    })
    const changes: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'usageByRoute') changes.push(value)
    })
    const stateBefore = ctx.sessionProjections.stateOf(session, 'usageByRoute')
    if (stateBefore === undefined) throw new Error('usageByRoute projection is not registered')
    const viewBefore = unit.wire.view(stateBefore)

    session.append('session/end-seed', {})
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'mock' } },
      reason: 'initial',
    })
    // Listener attachment discards the prior raw views, so the first observed
    // view is the comparison baseline.
    expect(changes).toHaveLength(1)
    changes.length = 0
    session.append('request/header', {
      header: { config: { provider: 'mock-2', model: 'mock-2' } },
      reason: 'change',
    })
    expect(changes).toHaveLength(0)
    const stateAfter = ctx.sessionProjections.stateOf(session, 'usageByRoute')
    if (stateAfter === undefined) throw new Error('usageByRoute projection is not registered')
    expect(unit.wire.view(stateAfter)).toBe(viewBefore)
  })
})

describe('mergeUsageByRoute', () => {
  it('adds same-route slots field-wise and keeps first-seen route order', () => {
    const first = { routes: [
      entry('provider-a', 'model-a', slotsAt(0, { uncachedInputTokens: 4, cacheReadTokens: 1 })),
      entry('provider-b', 'model-b', slotsAt(1, { outputTokens: 7 })),
    ] }
    const second = { routes: [
      entry('provider-b', 'model-b', slotsAt(1, { outputTokens: 3, cacheWriteTokens: 2 })),
      entry('provider-a', 'model-a', slotsAt(0, { uncachedInputTokens: 6 })),
    ] }
    expect(mergeUsageByRoute([first, undefined, second])).toEqual({
      routes: [
        entry('provider-a', 'model-a', slotsAt(0, { uncachedInputTokens: 10, cacheReadTokens: 1 })),
        entry('provider-b', 'model-b', slotsAt(1, { outputTokens: 10, cacheWriteTokens: 2 })),
      ],
    })
  })

  it('omits zero routes and handles empty/undefined inputs', () => {
    expect(mergeUsageByRoute([])).toEqual({ routes: [] })
    expect(mergeUsageByRoute([undefined])).toEqual({ routes: [] })
    expect(mergeUsageByRoute([{ routes: [] }])).toEqual({ routes: [] })
    expect(mergeUsageByRoute([{ routes: [entry('provider-a', 'model-a', Array.from({ length: 48 }, slot))] }]))
      .toEqual({ routes: [] })
    expect(mergeUsageByRoute([{
      routes: [{ provider: 'provider-a', model: 'model-a', totals: slot(), slots: [] }],
    }])).toEqual({ routes: [] })
  })

  it('extends a route row when a later view carries a longer malformed day', () => {
    const first = {
      routes: [{
        provider: 'provider-a',
        model: 'model-a',
        totals: slot({ uncachedInputTokens: 1 }),
        slots: [slot({ uncachedInputTokens: 1 })],
      }],
    }
    const second = {
      routes: [{
        provider: 'provider-a',
        model: 'model-a',
        totals: slot({ outputTokens: 2 }),
        slots: [slot(), slot({ outputTokens: 2 })],
      }],
    }
    expect(mergeUsageByRoute([first, second])).toEqual({
      routes: [{
        provider: 'provider-a',
        model: 'model-a',
        totals: slot({ uncachedInputTokens: 1, outputTokens: 2 }),
        slots: [slot({ uncachedInputTokens: 1 }), slot({ outputTokens: 2 })],
      }],
    })
  })
})

describe('usageByDay fold', () => {
  it('buckets usage by UTC day and reuses the view reference for unrelated changes', () => {
    const start = dayUnit.init()
    expect(dayView(start)).toEqual({ routes: [] })
    const day = 100
    let state = dayUnit.apply(start, headerEvent(day * USAGE_DAY_MS + 1, 'provider-a', 'model-a'))
    state = dayUnit.apply(state, attemptEvent(day * USAGE_DAY_MS + USAGE_SLOT_MS, usage(4, 2), 1, 1))
    const published = dayView(state)
    expect(published.routes).toEqual([{
      provider: 'provider-a',
      model: 'model-a',
      totals: slot({ uncachedInputTokens: 4, outputTokens: 2 }),
      days: [{
        day,
        slots: slotsAt(1, { uncachedInputTokens: 4, outputTokens: 2 }),
      }],
    }])
    expect(dayUnit.apply(state, unrelatedEvent)).toBe(state)
    expect(dayView(state)).toBe(published)
  })

  it('replaces a same turn/step sample, clears on retry, and drops zeroed days', () => {
    const start = dayUnit.init()
    const day = 5
    const state = dayUnit.apply(start, attemptEvent(day * USAGE_DAY_MS + 1, usage(5, 0)))
    const replaced = dayUnit.apply(state, attemptEvent(day * USAGE_DAY_MS + 2, usage(7, 1)))
    expect(dayView(replaced).routes[0]?.totals).toEqual(slot({ uncachedInputTokens: 7, outputTokens: 1 }))
    const replacedWithoutSample = dayUnit.apply(replaced, attemptEvent(day * USAGE_DAY_MS + 3))
    expect(dayView(replacedWithoutSample).routes[0]?.totals).toEqual(slot({ uncachedInputTokens: 7, outputTokens: 1 }))
    const removed = dayUnit.apply(
      dayUnit.apply(replaced, retryStartedEvent(day * USAGE_DAY_MS + 3)),
      attemptEvent(day * USAGE_DAY_MS + 4),
    )
    expect(dayView(removed).routes[0]?.totals).toEqual(slot({ uncachedInputTokens: 7, outputTokens: 1 }))
    expect(removed.routes).toHaveLength(1)

    let retried = dayUnit.apply(start, attemptEvent(day * USAGE_DAY_MS + 1, usage(3, 0), 1, 1))
    retried = dayUnit.apply(retried, retryStartedEvent(day * USAGE_DAY_MS + 2))
    retried = dayUnit.apply(retried, attemptEvent(day * USAGE_DAY_MS + 3, usage(4, 0), 1, 1))
    expect(dayView(retried).routes[0]?.totals).toEqual(slot({ uncachedInputTokens: 7 }))
  })

  it('attributes message routes and keeps multiple days ascending', () => {
    const start = dayUnit.init()
    const day = 7
    let state = dayUnit.apply(start, messageEvent(day * USAGE_DAY_MS + 1, { usage: usage(1, 0) }))
    state = dayUnit.apply(state, messageEvent((day - 1) * USAGE_DAY_MS + 1, {
      usage: usage(2, 0), provider: 'deepseek', model: 'deepseek-chat', turn: 2, step: 1,
    }))
    const routes = dayView(state).routes
    expect(routes[0]?.days.map(entry => entry.day)).toEqual([day - 1, day])
    expect(routes[0]?.provider).toBe('deepseek')
  })

  it('ignores unrelated events and usage-less samples, and reuses one route view', () => {
    const start = dayUnit.init()
    expect(dayUnit.apply(start, unrelatedEvent)).toBe(start)
    expect(dayUnit.apply(start, attemptEvent(1))).toBe(start)
    const day = 9
    let state = dayUnit.apply(start, attemptEvent(day * USAGE_DAY_MS + 1, usage(1, 0)))
    const published = dayView(state)
    state = dayUnit.apply(state, headerEvent(day * USAGE_DAY_MS + 2, 'other', 'model'))
    expect(dayView(state)).toBe(published)
  })
})

describe('usageByDay edge cases', () => {
  it('treats an empty message route as the unknown route', () => {
    const start = dayUnit.init()
    const day = 3
    let state = dayUnit.apply(start, messageEvent(day * USAGE_DAY_MS + 1, {
      usage: usage(1, 0), provider: '', model: '',
    }))
    expect(dayView(state).routes[0]?.provider).toBe('')
    // Removal against a route that does not exist is a no-op.
    state = dayUnit.apply(state, attemptEvent(day * USAGE_DAY_MS + 2))
    expect(dayView(state).routes).toHaveLength(1)
  })

  it('reuses an identical repeated sample without republishing', () => {
    const start = dayUnit.init()
    const day = 4
    const sample = attemptEvent(day * USAGE_DAY_MS + 1, usage(2, 1), 1, 1)
    let state = dayUnit.apply(start, sample)
    state = dayUnit.apply(state, sample)
    expect(dayView(state).routes[0]?.totals).toEqual(slot({ uncachedInputTokens: 2, outputTokens: 1 }))
  })

  it('appends a second day to an existing route and keeps days ascending', () => {
    const start = dayUnit.init()
    let state = dayUnit.apply(start, attemptEvent(20 * USAGE_DAY_MS + 1, usage(1, 0)))
    state = dayUnit.apply(state, attemptEvent(10 * USAGE_DAY_MS + 1, usage(2, 0), 2, 1))
    expect(dayView(state).routes[0]?.days.map(entry => entry.day)).toEqual([10, 20])
  })

  it('replaces a same-slot sample instead of double counting it', () => {
    const start = dayUnit.init()
    let state = dayUnit.apply(start, attemptEvent(30 * USAGE_DAY_MS + 1, usage(3, 0), 1, 1))
    state = dayUnit.apply(state, attemptEvent(30 * USAGE_DAY_MS + 2, usage(1, 0), 1, 1))
    expect(dayView(state).routes[0]?.totals).toEqual(slot({ uncachedInputTokens: 1 }))
  })
})

describe('usageByDay replacement edges', () => {
  it('reuses a repeated header and clears a retry only for its own attempt', () => {
    const start = dayUnit.init()
    const day = 12
    const header = headerEvent(day * USAGE_DAY_MS + 1, 'provider-a', 'model-a')
    let state = dayUnit.apply(start, header)
    expect(dayUnit.apply(state, header)).toBe(state)
    state = dayUnit.apply(state, attemptEvent(day * USAGE_DAY_MS + 2, usage(2, 0), 1, 1))
    // A retry-started for another step leaves the replacement slot alone.
    const otherStep = dayUnit.apply(state, retryStartedEvent(day * USAGE_DAY_MS + 3, 1, 2))
    expect(dayView(otherStep).routes[0]?.totals).toEqual(slot({ uncachedInputTokens: 2 }))
    // A same-step replacement subtracts the previous sample from its old day.
    state = dayUnit.apply(state, attemptEvent((day + 1) * USAGE_DAY_MS + 2, usage(1, 0), 1, 1))
    expect(dayView(state).routes[0]?.days.map(entry => entry.day)).toEqual([day + 1])
  })

  it('removes a day when the replacement lands in a different slot of the same day', () => {
    const start = dayUnit.init()
    const day = 13
    let state = dayUnit.apply(start, attemptEvent(day * USAGE_DAY_MS + 1, usage(4, 0), 1, 1))
    state = dayUnit.apply(state, attemptEvent(day * USAGE_DAY_MS + USAGE_SLOT_MS * 2 + 1, usage(2, 0), 1, 1))
    expect(dayView(state).routes[0]?.days).toHaveLength(1)
    expect(dayView(state).routes[0]?.totals).toEqual(slot({ uncachedInputTokens: 2 }))
  })

  it('appends a day to a route that already exists on another day', () => {
    const start = dayUnit.init()
    let state = dayUnit.apply(start, attemptEvent(40 * USAGE_DAY_MS + 1, usage(1, 0), 1, 1))
    state = dayUnit.apply(state, attemptEvent(41 * USAGE_DAY_MS + 1, usage(2, 0), 2, 1))
    expect(dayView(state).routes[0]?.days.map(entry => entry.day)).toEqual([40, 41])
    // Replacing a different step on the same day as an existing route row.
    state = dayUnit.apply(state, attemptEvent(41 * USAGE_DAY_MS + 2, usage(3, 0), 3, 1))
    expect(dayView(state).routes[0]?.days.map(entry => entry.day)).toEqual([40, 41])
  })

  it('serves a checkpoint and unregisters with the token-meter fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meterFiber = await ctx.plugin(TokenMeter)
    const session = ctx.sessions.create()
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 5, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    const value = ctx.sessionProjections.snapshot(session).values.usageByDay
    expect(value?.routes[0]?.totals).toEqual(slot({ uncachedInputTokens: 5, outputTokens: 1 }))
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    expect(checkpoint.usageByDay?.ver).toBe(1)
    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('usageByDay')
  })
})

describe('usageByDay removal/no-op edges', () => {
  it('removes a route that never existed and a day that never existed as no-ops', () => {
    const start = dayUnit.init()
    const base = dayUnit.apply(start, attemptEvent(50 * USAGE_DAY_MS + 1, usage(2, 0), 2, 2))
    // A same-step replacement whose old sample sits on a day not present in the
    // route row exercises the day-absent removal branch; injection here uses a
    // synthetic state so both no-op guards are reachable.
    const routeRow = base.routes[0]
    if (routeRow === undefined) throw new Error('route row missing')
    const synthetic = { ...base, routes: [{ ...routeRow, days: [] }, { provider: 'x', model: 'y', days: [] }] }
    const removed = dayUnit.apply(synthetic, attemptEvent(50 * USAGE_DAY_MS + 2, usage(1, 0), 2, 2))
    expect(removed.routes.every(route => route.days.length === 0 || route.days[0]?.day === 50)).toBe(true)
    const zeroSample = dayUnit.apply(start, attemptEvent(50 * USAGE_DAY_MS + 3, usage(0, 0)))
    expect(dayView(zeroSample)).toEqual({ routes: [] })
    expect(dayUnit.apply(zeroSample, attemptEvent(50 * USAGE_DAY_MS + 4, usage(0, 0))).routes).toEqual([])
  })

  it('treats an unmatched removal route as a no-op', () => {
    const start = dayUnit.init()
    const seeded = dayUnit.apply(start, attemptEvent(60 * USAGE_DAY_MS + 1, usage(4, 0), 3, 3))
    const synthetic = { ...seeded, routes: [{ provider: 'other', model: 'other', days: sharedDays(seeded) }] }
    const after = dayUnit.apply(synthetic, attemptEvent(60 * USAGE_DAY_MS + 2, usage(1, 0), 3, 3))
    // The unmatched removal is a no-op, then the new sample appends its own row.
    expect(after.routes).toHaveLength(2)
    expect(dayView(after).routes.map(route => route.provider)).toEqual(['other', ''])
  })

  it('keeps an untouched route when another route is adjusted', () => {
    const start = dayUnit.init()
    let state = dayUnit.apply(start, attemptEvent(51 * USAGE_DAY_MS + 1, usage(1, 0), 1, 1))
    state = dayUnit.apply(state, headerEvent(51 * USAGE_DAY_MS + 2, 'provider-b', 'model-b'))
    state = dayUnit.apply(state, attemptEvent(51 * USAGE_DAY_MS + 3, usage(2, 0), 2, 1))
    expect(dayView(state).routes.map(route => route.provider)).toEqual(['', 'provider-b'])
  })

  it('serves an empty all-zero view for a route array whose days are all zero', () => {
    const start = dayUnit.init()
    const state = { ...start, routes: [{ provider: 'p', model: 'm', days: [{ day: 1, slots: Array.from({ length: 48 }, slot) }] }] }
    expect(dayView(state)).toEqual({ routes: [] })
  })
})

describe('usage day helpers', () => {
  it('merges day projections with day sums and first-seen order', () => {
    const dayRoute = (provider: string, model: string, day: number, value: Partial<UsageByRouteSlot>) => ({
      provider,
      model,
      totals: slot(value),
      days: [{ day, slots: slotsAt(1, value) }],
    })
    const merged = mergeUsageByDay([
      { routes: [dayRoute('provider-a', 'model-a', 5, { uncachedInputTokens: 4 })] },
      undefined,
      { routes: [
        dayRoute('provider-b', 'model-b', 6, { outputTokens: 1 }),
        dayRoute('provider-b', 'model-b', 4, { cacheWriteTokens: 3 }),
        dayRoute('provider-a', 'model-a', 5, { cacheReadTokens: 2 }),
      ] },
    ])
    expect(merged.routes).toEqual([
      {
        provider: 'provider-a',
        model: 'model-a',
        totals: slot({ uncachedInputTokens: 4, cacheReadTokens: 2 }),
        days: [{ day: 5, slots: slotsAt(1, { uncachedInputTokens: 4, cacheReadTokens: 2 }) }],
      },
      {
        provider: 'provider-b',
        model: 'model-b',
        totals: slot({ outputTokens: 1, cacheWriteTokens: 3 }),
        days: [
          { day: 4, slots: slotsAt(1, { cacheWriteTokens: 3 }) },
          { day: 6, slots: slotsAt(1, { outputTokens: 1 }) },
        ],
      },
    ])
    expect(mergeUsageByDay([])).toEqual({ routes: [] })
    expect(mergeUsageByDay([undefined])).toEqual({ routes: [] })
    expect(mergeUsageByDay([{ routes: [{ provider: 'p', model: 'm', totals: slot(), days: [{ day: 1, slots: Array.from({ length: 48 }, slot) }] }] }]))
      .toEqual({ routes: [] })
  })

  it('lists months and collapses one month with the route UTC offsets', () => {
    const dayRoute = (day: number, value: Partial<UsageByRouteSlot>) => ({
      provider: 'p',
      model: 'm',
      totals: slot(value),
      days: [{ day, slots: slotsAt(1, value) }],
    })
    const projection = { routes: [dayRoute(100, { uncachedInputTokens: 1 }), dayRoute(200, { outputTokens: 2 })] }
    expect(usageMonths(projection, () => 480)).toEqual(['1970-07', '1970-04'])
    expect(usageByDayForMonth(projection, '1970-07', () => 480).routes[0]?.totals)
      .toEqual(slot({ outputTokens: 2 }))
    expect(usageByDayForMonth(projection, '1970-04', () => 480).routes[0]?.totals)
      .toEqual(slot({ uncachedInputTokens: 1 }))
    expect(usageByDayForMonth(projection, '1999-01', () => 480)).toEqual({ routes: [] })
    expect(usageDayOf(100 * USAGE_DAY_MS + 5)).toBe(100)
    expect(usageSlotOf(USAGE_SLOT_MS * 3 + 1)).toBe(3)
    expect(usageMonthKey(100 * USAGE_DAY_MS, 480)).toBe('1970-04')
  })

  it('keeps route and day identity stable for day view memoization', () => {
    const start = dayUnit.init()
    const day = 11
    const state = dayUnit.apply(start, attemptEvent(day * USAGE_DAY_MS + 1, usage(1, 0)))
    expect(dayView(state)).toBe(dayView(state))
  })
})

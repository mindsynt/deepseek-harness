/**
 * Durable per-route provider usage bucketed by UTC day and half-hour slot.
 *
 * The route/days shape exists so browser surfaces can aggregate calendar
 * months without retaining one bucket per session. Slot 0 starts at 00:00 UTC;
 * a consumer applies the route's UTC offset when assigning a slot to a local
 * month.
 *
 * @module @deepseek-ai/dsh-token-meter/usage-by-day
 */

import { z } from 'zod'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: activates the llm-retry SessionEventMap merge (`llm/retry-started`).
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import { usageBuckets, usageBucketsSchema, usageOf } from './usage-projection.ts'
import {
  addSlot, slotIsZero, slotsAreZero, USAGE_SLOTS_PER_DAY, usageDayOf, usageSlotOf, zeroSlot, zeroSlots,
} from './usage-merge.ts'
import type { UsageByRouteSlot } from './usage-by-route.ts'

/** One UTC day's half-hour buckets for one route. */
export interface UsageByDayBucket {
  /** UTC day number: floor(event.time / one day). */
  day: number
  /** Exactly 48 half-hour buckets for that UTC day. */
  slots: readonly UsageByRouteSlot[]
}

/** One route's usage grouped by UTC day. */
export interface UsageByDayEntry {
  /** Provider route that carried the usage. */
  provider: string
  /** Exact model id that carried the usage. */
  model: string
  /** Sum of every bucket across {@link days}. */
  totals: UsageByRouteSlot
  /** Days with at least one non-zero bucket, ascending. */
  days: readonly UsageByDayBucket[]
}

/** Client-visible day-bucketed usage projection. */
export interface UsageByDayProjection {
  /** Routes with at least one non-zero bucket, in first-seen order. */
  routes: readonly UsageByDayEntry[]
}

interface RouteRef {
  provider: string
  model: string
}

interface DayState {
  day: number
  slots: UsageByRouteSlot[]
}

interface UsageByDayRouteState extends RouteRef {
  days: DayState[]
}

interface UsageByDaySample extends RouteRef {
  turn: number
  step: number
  day: number
  slot: number
  buckets: UsageByRouteSlot
}

interface UsageByDayState {
  headerProvider: string
  headerModel: string
  routes: readonly UsageByDayRouteState[]
  last: UsageByDaySample | null
}

const UNKNOWN_ROUTE: RouteRef = { provider: '', model: '' }

const dayStateSchema = z.object({
  day: z.number().int().nonnegative(),
  slots: z.array(usageBucketsSchema).length(USAGE_SLOTS_PER_DAY),
}).strict()

const dayViewSchema = z.object({
  day: z.number().int().nonnegative(),
  slots: z.array(usageBucketsSchema).length(USAGE_SLOTS_PER_DAY),
}).strict()

/* jscpd:ignore-start -- mirrored usageByRoute state/replacement contract is deliberate */
const usageByDayStateSchema: z.ZodType<UsageByDayState> = z.object({
  headerProvider: z.string(),
  headerModel: z.string(),
  routes: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    days: z.array(dayStateSchema),
  }).strict()),
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    provider: z.string(),
    model: z.string(),
    day: z.number().int().nonnegative(),
    slot: z.number().int().min(0).max(USAGE_SLOTS_PER_DAY - 1),
    buckets: usageBucketsSchema,
  }).strict().nullable(),
}).strict()

const usageByDayViewSchema: z.ZodType<UsageByDayProjection> = z.object({
  routes: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    totals: usageBucketsSchema,
    days: z.array(dayViewSchema),
  }).strict()),
}).strict()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Per-route provider usage grouped by UTC day for calendar summaries. */
    usageByDay: UsageByDayProjection
  }
  interface SessionProjectionStateMap {
    usageByDay: UsageByDayState
  }
}

/** The route one assistant message names, or the unknown route when it names none. */
function messageRoute(message: AssistantMessage): RouteRef {
  const { provider, model } = message.source
  return provider.length > 0 && model.length > 0 ? { provider, model } : UNKNOWN_ROUTE
}

/** Field-wise equality of two replacement samples. */
function sameSample(previous: UsageByDaySample | null, next: UsageByDaySample): boolean {
  return previous !== null
    && previous.turn === next.turn
    && previous.step === next.step
    && previous.provider === next.provider
    && previous.model === next.model
    && previous.day === next.day
    && previous.slot === next.slot
    && slotIdentical(previous.buckets, next.buckets)
}

/** Field-wise equality of two usage buckets. */
function slotIdentical(left: UsageByRouteSlot, right: UsageByRouteSlot): boolean {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

/** Whether a delta removes usage rather than adds it. */
function isRemoval(delta: UsageByRouteSlot): boolean {
  return delta.uncachedInputTokens < 0
}

/** One fresh route row seeded with a single day slot. */
function firstRoute(
  provider: string,
  model: string,
  day: number,
  slotIndex: number,
  delta: UsageByRouteSlot,
): UsageByDayRouteState {
  return { provider, model, days: [firstDay(day, slotIndex, delta)] }
}

/** One fresh day row seeded with a single slot. */
function firstDay(day: number, slotIndex: number, delta: UsageByRouteSlot): DayState {
  const slots = zeroSlots(USAGE_SLOTS_PER_DAY)
  slots[slotIndex] = { ...delta }
  return { day, slots }
}

/** Add `delta` to one route/day slot, appending route and day on first use. */
function adjustRoute(
  routes: readonly UsageByDayRouteState[],
  provider: string,
  model: string,
  day: number,
  slotIndex: number,
  delta: UsageByRouteSlot,
): readonly UsageByDayRouteState[] {
  if (slotIsZero(delta)) return routes
  const removal = isRemoval(delta)
  const routeIndex = routes.findIndex(route => route.provider === provider && route.model === model)
  if (routeIndex === -1) {
    // A removal against a route not present in the row is a no-op.
    return removal ? routes : [...routes, firstRoute(provider, model, day, slotIndex, delta)]
  }
  return routes.map((route, index) => {
    if (index !== routeIndex) return route
    const dayIndex = route.days.findIndex(entry => entry.day === day)
    if (dayIndex === -1) {
      if (removal) return route
      return {
        ...route,
        days: [...route.days, firstDay(day, slotIndex, delta)].sort((a, b) => a.day - b.day),
      }
    }
    // The day index was just found in this array.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const slots = route.days[dayIndex]!.slots.map((slot, at) => at === slotIndex ? addSlot(slot, delta) : slot)
    const days = slotsAreZero(slots)
      ? route.days.filter((_entry, at) => at !== dayIndex)
      : route.days.map((entry, at) => at === dayIndex ? { day, slots } : entry)
    return { ...route, days }
  })
}

/** Sum one route's day buckets into its entry totals. */
function totalDays(route: UsageByDayRouteState): UsageByRouteSlot {
  const totals = zeroSlot()
  for (const day of route.days) {
    for (const slot of day.slots) {
      totals.uncachedInputTokens += slot.uncachedInputTokens
      totals.outputTokens += slot.outputTokens
      totals.cacheReadTokens += slot.cacheReadTokens
      totals.cacheWriteTokens += slot.cacheWriteTokens
    }
  }
  return totals
}

/**
 * Published views keyed by the immutable route array they were built from, so
 * a state change that leaves route content untouched keeps the exact view
 * reference the change feed compares with `Object.is`.
 */
const views = new WeakMap<readonly UsageByDayRouteState[], UsageByDayProjection>()

/** Whole client view: routes with non-zero days in state order. */
function viewUsageByDay(state: UsageByDayState): UsageByDayProjection {
  const cached = views.get(state.routes)
  if (cached !== undefined) return cached
  const routes: UsageByDayEntry[] = []
  for (const route of state.routes) {
    const totals = totalDays(route)
    const days = route.days.filter(day => !slotsAreZero(day.slots))
    if (days.length === 0) continue
    routes.push({ provider: route.provider, model: route.model, totals, days })
  }
  const projection = { routes }
  views.set(state.routes, projection)
  return projection
}

/**
 * Token-meter's day-bucketed session projection unit.
 *
 * It mirrors the `usageByRoute` replacement contract: each usage sample
 * replaces the previous sample for the same turn/step, and
 * `llm/retry-started` ends that replacement scope so a retried attempt adds
 * another billed request. Buckets use the settlement event's UTC day.
 */
export const usageByDayProjectionDefinition = {
  key: 'usageByDay',
  stateVersion: 1,
  stateSchema: usageByDayStateSchema,
  init: (): UsageByDayState => ({
    headerProvider: '',
    headerModel: '',
    routes: [],
    last: null,
  }),
  apply: (state, event) => {
    if (event.type === 'request/header') {
      const { provider, model } = event.data.header.config
      return provider === state.headerProvider && model === state.headerModel
        ? state
        : { ...state, headerProvider: provider, headerModel: model }
    }
    if (event.type === 'llm/retry-started') {
      return state.last?.turn === event.data.turn && state.last.step === event.data.step
        ? { ...state, last: null }
        : state
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
    const usage = usageOf(event)
    if (usage === undefined) return state
    const route = event.type === 'assistant/message'
      ? messageRoute(event.data.message)
      : { provider: state.headerProvider, model: state.headerModel }
    const buckets = usageBuckets(usage)
    const day = usageDayOf(event.time)
    const slot = usageSlotOf(event.time)
    const { turn, step } = event.data
    const previous = state.last !== null && state.last.turn === turn && state.last.step === step
      ? state.last
      : undefined
    const routesAfterRemoval = previous === undefined
      ? state.routes
      : adjustRoute(state.routes, previous.provider, previous.model, previous.day, previous.slot, {
        uncachedInputTokens: -previous.buckets.uncachedInputTokens,
        outputTokens: -previous.buckets.outputTokens,
        cacheReadTokens: -previous.buckets.cacheReadTokens,
        cacheWriteTokens: -previous.buckets.cacheWriteTokens,
      })
    const routes = adjustRoute(routesAfterRemoval, route.provider, route.model, day, slot, buckets)
    const last = { turn, step, provider: route.provider, model: route.model, day, slot, buckets }
    return sameSample(state.last, last) && routes === state.routes
      ? state
      : { ...state, routes, last }
  },
  wire: { viewSchema: usageByDayViewSchema, view: viewUsageByDay },
} satisfies ProjectionDefinition<'usageByDay', UsageByDayState>
/* jscpd:ignore-end */

/**
 * Durable per-route provider usage bucketed into half-hour UTC-day slots.
 *
 * @module @deepseek-ai/dsh-token-meter/usage-by-route
 */

import { z } from 'zod'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: activates the llm-retry SessionEventMap merge (`llm/retry-started`).
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import { usageBuckets, usageBucketsSchema, usageOf } from './usage-projection.ts'
import { addSlot, slotIsZero, USAGE_SLOTS_PER_DAY, usageSlotOf, zeroSlot, zeroSlots } from './usage-merge.ts'

/** One route's disjoint usage buckets within a single half-hour slot. */
export interface UsageByRouteSlot {
  /** Uncached prompt input tokens. */
  uncachedInputTokens: number
  /** Output tokens; reasoning is already included here, never counted again. */
  outputTokens: number
  /** Prompt-cache read tokens. */
  cacheReadTokens: number
  /** Prompt-cache write tokens, billed like uncached input. */
  cacheWriteTokens: number
}

/** One route's accumulated usage and its half-hour UTC-day buckets. */
export interface UsageByRouteEntry {
  /** Provider route that carried the usage. */
  provider: string
  /** Exact model id that carried the usage. */
  model: string
  /** Sum of every bucket across {@link slots}. */
  totals: UsageByRouteSlot
  /** Exactly 48 half-hour buckets for one UTC day; index 0 starts at 00:00 UTC. */
  slots: readonly UsageByRouteSlot[]
}

/** Client-visible per-route usage projection. */
export interface UsageByRouteProjection {
  /** Routes with at least one non-zero bucket, in first-seen order. */
  routes: readonly UsageByRouteEntry[]
}

/** Provider/model identity one sample was attributed to. */
interface RouteKey {
  provider: string
  model: string
}

interface UsageByRouteRouteState extends RouteKey {
  /** 48 half-hour UTC-day buckets, index 0 at 00:00 UTC. */
  slots: UsageByRouteSlot[]
}

/** The replacement slot for one turn/step: the sample most recently folded into `routes`. */
interface UsageByRouteSample extends RouteKey {
  turn: number
  step: number
  /** UTC half-hour bucket index the sample was added to. */
  slot: number
  buckets: UsageByRouteSlot
}

interface UsageByRouteState {
  /** Latest `request/header` provider; empty until one is seen. */
  headerProvider: string
  /** Latest `request/header` model; empty until one is seen. */
  headerModel: string
  /** Routes in first-seen order; all-zero routes remain until their slots return. */
  routes: readonly UsageByRouteRouteState[]
  /** Same turn/step replacement slot; `llm/retry-started` clears it. */
  last: UsageByRouteSample | null
}

const UNKNOWN_ROUTE: RouteKey = { provider: '', model: '' }

const usageByRouteStateSchema: z.ZodType<UsageByRouteState> = z.object({
  headerProvider: z.string(),
  headerModel: z.string(),
  routes: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    slots: z.array(usageBucketsSchema).length(USAGE_SLOTS_PER_DAY),
  }).strict()),
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    provider: z.string(),
    model: z.string(),
    slot: z.number().int().min(0).max(USAGE_SLOTS_PER_DAY - 1),
    buckets: usageBucketsSchema,
  }).strict().nullable(),
}).strict()

const usageByRouteViewSchema: z.ZodType<UsageByRouteProjection> = z.object({
  routes: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    totals: usageBucketsSchema,
    slots: z.array(usageBucketsSchema).length(USAGE_SLOTS_PER_DAY),
  }).strict()),
}).strict()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Per-route provider usage bucketed into half-hour UTC-day slots. */
    usageByRoute: UsageByRouteProjection
  }
  interface SessionProjectionStateMap {
    usageByRoute: UsageByRouteState
  }
}

/** Field-wise equality of two slots. */
function slotEquals(left: UsageByRouteSlot, right: UsageByRouteSlot): boolean {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

/** Negate one slot's buckets for removing a replaced sample. */
function negateSlot(slot: UsageByRouteSlot): UsageByRouteSlot {
  return {
    uncachedInputTokens: -slot.uncachedInputTokens,
    outputTokens: -slot.outputTokens,
    cacheReadTokens: -slot.cacheReadTokens,
    cacheWriteTokens: -slot.cacheWriteTokens,
  }
}

/** The route one assistant message names, or the unknown route when it names none. */
function messageRoute(message: AssistantMessage): RouteKey {
  const { provider, model } = message.source
  return provider.length > 0 && model.length > 0 ? { provider, model } : UNKNOWN_ROUTE
}

/** Add `delta` to one route's slot, appending the route on first use. */
function adjustRoute(
  routes: readonly UsageByRouteRouteState[],
  provider: string,
  model: string,
  slotIndex: number,
  delta: UsageByRouteSlot,
): readonly UsageByRouteRouteState[] {
  if (slotIsZero(delta)) return routes
  const routeIndex = routes.findIndex(route => route.provider === provider && route.model === model)
  if (routeIndex === -1) {
    const slots = zeroSlots(USAGE_SLOTS_PER_DAY)
    slots[slotIndex] = { ...delta }
    return [...routes, { provider, model, slots }]
  }
  return routes.map((route, index) => index === routeIndex
    ? {
      provider: route.provider,
      model: route.model,
      slots: route.slots.map((slot, slotIndex_) => slotIndex_ === slotIndex ? addSlot(slot, delta) : slot),
    }
    : route)
}

/** Whether the previous replacement slot describes the same sample as the next one. */
function sameSample(previous: UsageByRouteSample | null, next: UsageByRouteSample): boolean {
  return previous !== null
    && previous.turn === next.turn
    && previous.step === next.step
    && previous.provider === next.provider
    && previous.model === next.model
    && previous.slot === next.slot
    && slotEquals(previous.buckets, next.buckets)
}

/** Sum one route's 48 buckets into its entry totals. */
function totalSlots(route: UsageByRouteRouteState): UsageByRouteSlot {
  const totals = zeroSlot()
  for (const slot of route.slots) {
    totals.uncachedInputTokens += slot.uncachedInputTokens
    totals.outputTokens += slot.outputTokens
    totals.cacheReadTokens += slot.cacheReadTokens
    totals.cacheWriteTokens += slot.cacheWriteTokens
  }
  return totals
}

/**
 * Published views keyed by the immutable route array they were built from, so
 * a state change that leaves route content untouched keeps the exact view
 * reference the change feed compares with `Object.is`.
 */
const views = new WeakMap<readonly UsageByRouteRouteState[], UsageByRouteProjection>()

/** Whole client view: non-zero routes in state order. */
function viewUsageByRoute(state: UsageByRouteState): UsageByRouteProjection {
  const cached = views.get(state.routes)
  if (cached !== undefined) return cached
  const routes: UsageByRouteEntry[] = []
  for (const route of state.routes) {
    const totals = totalSlots(route)
    if (slotIsZero(totals)) continue
    routes.push({ provider: route.provider, model: route.model, totals, slots: route.slots })
  }
  const projection = { routes }
  views.set(state.routes, projection)
  return projection
}

/**
 * Token-meter's per-route session projection unit.
 *
 * It mirrors the `tokenUsage` fold: every `assistant/message` or
 * `assistant/attempt` usage sample replaces the previous sample for the same
 * turn/step, and `llm/retry-started` clears that slot so a retried attempt
 * accumulates instead. `assistant/message` attributes the sample to the
 * message's provider/model and `assistant/attempt` to the latest
 * `request/header` config, with `{ provider: '', model: '' }` when neither
 * names one. Buckets use the settlement event's time in UTC half-hour slots.
 */
export const usageByRouteProjectionDefinition = {
  key: 'usageByRoute',
  stateVersion: 1,
  stateSchema: usageByRouteStateSchema,
  init: (): UsageByRouteState => ({
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
    const slot = usageSlotOf(event.time)
    const { turn, step } = event.data
    const previous = state.last !== null && state.last.turn === turn && state.last.step === step
      ? state.last
      : undefined
    const last = { turn, step, provider: route.provider, model: route.model, slot, buckets }
    // The same sample restated is not a replacement: mirroring the tokenUsage
    // fold keeps the state (and therefore the cached view) untouched.
    if (previous !== undefined && sameSample(previous, last)) return state
    const routesAfterRemoval = previous === undefined
      ? state.routes
      : adjustRoute(state.routes, previous.provider, previous.model, previous.slot, negateSlot(previous.buckets))
    const routes = adjustRoute(routesAfterRemoval, route.provider, route.model, slot, buckets)
    // No route delta means only the replacement slot moved; the same-sample
    // shortcut above proved that still needs publishing.
    return routes === state.routes
      ? { ...state, last }
      : { ...state, routes, last }
  },
  wire: { viewSchema: usageByRouteViewSchema, view: viewUsageByRoute },
} satisfies ProjectionDefinition<'usageByRoute', UsageByRouteState>

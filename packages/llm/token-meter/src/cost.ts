/**
 * Client-side cost estimation for turn usage and the per-route projection.
 *
 * @module @deepseek-ai/dsh-token-meter/cost
 */

import type { LlmModelPricing, LlmTimeOfDayPrice } from '@deepseek-ai/dsh-llm/types'
import type { TurnAttemptUsage, TurnTokenUsage, TurnTokenUsageRoute } from './turn-usage.ts'
import type { UsageByRouteProjection, UsageByRouteSlot } from './usage-by-route.ts'

/** Duration of one half-hour projection bucket in milliseconds. */
export const USAGE_SLOT_MS = 30 * 60 * 1000

/** Resolve a route's per-million-token prices; undefined means no price is known. */
export type ModelPricingLookup = (provider: string, model: string) => LlmModelPricing | undefined

/** Whether an estimate carries an exact amount or cannot be priced. */
export type CostEstimate =
  | { readonly kind: 'priced'; readonly amount: number }
  | { readonly kind: 'unpriced' }

/** Tokens and money attributed to one billing bucket. */
export interface UsageCostPart {
  /** Disjoint tokens billed at this bucket's rate. */
  readonly tokens: number
  /** Money for those tokens under the selected band/rates. */
  readonly amount: number
}

/**
 * Per-bucket breakdown of one per-route projection's estimate.
 *
 * `cacheMiss` covers uncached input and cache-write tokens, the two buckets
 * billed at the miss rate.
 */
export type UsageCostBreakdown =
  | {
    readonly kind: 'priced'
    readonly amount: number
    readonly cacheMiss: UsageCostPart
    readonly cacheHit: UsageCostPart
    readonly output: UsageCostPart
  }
  | { readonly kind: 'unpriced' }

const BASE_UTC_OFFSET_MINUTES = 480
const MINUTES_PER_DAY = 24 * 60
const MS_PER_MINUTE = 60 * 1000
const TOKENS_PER_PRICE_UNIT = 1_000_000

const UNPRICED: CostEstimate = { kind: 'unpriced' }
const UNPRICED_BREAKDOWN: UsageCostBreakdown = { kind: 'unpriced' }

/** The three per-million-token rates a band or base price supplies. */
type PriceRates = Pick<LlmModelPricing, 'inputCacheHit' | 'inputCacheMiss' | 'output'>

/** Minute-of-day selected by one instant under a route's UTC offset. */
function minuteOfDay(timeMs: number, utcOffsetMinutes: number): number {
  const shifted = Math.floor(timeMs / MS_PER_MINUTE) + utcOffsetMinutes
  return ((shifted % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
}

/** Minutes since midnight of one `HH:mm` string. */
function clockMinutes(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))
}

/** Whether one instant's minute-of-day falls inside `[start, end)`, wrapping when `end < start`. */
function bandContains(band: LlmTimeOfDayPrice, minute: number): boolean {
  const start = clockMinutes(band.start)
  const end = clockMinutes(band.end)
  if (start < end) return minute >= start && minute < end
  if (end < start) return minute >= start || minute < end
  return false
}

/** First matching band's rates at `timeMs`, or the base rates when no band matches. */
function ratesAt(pricing: LlmModelPricing, timeMs: number): PriceRates {
  const minute = minuteOfDay(timeMs, pricing.utcOffsetMinutes ?? BASE_UTC_OFFSET_MINUTES)
  for (const band of pricing.timeBands ?? []) {
    if (bandContains(band, minute)) return band
  }
  return pricing
}

/** Whether every disjoint token bucket is empty. */
function slotIsZero(slot: UsageByRouteSlot): boolean {
  return slot.uncachedInputTokens === 0
    && slot.outputTokens === 0
    && slot.cacheReadTokens === 0
    && slot.cacheWriteTokens === 0
}

/** Cost of one bucket under already-selected rates. */
function slotCost(slot: UsageByRouteSlot, rates: PriceRates): number {
  return (
    (slot.uncachedInputTokens + slot.cacheWriteTokens) * rates.inputCacheMiss
    + slot.cacheReadTokens * rates.inputCacheHit
    + slot.outputTokens * rates.output
  ) / TOKENS_PER_PRICE_UNIT
}

/**
 * Estimate one completed Turn's cost from its per-attempt samples.
 *
 * A turn without attempt samples cannot be priced because no sample carries a
 * settlement time or route. Any attempt missing a route (with no fallback) or
 * route pricing makes the whole estimate unpriced rather than silently
 * omitting spend. A failed or retried attempt can disclose no message route,
 * so the caller may pass the route that closed the turn as a fallback; an
 * attempt that did disclose a route always keeps it.
 * @param usage - completed-turn usage, including per-attempt samples when available.
 * @param lookup - synchronous route pricing lookup.
 * @param fallbackRoute - route to price attempts that disclosed none.
 * @returns the exact priced amount, or `unpriced` when a required route price is unknown.
 */
export function estimateTurnCost(
  usage: TurnTokenUsage,
  lookup: ModelPricingLookup,
  fallbackRoute?: TurnTokenUsageRoute,
): CostEstimate {
  const attempts = usage.attempts
  if (attempts === undefined) return UNPRICED
  let amount = 0
  for (const attempt of attempts) {
    const route = attempt.route ?? fallbackRoute
    if (route === undefined) return UNPRICED
    const pricing = lookup(route.provider, route.model)
    if (pricing === undefined) return UNPRICED
    amount += attemptCost(attempt, pricing)
  }
  return { kind: 'priced', amount }
}

/** Price one attempt under its own settlement time's band. */
function attemptCost(attempt: TurnAttemptUsage, pricing: LlmModelPricing): number {
  return slotCost({
    uncachedInputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    cacheReadTokens: attempt.cacheReadTokens ?? 0,
    cacheWriteTokens: attempt.cacheWriteTokens ?? 0,
  }, ratesAt(pricing, attempt.time))
}

/** Whether at least one bucket of a route carries usage. */
function routeHasUsage(slots: readonly UsageByRouteSlot[]): boolean {
  return slots.some(slot => !slotIsZero(slot))
}

/**
 * Estimate the cost of a per-route projection with its bucket breakdown.
 *
 * Zero routes are skipped without a lookup; any route carrying usage whose
 * route has no pricing makes the whole estimate unpriced. Each bucket's
 * subtotal uses the band selected by its own half-hour slot.
 * @param projection - client-visible per-route usage view.
 * @param lookup - synchronous route pricing lookup.
 * @returns the exact breakdown, or `unpriced` when a billed route's price is unknown.
 */
export function estimateUsageByRouteBreakdown(
  projection: UsageByRouteProjection,
  lookup: ModelPricingLookup,
): UsageCostBreakdown {
  let cacheMissTokens = 0
  let cacheMissAmount = 0
  let cacheHitTokens = 0
  let cacheHitAmount = 0
  let outputTokens = 0
  let outputAmount = 0
  for (const route of projection.routes) {
    if (!routeHasUsage(route.slots)) continue
    const pricing = lookup(route.provider, route.model)
    if (pricing === undefined) return UNPRICED_BREAKDOWN
    for (const [index, slot] of route.slots.entries()) {
      if (slotIsZero(slot)) continue
      const rates = ratesAt(pricing, index * USAGE_SLOT_MS)
      const billedMissTokens = slot.uncachedInputTokens + slot.cacheWriteTokens
      cacheMissTokens += billedMissTokens
      cacheMissAmount += billedMissTokens * rates.inputCacheMiss / TOKENS_PER_PRICE_UNIT
      cacheHitTokens += slot.cacheReadTokens
      cacheHitAmount += slot.cacheReadTokens * rates.inputCacheHit / TOKENS_PER_PRICE_UNIT
      outputTokens += slot.outputTokens
      outputAmount += slot.outputTokens * rates.output / TOKENS_PER_PRICE_UNIT
    }
  }
  return {
    kind: 'priced',
    amount: cacheMissAmount + cacheHitAmount + outputAmount,
    cacheMiss: { tokens: cacheMissTokens, amount: cacheMissAmount },
    cacheHit: { tokens: cacheHitTokens, amount: cacheHitAmount },
    output: { tokens: outputTokens, amount: outputAmount },
  }
}

/**
 * Estimate the cost of a per-route projection.
 *
 * Zero routes are skipped without a lookup; any route carrying usage whose
 * route has no pricing makes the whole estimate unpriced.
 * @param projection - client-visible per-route usage view.
 * @param lookup - synchronous route pricing lookup.
 * @returns the exact priced amount, or `unpriced` when a billed route's price is unknown.
 */
export function estimateUsageByRouteCost(
  projection: UsageByRouteProjection,
  lookup: ModelPricingLookup,
): CostEstimate {
  const breakdown = estimateUsageByRouteBreakdown(projection, lookup)
  return breakdown.kind === 'priced' ? { kind: 'priced', amount: breakdown.amount } : UNPRICED
}

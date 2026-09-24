import { describe, expect, it } from 'vitest'
import type { LlmModelPricing } from '@deepseek-ai/dsh-llm/types'
import {
  USAGE_SLOT_MS,
  estimateTurnCost,
  estimateUsageByRouteBreakdown,
  estimateUsageByRouteCost,
} from '@deepseek-ai/dsh-token-meter/client'
import type {
  ModelPricingLookup,
  TurnAttemptUsage,
  TurnTokenUsage,
  UsageByRouteProjection,
  UsageByRouteSlot,
} from '@deepseek-ai/dsh-token-meter/client'

const BASE: LlmModelPricing = { inputCacheHit: 1, inputCacheMiss: 2, output: 3 }

function slot(overrides: Partial<UsageByRouteSlot> = {}): UsageByRouteSlot {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  }
}

function slotsWith(index: number, value: UsageByRouteSlot): UsageByRouteSlot[] {
  return Array.from({ length: 48 }, (_unused, slotIndex) => slotIndex === index ? value : slot())
}

const pricedRoute: ModelPricingLookup = (provider, model) =>
  provider === 'priced' && model === 'm' ? BASE : undefined

function turn(attempts?: readonly TurnAttemptUsage[]): TurnTokenUsage {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ...attempts === undefined ? {} : { attempts },
  }
}

describe('USAGE_SLOT_MS', () => {
  it('is one half hour', () => {
    expect(USAGE_SLOT_MS).toBe(30 * 60 * 1000)
  })
})

describe('estimateTurnCost', () => {
  it('is unpriced without attempt samples', () => {
    expect(estimateTurnCost({ uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0 }, pricedRoute))
      .toEqual({ kind: 'unpriced' })
  })

  it('prices an empty attempt list as zero', () => {
    expect(estimateTurnCost(turn([]), pricedRoute)).toEqual({ kind: 'priced', amount: 0 })
  })

  it('is unpriced when any attempt lacks a route or route pricing', () => {
    expect(estimateTurnCost(turn([
      { time: 0, inputTokens: 0, outputTokens: 0 },
    ]), pricedRoute)).toEqual({ kind: 'unpriced' })
    expect(estimateTurnCost(turn([
      { time: 0, inputTokens: 0, outputTokens: 0, route: { provider: 'unknown', model: 'x' } },
    ]), pricedRoute)).toEqual({ kind: 'unpriced' })
  })

  it('breaks a per-route projection into cache-miss, cache-hit, and output parts', () => {
    const projection = {
      routes: [{
        provider: 'banded',
        model: 'm',
        totals: slot(),
        slots: slotsWith(3, {
          uncachedInputTokens: 1_000_000,
          cacheReadTokens: 2_000_000,
          cacheWriteTokens: 500_000,
          outputTokens: 100_000,
        }),
      }],
    }
    const breakdown = estimateUsageByRouteBreakdown(projection, (_provider, model) => model !== 'm' ? undefined : {
      inputCacheHit: 0.2,
      inputCacheMiss: 2,
      output: 3,
      utcOffsetMinutes: 0,
      timeBands: [],
    })
    expect(breakdown).toMatchObject({
      kind: 'priced',
      cacheMiss: { tokens: 1_500_000, amount: 3 },
      cacheHit: { tokens: 2_000_000, amount: 0.4 },
      output: { tokens: 100_000, amount: 0.3 },
    })
    if (breakdown.kind === 'priced') expect(breakdown.amount).toBeCloseTo(3.7, 10)
    expect(estimateUsageByRouteBreakdown({ routes: [] }, () => undefined))
      .toEqual({ kind: 'priced', amount: 0, cacheMiss: { tokens: 0, amount: 0 }, cacheHit: { tokens: 0, amount: 0 }, output: { tokens: 0, amount: 0 } })
    expect(estimateUsageByRouteBreakdown(projection, () => undefined)).toEqual({ kind: 'unpriced' })
  })

  it('prices route-less attempts through the turn closing fallback route', () => {
    expect(estimateTurnCost(turn([
      { time: 0, inputTokens: 1_000_000, outputTokens: 0 },
      { time: 0, inputTokens: 0, outputTokens: 1_000_000, route: { provider: 'priced', model: 'm' } },
    ]), pricedRoute, { provider: 'priced', model: 'm' })).toEqual({ kind: 'priced', amount: 5 })
    // An explicit unknown route is not repaired by the fallback.
    expect(estimateTurnCost(turn([
      { time: 0, inputTokens: 0, outputTokens: 0, route: { provider: 'unknown', model: 'x' } },
    ]), pricedRoute, { provider: 'priced', model: 'm' })).toEqual({ kind: 'unpriced' })
  })

  it('sums disjoint buckets across attempts and defaults absent cache buckets to zero', () => {
    expect(estimateTurnCost(turn([
      {
        time: 0,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 500_000,
        route: { provider: 'priced', model: 'm' },
      },
      {
        time: 0,
        inputTokens: 1_000_000,
        outputTokens: 0,
        route: { provider: 'priced', model: 'm' },
      },
    ]), pricedRoute)).toEqual({ kind: 'priced', amount: 10 })
  })

  it('uses the first matching band, a wrapping band, and base prices when none match', () => {
    const hitFirst = estimateTurnCost(turn([{
      time: (8 * 60 + 30) * 60 * 1000,
      inputTokens: 1_000_000,
      outputTokens: 0,
      route: { provider: 'banded', model: 'm' },
    }]), (_provider, model) => model !== 'm' ? undefined : {
      ...BASE,
      utcOffsetMinutes: 0,
      timeBands: [
        { start: '08:00', end: '09:00', inputCacheHit: 1, inputCacheMiss: 1, output: 1 },
        { start: '08:30', end: '10:00', inputCacheHit: 2, inputCacheMiss: 2, output: 2 },
      ],
    })
    expect(hitFirst).toEqual({ kind: 'priced', amount: 1 })

    const wrapping = estimateTurnCost(turn([{
      time: 60 * 60 * 1000,
      inputTokens: 1_000_000,
      outputTokens: 0,
      route: { provider: 'wrapped', model: 'm' },
    }]), (_provider, model) => model !== 'm' ? undefined : {
      ...BASE,
      utcOffsetMinutes: 0,
      timeBands: [{ start: '22:00', end: '02:00', inputCacheHit: 5, inputCacheMiss: 5, output: 5 }],
    })
    expect(wrapping).toEqual({ kind: 'priced', amount: 5 })

    const emptyBand = estimateTurnCost(turn([{
      time: 0,
      inputTokens: 1_000_000,
      outputTokens: 0,
      route: { provider: 'empty-band', model: 'm' },
    }]), (_provider, model) => model !== 'm' ? undefined : {
      ...BASE,
      utcOffsetMinutes: 0,
      timeBands: [{ start: '00:00', end: '00:00', inputCacheHit: 9, inputCacheMiss: 9, output: 9 }],
    })
    expect(emptyBand).toEqual({ kind: 'priced', amount: 2 })
  })

  it('defaults the UTC offset to UTC+8', () => {
    const bands = {
      ...BASE,
      timeBands: [{ start: '08:00', end: '08:30', inputCacheHit: 7, inputCacheMiss: 7, output: 7 }],
    }
    const attempt = {
      time: 0,
      inputTokens: 1_000_000,
      outputTokens: 0,
      route: { provider: 'default-offset', model: 'm' },
    }
    expect(estimateTurnCost(turn([attempt]), () => bands)).toEqual({ kind: 'priced', amount: 7 })
    expect(estimateTurnCost(turn([attempt]), () => ({ ...bands, utcOffsetMinutes: 0 })))
      .toEqual({ kind: 'priced', amount: 2 })
  })
})

describe('estimateUsageByRouteCost', () => {
  it('prices nothing without a lookup when every route is zero', () => {
    let lookups = 0
    const projection: UsageByRouteProjection = {
      routes: [{ provider: 'zero', model: 'none', totals: slot(), slots: slotsWith(0, slot()) }],
    }
    expect(estimateUsageByRouteCost(projection, () => {
      lookups += 1
      return BASE
    })).toEqual({ kind: 'priced', amount: 0 })
    expect(lookups).toBe(0)
  })

  it('is unpriced when a route with usage has no pricing', () => {
    const projection: UsageByRouteProjection = {
      routes: [{
        provider: 'unknown',
        model: 'x',
        totals: slot({ uncachedInputTokens: 1 }),
        slots: slotsWith(0, slot({ uncachedInputTokens: 1 })),
      }],
    }
    expect(estimateUsageByRouteCost(projection, pricedRoute)).toEqual({ kind: 'unpriced' })
  })

  it('sums nonzero slots under base prices and skips zero slots', () => {
    const projection: UsageByRouteProjection = {
      routes: [{
        provider: 'priced',
        model: 'm',
        totals: slot({ uncachedInputTokens: 1_000_000 }),
        slots: slotsWith(0, slot({
          uncachedInputTokens: 1_000_000,
          cacheReadTokens: 2_000_000,
          cacheWriteTokens: 500_000,
          outputTokens: 1_000_000,
        })),
      }],
    }
    expect(estimateUsageByRouteCost(projection, pricedRoute)).toEqual({ kind: 'priced', amount: 8 })
  })

  it('selects each slot band from its half-hour UTC-day position', () => {
    const projection: UsageByRouteProjection = {
      routes: [{
        provider: 'banded',
        model: 'm',
        totals: slot({ uncachedInputTokens: 1_000_000 }),
        slots: slotsWith(16, slot({ uncachedInputTokens: 1_000_000 })),
      }],
    }
    expect(estimateUsageByRouteCost(projection, (_provider, model) => model !== 'm' ? undefined : {
      ...BASE,
      timeBands: [{ start: '16:00', end: '16:30', inputCacheHit: 5, inputCacheMiss: 5, output: 5 }],
    })).toEqual({ kind: 'priced', amount: 5 })
  })
})

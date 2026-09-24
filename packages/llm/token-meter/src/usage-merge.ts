/**
 * Browser-safe joining of per-route usage projections.
 *
 * Kept apart from the host projection module so client bundles never pull the
 * session/projection runtime in through a merge helper.
 *
 * @module @deepseek-ai/dsh-token-meter/usage-merge
 */

import { USAGE_SLOT_MS } from './cost.ts'
import type {
  UsageByDayBucket, UsageByDayEntry, UsageByDayProjection,
} from './usage-by-day.ts'
import type {
  UsageByRouteEntry, UsageByRouteProjection, UsageByRouteSlot,
} from './usage-by-route.ts'

/** Half-hour buckets in one UTC day. */
export const USAGE_SLOTS_PER_DAY = 48

/** Milliseconds in one UTC day. */
export const USAGE_DAY_MS = 86_400_000

/**
 * UTC day number of one instant.
 * @param timeMs - epoch milliseconds.
 * @returns floor(timeMs / one day).
 */
export function usageDayOf(timeMs: number): number {
  return Math.floor(timeMs / USAGE_DAY_MS)
}

/**
 * UTC half-hour bucket index of one instant.
 * @param timeMs - epoch milliseconds.
 * @returns bucket index in 0..47.
 */
export function usageSlotOf(timeMs: number): number {
  return ((Math.floor(timeMs / USAGE_SLOT_MS) % USAGE_SLOTS_PER_DAY) + USAGE_SLOTS_PER_DAY) % USAGE_SLOTS_PER_DAY
}

/**
 * Local month key of one instant under a UTC offset.
 * @param timeMs - epoch milliseconds.
 * @param utcOffsetMinutes - minutes added to UTC before reading the month.
 * @returns `YYYY-MM`.
 */
export function usageMonthKey(timeMs: number, utcOffsetMinutes: number): string {
  return new Date(timeMs + utcOffsetMinutes * 60_000).toISOString().slice(0, 7)
}

/**
 * A fresh all-zero route bucket.
 * @returns a new bucket with every count zero.
 */
export function zeroSlot(): UsageByRouteSlot {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

/**
 * Whether every disjoint token bucket is empty.
 * @param slot - route bucket to inspect.
 * @returns true when all four counts are zero.
 */
export function slotIsZero(slot: UsageByRouteSlot): boolean {
  return slot.uncachedInputTokens === 0
    && slot.outputTokens === 0
    && slot.cacheReadTokens === 0
    && slot.cacheWriteTokens === 0
}

/**
 * Sum one slot pair field by field.
 * @param slot - base route bucket.
 * @param delta - bucket to add.
 * @returns a fresh summed bucket.
 */
export function addSlot(slot: UsageByRouteSlot, delta: UsageByRouteSlot): UsageByRouteSlot {
  return {
    uncachedInputTokens: slot.uncachedInputTokens + delta.uncachedInputTokens,
    outputTokens: slot.outputTokens + delta.outputTokens,
    cacheReadTokens: slot.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: slot.cacheWriteTokens + delta.cacheWriteTokens,
  }
}

/**
 * A fresh UTC-day slot array.
 * @param count - slot count to create.
 * @returns independent all-zero slots.
 */
export function zeroSlots(count: number): UsageByRouteSlot[] {
  return Array.from({ length: count }, zeroSlot)
}

/**
 * Sum one route's 48 buckets into its entry totals.
 * @param slots - route slots to sum.
 * @returns field-wise totals.
 */
export function totalsOf(slots: readonly UsageByRouteSlot[]): UsageByRouteSlot {
  const totals = zeroSlot()
  for (const slot of slots) {
    totals.uncachedInputTokens += slot.uncachedInputTokens
    totals.outputTokens += slot.outputTokens
    totals.cacheReadTokens += slot.cacheReadTokens
    totals.cacheWriteTokens += slot.cacheWriteTokens
  }
  return totals
}

/**
 * Merge per-route usage projections into one projection.
 *
 * Routes are keyed by provider/model and keep first-seen order; all-zero
 * routes are omitted so a caller can detect "no billed usage" from the result.
 * @param projections - projections to add, in caller order; undefined entries are skipped.
 * @returns one projection whose route totals are the field-wise sums.
 */
export function mergeUsageByRoute(
  projections: Iterable<UsageByRouteProjection | undefined>,
): UsageByRouteProjection {
  const byRoute = new Map<string, { provider: string; model: string; slots: UsageByRouteSlot[] }>()
  for (const projection of projections) {
    if (projection === undefined) continue
    for (const route of projection.routes) {
      const key = `${route.provider}\0${route.model}`
      let entry = byRoute.get(key)
      if (entry === undefined) {
        entry = {
          provider: route.provider,
          model: route.model,
          slots: zeroSlots(route.slots.length),
        }
        byRoute.set(key, entry)
      }
      for (const [index, slot] of route.slots.entries()) {
        // Projection views carry the full 48-slot day; a shorter malformed
        // view still merges by extending its own route row.
        entry.slots[index] = addSlot(entry.slots[index] ?? zeroSlot(), slot)
      }
    }
  }
  const routes: UsageByRouteEntry[] = []
  for (const route of byRoute.values()) {
    const totals = totalsOf(route.slots)
    if (slotIsZero(totals)) continue
    routes.push({ provider: route.provider, model: route.model, totals, slots: route.slots })
  }
  return { routes }
}

/* jscpd:ignore-start -- parallel merge shape is deliberate */
/**
 * Merge day-bucketed projections into one projection.
 *
 * Routes are keyed by provider/model and keep first-seen order; days are
 * ascending and all-zero days/routes are omitted.
 * @param projections - projections to add, in caller order; undefined entries are skipped.
 * @returns one projection whose day slots are the field-wise sums.
 */
export function mergeUsageByDay(
  projections: Iterable<UsageByDayProjection | undefined>,
): UsageByDayProjection {
  const byRoute = new Map<string, { provider: string; model: string; days: Map<number, UsageByRouteSlot[]> }>()
  for (const projection of projections) {
    if (projection === undefined) continue
    for (const route of projection.routes) {
      const key = `${route.provider}\0${route.model}`
      let entry = byRoute.get(key)
      if (entry === undefined) {
        entry = { provider: route.provider, model: route.model, days: new Map() }
        byRoute.set(key, entry)
      }
      for (const day of route.days) {
        let slots = entry.days.get(day.day)
        if (slots === undefined) {
          slots = zeroSlots(USAGE_SLOTS_PER_DAY)
          entry.days.set(day.day, slots)
        }
        for (const [index, slot] of day.slots.entries()) {
          // Day views carry the full 48-slot shape; every index is an entry slot.
          // oxlint-disable-next-line typescript/no-non-null-assertion
          slots[index] = addSlot(slots[index]!, slot)
        }
      }
    }
  }
  const routes: UsageByDayEntry[] = []
  for (const entry of byRoute.values()) {
    const days: UsageByDayBucket[] = []
    for (const [day, slots] of [...entry.days.entries()].sort((a, b) => a[0] - b[0])) {
      if (slotsAreZero(slots)) continue
      days.push({ day, slots })
    }
    if (days.length === 0) continue
    routes.push({
      provider: entry.provider,
      model: entry.model,
      totals: totalsOf(days.flatMap(day => [...day.slots])),
      days,
    })
  }
  return { routes }
}

/* jscpd:ignore-end */

/** Lookup resolving one route's UTC offset in minutes for month assignment. */
export type UsageMonthOffset = (provider: string, model: string) => number

/**
 * Calendar months present in one day-bucketed projection.
 * @param projection - day-bucketed usage.
 * @param offsetOf - per-route UTC offset lookup in minutes.
 * @returns distinct local `YYYY-MM` keys, newest first.
 */
export function usageMonths(
  projection: UsageByDayProjection,
  offsetOf: UsageMonthOffset,
): readonly string[] {
  const months = new Set<string>()
  for (const route of projection.routes) {
    const offset = offsetOf(route.provider, route.model)
    for (const day of route.days) {
      for (const [index, slot] of day.slots.entries()) {
        if (slotIsZero(slot)) continue
        months.add(usageMonthKey(day.day * USAGE_DAY_MS + index * USAGE_SLOT_MS, offset))
      }
    }
  }
  return [...months].sort().reverse()
}

/**
 * Collapse one local calendar month into the all-time route shape cost
 * estimators consume.
 * @param projection - day-bucketed usage.
 * @param monthKey - local `YYYY-MM` to keep.
 * @param offsetOf - per-route UTC offset lookup in minutes.
 * @returns a per-route projection carrying only matching day/slot contributions.
 */
export function usageByDayForMonth(
  projection: UsageByDayProjection,
  monthKey: string,
  offsetOf: UsageMonthOffset,
): UsageByRouteProjection {
  const routes: UsageByRouteEntry[] = []
  for (const route of projection.routes) {
    const offset = offsetOf(route.provider, route.model)
    const slots = zeroSlots(USAGE_SLOTS_PER_DAY)
    let used = false
    for (const day of route.days) {
      for (const [index, slot] of day.slots.entries()) {
        if (slotIsZero(slot)) continue
        if (usageMonthKey(day.day * USAGE_DAY_MS + index * USAGE_SLOT_MS, offset) !== monthKey) continue
        // oxlint-disable-next-line typescript/no-non-null-assertion
        slots[index] = addSlot(slots[index]!, slot)
        used = true
      }
    }
    if (!used) continue
    routes.push({ provider: route.provider, model: route.model, totals: totalsOf(slots), slots })
  }
  return { routes }
}

/**
 * Whether every bucket in one slot array is empty.
 * @param slots - slot array to inspect.
 * @returns true when every slot is all-zero.
 */
export function slotsAreZero(slots: readonly UsageByRouteSlot[]): boolean {
  return slots.every(slotIsZero)
}

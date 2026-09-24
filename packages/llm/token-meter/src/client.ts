/**
 * Client-namespace projection of token-meter's browser-safe contracts and folds.
 *
 * @module @deepseek-ai/dsh-token-meter/client
 */

export type * from './projection.ts'
export { deriveTurnTokenUsage } from './turn-usage.ts'
export type { TurnAttemptUsage, TurnTokenUsage, TurnTokenUsageRoute } from './turn-usage.ts'
export {
  USAGE_SLOT_MS, estimateTurnCost, estimateUsageByRouteBreakdown, estimateUsageByRouteCost,
} from './cost.ts'
export type { CostEstimate, ModelPricingLookup, UsageCostBreakdown, UsageCostPart } from './cost.ts'
export {
  mergeUsageByDay, mergeUsageByRoute, usageByDayForMonth, usageMonths,
  usageDayOf, usageMonthKey, usageSlotOf, USAGE_DAY_MS, USAGE_SLOTS_PER_DAY,
} from './usage-merge.ts'
export type { UsageMonthOffset } from './usage-merge.ts'
export type { UsageByDayBucket, UsageByDayEntry, UsageByDayProjection } from './usage-by-day.ts'
export type { UsageByRouteEntry, UsageByRouteProjection, UsageByRouteSlot } from './usage-by-route.ts'

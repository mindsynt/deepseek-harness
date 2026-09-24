/**
 * Validation for provider-neutral model pricing configuration.
 *
 * @module @deepseek-ai/dsh-llm/model-pricing
 */

import z from '@deepseek-ai/schemastery'
import type { LlmModelPricing, LlmTimeOfDayPrice } from './types.ts'

/** `HH:mm` aligned to a half-hour boundary. */
const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):(?:00|30)$/

const timeOfDayPriceSchema: z<LlmTimeOfDayPrice> = z.object({
  start: z.string().pattern(TIME_OF_DAY_PATTERN).required(),
  end: z.string().pattern(TIME_OF_DAY_PATTERN).required(),
  inputCacheHit: z.number().min(0).required(),
  inputCacheMiss: z.number().min(0).required(),
  output: z.number().min(0).required(),
})

/**
 * Validated {@link LlmModelPricing}: required non-negative base prices, an
 * optional integer UTC offset from -720 through 840 minutes, and optional
 * ordered `HH:mm` half-hour time bands with required non-negative prices.
 */
export const LlmModelPricingSchema = z.object({
  inputCacheHit: z.number().min(0).required(),
  inputCacheMiss: z.number().min(0).required(),
  output: z.number().min(0).required(),
  utcOffsetMinutes: z.number().step(1).min(-720).max(840),
  timeBands: z.union([z.array(timeOfDayPriceSchema)]),
}) as z<LlmModelPricing>

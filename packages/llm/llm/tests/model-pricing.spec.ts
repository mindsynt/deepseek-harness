import { describe, expect, it } from 'vitest'
import { LlmModelPricingSchema } from '@deepseek-ai/dsh-llm'
import type { LlmModelPricing, LlmTimeOfDayPrice } from '@deepseek-ai/dsh-llm'

const BASE: LlmModelPricing = {
  inputCacheHit: 0.14,
  inputCacheMiss: 0.28,
  output: 0.42,
}

const BAND: LlmTimeOfDayPrice = {
  start: '00:00',
  end: '08:30',
  inputCacheHit: 0.07,
  inputCacheMiss: 0.14,
  output: 0.21,
}

describe('LlmModelPricingSchema', () => {
  it('accepts base prices and omits an absent offset', () => {
    expect(LlmModelPricingSchema({ ...BASE })).toEqual({ ...BASE })
  })

  it('accepts boundary-aligned bands and an integer UTC offset', () => {
    expect(LlmModelPricingSchema({
      ...BASE,
      utcOffsetMinutes: -720,
      timeBands: [BAND],
    })).toEqual({
      ...BASE,
      utcOffsetMinutes: -720,
      timeBands: [BAND],
    })
    expect(LlmModelPricingSchema({ ...BASE, utcOffsetMinutes: 840 })).toEqual({
      ...BASE,
      utcOffsetMinutes: 840,
    })
  })

  it.each([
    ['missing inputCacheHit', { inputCacheMiss: 1, output: 1 }],
    ['missing inputCacheMiss', { inputCacheHit: 1, output: 1 }],
    ['missing output', { inputCacheHit: 1, inputCacheMiss: 1 }],
    ['negative base price', { ...BASE, output: -0.01 }],
    ['fractional UTC offset', { ...BASE, utcOffsetMinutes: 1.5 }],
    ['UTC offset below the floor', { ...BASE, utcOffsetMinutes: -721 }],
    ['UTC offset above the ceiling', { ...BASE, utcOffsetMinutes: 841 }],
    ['hours beyond the clock', { ...BASE, timeBands: [{ ...BAND, start: '24:00' }] }],
    ['unpadded hour', { ...BASE, timeBands: [{ ...BAND, start: '9:00' }] }],
    ['unaligned minutes', { ...BASE, timeBands: [{ ...BAND, end: '08:15' }] }],
    ['missing band price', { ...BASE, timeBands: [{ start: '00:00', end: '01:00', inputCacheHit: 0 }] }],
    ['negative band price', { ...BASE, timeBands: [{ ...BAND, inputCacheMiss: -1 }] }],
  ])('rejects %s', (_label, input) => {
    expect(() => LlmModelPricingSchema(input as LlmModelPricing)).toThrow()
  })
})

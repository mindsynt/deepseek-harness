import { describe, expect, it } from 'vitest'
import { Config, plainOptions, resolveAdapterOptions } from '../src/index.ts'

const PRICING = {
  inputCacheHit: 0.14,
  inputCacheMiss: 0.28,
  output: 0.42,
}

describe('llm-deepseek model pricing', () => {
  it('accepts catalog pricing through the schema and preserves it in resolution', () => {
    const raw = {
      models: [{
        id: 'priced-model',
        pricing: {
          ...PRICING,
          utcOffsetMinutes: 0,
          timeBands: [{
            start: '08:00',
            end: '08:30',
            inputCacheHit: 0.07,
            inputCacheMiss: 0.14,
            output: 0.21,
          }],
        },
      }],
    }
    const connection = resolveAdapterOptions(plainOptions(Config(raw)))
    expect(connection.models).toEqual([{
      id: 'priced-model',
      inputModalities: ['text'],
      pricing: {
        ...PRICING,
        utcOffsetMinutes: 0,
        timeBands: [{
          start: '08:00',
          end: '08:30',
          inputCacheHit: 0.07,
          inputCacheMiss: 0.14,
          output: 0.21,
        }],
      },
    }])
  })

  it('preserves base prices without materializing optional bands', () => {
    const connection = resolveAdapterOptions(plainOptions(Config({
      models: [{ id: 'base-only', pricing: PRICING }],
    })))
    expect(connection.models).toEqual([{
      id: 'base-only',
      inputModalities: ['text'],
      pricing: { ...PRICING },
    }])
  })

  it('leaves a model without pricing unpriced', () => {
    const connection = resolveAdapterOptions(plainOptions(Config({ models: [{ id: 'plain-model' }] })))
    expect(connection.models[0]).not.toHaveProperty('pricing')
  })

  it('rejects programmatic pricing that bypassed the schema', () => {
    expect(() => resolveAdapterOptions({
      models: [{ id: 'bad-model', pricing: { ...PRICING, output: -1 } }],
    })).toThrow(/pricing is invalid/)
  })

  it('rejects a zero-length band that bypassed the schema', () => {
    expect(() => resolveAdapterOptions({
      models: [{
        id: 'empty-band',
        pricing: {
          ...PRICING,
          timeBands: [{ start: '08:00', end: '08:00', inputCacheHit: 0, inputCacheMiss: 0, output: 0 }],
        },
      }],
    })).toThrow(/zero-length time band/)
  })

  it('rejects malformed pricing at the schema boundary', () => {
    expect(() => Config({
      models: [{
        id: 'bad-model',
        pricing: {
          ...PRICING,
          timeBands: [{ start: '00:00', end: '24:00', inputCacheHit: 0, inputCacheMiss: 0, output: 0 }],
        },
      }],
    })).toThrow(/pricing/)
  })
})

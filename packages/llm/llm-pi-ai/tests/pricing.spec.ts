import { describe, expect, it } from 'vitest'
import { Config, resolveProfiles } from '../src/config.ts'
import type { PiAiModelOverride, PiAiModelProfile } from '../src/config.ts'

const BAND = {
  start: '00:00',
  end: '08:00',
  inputCacheHit: 0.07,
  inputCacheMiss: 0.14,
  output: 0.21,
}

const PRICING = {
  inputCacheHit: 0.14,
  inputCacheMiss: 0.28,
  output: 0.42,
  utcOffsetMinutes: 480,
  timeBands: [BAND],
}

const route = (models: PiAiModelProfile[], modelOverrides?: Record<string, PiAiModelOverride>): unknown => ({
  providers: Config({
    providers: {
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models,
        ...modelOverrides === undefined ? {} : { modelOverrides },
      },
    },
  }).providers.get(),
})

describe('llm-pi-ai model pricing', () => {
  it('accepts pricing on a model entry and on a catalog override', () => {
    expect(() => route([{ id: 'm', pricing: PRICING }])).not.toThrow()
    expect(() => route([{ id: 'm' }], { m: { pricing: PRICING } })).not.toThrow()
  })

  it('rejects malformed pricing at the schema boundary', () => {
    expect(() => route([{ id: 'm', pricing: { ...PRICING, output: -1 } }])).toThrow(/pricing/)
    expect(() => route([{ id: 'm' }], {
      m: { pricing: { ...PRICING, timeBands: [{ ...BAND, end: '08:15' }] } },
    })).toThrow(/pricing/)
  })

  it('validates programmatic pricing without carrying it onto the pi-ai model', () => {
    const profiles = resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm', pricing: PRICING }],
      },
    })
    const model = profiles.get('acme-gateway')?.piProvider?.getModels()[0]
    expect(model?.id).toBe('m')
    expect(model).not.toHaveProperty('pricing')
  })

  it('rejects a zero-length band that bypassed the schema', () => {
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm', pricing: { ...PRICING, timeBands: [{ ...BAND, end: '00:00' }] } }],
      },
    })).toThrow(/zero-length time band/)
  })

  it('rejects programmatic pricing that bypassed the schema', () => {
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm', pricing: { ...PRICING, inputCacheHit: -1 } }],
      },
    })).toThrow(/model "m" pricing is invalid/)
  })
})

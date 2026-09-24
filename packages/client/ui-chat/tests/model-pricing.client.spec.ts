import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  LlmConfigurableProvider, RemoteResult, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  SettingsDescribeFace, SettingsDescribeView, SettingsMirrorSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ModelPricingPolicy, modelPricingKey, modelPricingLookup, pricingFromSettings,
} from '../src/client/model-pricing.ts'

const BASE = { inputCacheHit: 1, inputCacheMiss: 2, output: 3 } as const

function namespace(ns: string, value: JsonValue): SettingsNamespaceView {
  return {
    autoGenerate: false,
    ns,
    schema: {},
    value,
    applies: 'live',
    secrets: [],
    revision: 1,
  }
}

function entry(settingsNs: string, settingsPath: readonly string[] = [], provider = 'provider'): LlmConfigurableProvider {
  return { provider, displayName: provider, settingsNs, settingsPath }
}

function answer<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function refusal(message: string): RemoteResult<never> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

interface DescribeDouble {
  face: SettingsDescribeFace
  store: ReturnType<typeof createSnapshotStore<SettingsMirrorSnapshot>>
  ensure: ReturnType<typeof vi.fn<SettingsDescribeFace['ensure']>>
}

function describeDouble(initialView?: SettingsDescribeView): DescribeDouble {
  const store = createSnapshotStore<SettingsMirrorSnapshot>({
    status: initialView === undefined ? 'idle' : 'ready',
    view: initialView,
    error: null,
  })
  const ensure = vi.fn<SettingsDescribeFace['ensure']>().mockResolvedValue(undefined)
  return {
    store,
    ensure,
    face: {
      getSnapshot: () => store.getSnapshot(),
      subscribe: listener => store.subscribe(listener),
      ensure,
      acceptView: vi.fn(),
    },
  }
}

function emptyView(namespaces: readonly SettingsNamespaceView[] = []): SettingsDescribeView {
  return { writable: true, hasDocument: false, namespaces }
}

describe('pricingFromSettings', () => {
  it('joins model-list prices for a whole-namespace profile', () => {
    const value = {
      models: [
        { id: 'plain', pricing: BASE },
        {
          id: 'banded',
          pricing: {
            inputCacheHit: 4,
            inputCacheMiss: 5,
            output: 6,
            utcOffsetMinutes: 0,
            timeBands: [{
              start: '08:00',
              end: '12:30',
              inputCacheHit: 7,
              inputCacheMiss: 8,
              output: 9,
            }],
          },
        },
        { id: 'unpriced' },
      ],
    }
    const byRoute = pricingFromSettings(
      new Map([['llm-provider', namespace('llm-provider', value)]]),
      [entry('llm-provider')],
    )

    expect(byRoute.get(modelPricingKey('provider', 'plain'))).toEqual(BASE)
    expect(byRoute.get(modelPricingKey('provider', 'banded'))).toEqual({
      inputCacheHit: 4,
      inputCacheMiss: 5,
      output: 6,
      utcOffsetMinutes: 0,
      timeBands: [{
        start: '08:00',
        end: '12:30',
        inputCacheHit: 7,
        inputCacheMiss: 8,
        output: 9,
      }],
    })
    expect(byRoute.size).toBe(2)
  })

  it('joins modelOverrides at the configured settings path', () => {
    const value = {
      providers: {
        gateway: {
          modelOverrides: {
            alpha: { pricing: BASE },
            beta: { pricing: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 } },
          },
        },
      },
    }
    const byRoute = pricingFromSettings(
      new Map([['llm-pi-ai', namespace('llm-pi-ai', value)]]),
      [entry('llm-pi-ai', ['providers', 'gateway'], 'gateway')],
    )

    expect(byRoute.get(modelPricingKey('gateway', 'alpha'))).toEqual(BASE)
    expect(byRoute.get(modelPricingKey('gateway', 'beta'))).toEqual({
      inputCacheHit: 0, inputCacheMiss: 0, output: 0,
    })
  })

  it('keeps the first valid price and skips every malformed candidate', () => {
    const byRoute = pricingFromSettings(
      new Map([['llm-provider', namespace('llm-provider', {
        models: [
          { id: 'first', pricing: BASE },
          { id: 'first', pricing: { inputCacheHit: 100, inputCacheMiss: 100, output: 100 } },
          null,
          42,
          { pricing: BASE },
          { id: '', pricing: BASE },
          { id: 7, pricing: BASE },
          { id: 'not-record', pricing: null },
          { id: 'missing', pricing: { inputCacheHit: 1 } },
          { id: 'negative', pricing: { inputCacheHit: -1, inputCacheMiss: 1, output: 1 } },
          { id: 'nan', pricing: { inputCacheHit: Number.NaN, inputCacheMiss: 1, output: 1 } },
          { id: 'infinite', pricing: { inputCacheHit: Number.POSITIVE_INFINITY, inputCacheMiss: 1, output: 1 } },
          { id: 'string-price', pricing: { inputCacheHit: '1', inputCacheMiss: 1, output: 1 } },
          { id: 'bad-offset-type', pricing: { ...BASE, utcOffsetMinutes: '8' } },
          { id: 'bad-offset-fraction', pricing: { ...BASE, utcOffsetMinutes: 1.5 } },
          { id: 'bad-offset-low', pricing: { ...BASE, utcOffsetMinutes: -721 } },
          { id: 'bad-offset-high', pricing: { ...BASE, utcOffsetMinutes: 841 } },
          { id: 'bad-bands', pricing: { ...BASE, timeBands: {} } },
          { id: 'bad-band', pricing: { ...BASE, timeBands: [null] } },
          { id: 'bad-band-start', pricing: { ...BASE, timeBands: [{ start: '8:00', end: '09:00', ...BASE }] } },
          { id: 'bad-band-end', pricing: { ...BASE, timeBands: [{ start: '08:00', end: '24:00', ...BASE }] } },
          { id: 'empty-band', pricing: { ...BASE, timeBands: [{ start: '08:00', end: '08:00', ...BASE }] } },
          { id: 'bad-band-price', pricing: { ...BASE, timeBands: [{ start: '08:00', end: '09:00', ...BASE, output: -1 }] } },
        ],
        modelOverrides: {
          fallback: { pricing: { inputCacheHit: 3, inputCacheMiss: 4, output: 5 } },
          invalid: 7,
        },
        ignored: 7,
      })]]),
      [entry('llm-provider')],
    )

    expect(byRoute.get(modelPricingKey('provider', 'first'))).toEqual(BASE)
    expect(byRoute.get(modelPricingKey('provider', 'fallback'))).toEqual({
      inputCacheHit: 3, inputCacheMiss: 4, output: 5,
    })
    expect([...byRoute.keys()].sort()).toEqual([
      modelPricingKey('provider', 'fallback'),
      modelPricingKey('provider', 'first'),
    ])
  })

  it('skips entries with no matching namespace, a non-object profile, or a non-list models field', () => {
    const namespaces = new Map([
      ['scalar', namespace('scalar', 7)],
      ['array', namespace('array', [1, 2])],
      ['path', namespace('path', { provider: 'scalar' })],
      ['models-not-list', namespace('models-not-list', { models: { id: 'x' } })],
      ['overrides-not-record', namespace('overrides-not-record', { modelOverrides: 7 })],
    ])
    const byRoute = pricingFromSettings(namespaces, [
      entry('missing'),
      entry('scalar'),
      entry('array'),
      entry('path', ['provider', 'deeper']),
      entry('models-not-list'),
      entry('overrides-not-record'),
    ])
    expect(byRoute.size).toBe(0)
  })
})

describe('model pricing lookup', () => {
  it('keys routes with a null separator and resolves only exact matches', () => {
    const routeKey = modelPricingKey('provider', 'model')
    expect(routeKey).toBe('provider\u0000model')
    const byRoute = new Map([[routeKey, BASE]])
    const lookup = modelPricingLookup(byRoute)
    expect(lookup('provider', 'model')).toEqual(BASE)
    expect(lookup('provider', 'other')).toBeUndefined()
    expect(lookup('provider\u0000model', '')).toBeUndefined()
  })
})

describe('ModelPricingPolicy', () => {
  it('stays idle until ensure, then publishes and follows describe changes', async () => {
    const scope = describeDouble(emptyView([namespace('llm-provider', {
      models: [{ id: 'model', pricing: BASE }],
    })]))
    const list = vi.fn(async () => answer([entry('llm-provider')]))
    const policy = new ModelPricingPolicy({ listConfigurableProviders: list, describe: scope.face })

    expect(policy.snapshot.getSnapshot()).toEqual({ status: 'idle', byRoute: new Map() })
    expect(list).not.toHaveBeenCalled()
    expect(scope.ensure).not.toHaveBeenCalled()

    policy.ensure()
    expect(list).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })
    expect(policy.snapshot.getSnapshot().byRoute.get(modelPricingKey('provider', 'model'))).toEqual(BASE)

    // A ready policy does not re-read on the next ensure.
    policy.ensure()
    expect(list).toHaveBeenCalledTimes(1)

    scope.store.set({
      status: 'ready',
      view: emptyView([namespace('llm-provider', {
        models: [{ id: 'model', pricing: { inputCacheHit: 9, inputCacheMiss: 8, output: 7 } }],
      })]),
      error: null,
    })
    expect(policy.snapshot.getSnapshot().byRoute.get(modelPricingKey('provider', 'model'))).toEqual({
      inputCacheHit: 9, inputCacheMiss: 8, output: 7,
    })

    const held = policy.snapshot.getSnapshot()
    scope.store.set({ status: 'idle', view: undefined, error: 'settings down' })
    expect(policy.snapshot.getSnapshot()).toBe(held)

    policy.dispose()
  })

  it('recomputes only while a directory is held and leaves an unasked policy untouched', () => {
    const scope = describeDouble(emptyView([namespace('llm-provider', { models: [] })]))
    const list = vi.fn(async () => answer([entry('llm-provider')]))
    const policy = new ModelPricingPolicy({ listConfigurableProviders: list, describe: scope.face })

    scope.store.set({ status: 'ready', view: emptyView([namespace('llm-provider', { models: [] })]), error: null })
    expect(policy.snapshot.getSnapshot().status).toBe('idle')

    policy.ensure()
    const ready = policy.snapshot.getSnapshot()
    scope.store.set({ status: 'idle', view: undefined, error: 'settings down' })
    expect(policy.snapshot.getSnapshot()).toBe(ready)
    policy.dispose()
  })

  it('re-reads the directory on refresh once requested', async () => {
    const scope = describeDouble(emptyView([namespace('llm-provider', {
      models: [{ id: 'model', pricing: BASE }],
    })]))
    const list = vi.fn()
      .mockResolvedValueOnce(answer([entry('llm-provider')]))
      .mockImplementationOnce(() => new Promise<RemoteResult<LlmConfigurableProvider[]>>(() => {}))
    const policy = new ModelPricingPolicy({ listConfigurableProviders: list, describe: scope.face })

    policy.refreshDirectory()
    expect(list).not.toHaveBeenCalled()

    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })
    const held = policy.snapshot.getSnapshot()

    policy.refreshDirectory()
    expect(policy.snapshot.getSnapshot().status).toBe('loading')
    expect(policy.snapshot.getSnapshot().byRoute).toBe(held.byRoute)
    policy.dispose()
  })

  it('retries after a refused directory read and reports missing describe views', async () => {
    const scope = describeDouble(emptyView())
    const list = vi.fn()
      .mockResolvedValueOnce(refusal('directory down'))
      .mockResolvedValueOnce(answer([]))
    const policy = new ModelPricingPolicy({ listConfigurableProviders: list, describe: scope.face })

    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('error') })
    expect(policy.snapshot.getSnapshot().byRoute.size).toBe(0)

    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })
    expect(list).toHaveBeenCalledTimes(2)

    const unanswered = describeDouble(undefined)
    const second = new ModelPricingPolicy({ listConfigurableProviders: vi.fn(async () => answer([])), describe: unanswered.face })
    second.ensure()
    await vi.waitFor(() => { expect(second.snapshot.getSnapshot().status).toBe('error') })
    policy.dispose()
    second.dispose()
  })

  it('turns a rejecting directory read into an error state', async () => {
    const scope = describeDouble(emptyView())
    const policy = new ModelPricingPolicy({
      listConfigurableProviders: vi.fn(async () => { throw new Error('transport down') }),
      describe: scope.face,
    })
    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('error') })
    policy.dispose()
  })

  it('drops and reloads the directory across reset, ignoring the stale generation', async () => {
    const scope = describeDouble(emptyView([namespace('llm-provider', { models: [] })]))
    const resolveFirst: Array<(value: RemoteResult<LlmConfigurableProvider[]>) => void> = []
    const list = vi.fn<() => Promise<RemoteResult<LlmConfigurableProvider[]>>>()
    list.mockImplementation(() => new Promise<RemoteResult<LlmConfigurableProvider[]>>((resolve) => {
      resolveFirst.push(resolve)
    }))
    const policy = new ModelPricingPolicy({ listConfigurableProviders: list, describe: scope.face })

    policy.reset()
    expect(policy.snapshot.getSnapshot().status).toBe('idle')
    expect(list).not.toHaveBeenCalled()

    policy.ensure()
    policy.reset()
    expect(list).toHaveBeenCalledTimes(2)

    resolveFirst[0]!(answer([entry('stale')]))
    await Promise.resolve()
    expect(policy.snapshot.getSnapshot().status).toBe('loading')

    resolveFirst[1]!(answer([entry('fresh')]))
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })
    expect(policy.snapshot.getSnapshot().byRoute.has(modelPricingKey('fresh', 'model'))).toBe(false)
    policy.dispose()
  })

  it('stops publishing and answering lifecycle calls after dispose', async () => {
    const scope = describeDouble(emptyView([namespace('llm-provider', {
      models: [{ id: 'model', pricing: BASE }],
    })]))
    const list = vi.fn(async () => answer([entry('llm-provider')]))
    const policy = new ModelPricingPolicy({ listConfigurableProviders: list, describe: scope.face })
    policy.ensure()
    await vi.waitFor(() => { expect(policy.snapshot.getSnapshot().status).toBe('ready') })

    policy.dispose()
    const ready = policy.snapshot.getSnapshot()
    scope.store.set({ status: 'idle', view: undefined, error: 'settings down' })
    expect(policy.snapshot.getSnapshot()).toBe(ready)

    policy.ensure()
    policy.refreshDirectory()
    policy.reset()
    policy.dispose()
    expect(list).toHaveBeenCalledTimes(1)
    expect(policy.snapshot.getSnapshot()).toBe(ready)
  })

  it('ignores a read rejection that settles after dispose', async () => {
    const scope = describeDouble(emptyView())
    const pending: Array<(error: Error) => void> = []
    const policy = new ModelPricingPolicy({
      listConfigurableProviders: () => new Promise((_resolve, reject) => { pending.push(reject) }),
      describe: scope.face,
    })
    policy.ensure()
    policy.dispose()
    pending[0]!(new Error('late transport failure'))
    await Promise.resolve()
    expect(policy.snapshot.getSnapshot().status).toBe('loading')
  })

  it('ignores a read that settles after dispose', async () => {
    const scope = describeDouble(emptyView())
    const pending: Array<(value: RemoteResult<LlmConfigurableProvider[]>) => void> = []
    const policy = new ModelPricingPolicy({
      listConfigurableProviders: () => new Promise((resolve) => { pending.push(resolve) }),
      describe: scope.face,
    })
    policy.ensure()
    policy.dispose()
    pending[0]!(answer([entry('provider')]))
    await Promise.resolve()
    expect(policy.snapshot.getSnapshot().status).toBe('loading')
  })
})

/**
 * Model pricing reached through provider model settings and published to Chat.
 *
 * The policy owns the one `llm/listConfigurableProviders` read and joins its
 * directory with the shared settings mirror. Nothing leaves the policy until a
 * usage-bearing surface calls {@link ModelPricingPolicy.ensure}, so profiles
 * that never show usage never pay for the pricing RPC.
 *
 * @module @deepseek-ai/dsh-client-ui-chat/model-pricing
 */

import type { LlmConfigurableProvider, RemoteResult, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsDescribeFace, SettingsDescribeView } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LlmModelPricing, LlmTimeOfDayPrice } from '@deepseek-ai/dsh-llm/types'
import type { ModelPricingLookup } from '@deepseek-ai/dsh-token-meter/client'

/** Pricing availability and the current per-route price lookup. */
export interface ModelPricingSnapshot {
  /** `idle` until first use, `loading` during a read, `ready` once a lookup exists, `error` after a failed read. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Validated prices keyed by {@link modelPricingKey}; empty while not ready. */
  byRoute: ReadonlyMap<string, LlmModelPricing>
}

/** The two reads one pricing load performs. */
export interface ModelPricingPolicyDeps {
  /**
   * Read the configurable-provider directory.
   * @returns the directory answer, or a Remote failure message.
   */
  listConfigurableProviders(): Promise<RemoteResult<LlmConfigurableProvider[]>>
  /** Shared settings mirror the profiles are read from. */
  describe: SettingsDescribeFace
}

/** Null separator that cannot occur in a provider route or model id. */
const ROUTE_KEY_SEPARATOR = '\u0000'

/** Half-hour-aligned `HH:mm`, the form adapter schemas accept. */
const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):(?:00|30)$/

const MIN_UTC_OFFSET_MINUTES = -720
const MAX_UTC_OFFSET_MINUTES = 840

/**
 * Build the pricing-map key for one provider/model route.
 * @param provider - provider route id.
 * @param model - exact model id.
 * @returns the `provider\0model` lookup key.
 */
export function modelPricingKey(provider: string, model: string): string {
  return `${provider}${ROUTE_KEY_SEPARATOR}${model}`
}

/**
 * Build the estimator's synchronous lookup over a published pricing map.
 * @param byRoute - validated prices keyed by {@link modelPricingKey}.
 * @returns a lookup that returns undefined for any unpriced route.
 */
export function modelPricingLookup(byRoute: ReadonlyMap<string, LlmModelPricing>): ModelPricingLookup {
  return (provider, model) => byRoute.get(modelPricingKey(provider, model))
}

/** Whether a value is a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Walk an immutable settings path; a missing or scalar intermediate yields undefined. */
function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

/** Whether a wire value is a finite non-negative price. */
function price(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Whether a wire value is a half-hour-aligned clock string. */
function clock(value: unknown): value is string {
  return typeof value === 'string' && TIME_OF_DAY_PATTERN.test(value)
}

/** Parse one optional time band, rejecting any malformed field. */
function parseTimeBand(value: unknown): LlmTimeOfDayPrice | undefined {
  if (!isRecord(value)) return undefined
  const { start, end, inputCacheHit, inputCacheMiss, output } = value
  if (!clock(start) || !clock(end) || start === end) return undefined
  if (!price(inputCacheHit) || !price(inputCacheMiss) || !price(output)) return undefined
  return { start, end, inputCacheHit, inputCacheMiss, output }
}

/** Parse one optional UTC offset, rejecting non-integer or out-of-range values. */
function parseUtcOffset(value: unknown): number | undefined | false {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) return false
  if (value < MIN_UTC_OFFSET_MINUTES || value > MAX_UTC_OFFSET_MINUTES) return false
  return value
}

/** Parse one optional `timeBands` array, rejecting any malformed band. */
function parseTimeBands(value: unknown): readonly LlmTimeOfDayPrice[] | undefined | false {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return false
  const bands: LlmTimeOfDayPrice[] = []
  for (const band of value) {
    const parsed = parseTimeBand(band)
    if (parsed === undefined) return false
    bands.push(parsed)
  }
  return bands
}

/**
 * Validate one stored pricing object defensively. Required base prices must be
 * finite and non-negative; an offset must be an in-range integer; every time
 * band must carry a half-hour start/end and non-negative prices.
 * @param value - raw `pricing` value from a model profile.
 * @returns the detached validated pricing, or undefined when malformed.
 */
function parseModelPricing(value: unknown): LlmModelPricing | undefined {
  if (!isRecord(value)) return undefined
  const { inputCacheHit, inputCacheMiss, output } = value
  if (!price(inputCacheHit) || !price(inputCacheMiss) || !price(output)) return undefined
  const utcOffset = parseUtcOffset(value.utcOffsetMinutes)
  if (utcOffset === false) return undefined
  const timeBands = parseTimeBands(value.timeBands)
  if (timeBands === false) return undefined
  return {
    inputCacheHit,
    inputCacheMiss,
    output,
    ...(utcOffset === undefined ? {} : { utcOffsetMinutes: utcOffset }),
    ...(timeBands === undefined ? {} : { timeBands }),
  }
}

/** Insert one model's pricing when the route is valid, unpriced, and not already claimed. */
function insertPricing(
  byRoute: Map<string, LlmModelPricing>,
  provider: string,
  model: unknown,
  pricing: unknown,
): void {
  if (typeof model !== 'string' || model.length === 0) return
  const key = modelPricingKey(provider, model)
  if (byRoute.has(key)) return
  const parsed = parseModelPricing(pricing)
  if (parsed === undefined) return
  byRoute.set(key, parsed)
}

/**
 * Join the configurable-provider directory with settings namespace views into
 * a route pricing map. Each entry reads its profile at `settingsPath` in the
 * namespace's resolved value; model prices come from `profile.models[]` then
 * `profile.modelOverrides{}`. Malformed profiles, ids, and prices are skipped;
 * the first valid price for a route wins.
 * @param namespaces - namespace views keyed by `ns`, as the describe mirror holds them.
 * @param directory - configurable-provider directory, as `llm/listConfigurableProviders` reports it.
 * @returns validated prices keyed by {@link modelPricingKey}.
 */
export function pricingFromSettings(
  namespaces: ReadonlyMap<string, SettingsNamespaceView>,
  directory: readonly LlmConfigurableProvider[],
): ReadonlyMap<string, LlmModelPricing> {
  const byRoute = new Map<string, LlmModelPricing>()
  for (const entry of directory) {
    const namespace = namespaces.get(entry.settingsNs)
    if (namespace === undefined) continue
    const profile = valueAtPath(namespace.value, entry.settingsPath)
    if (!isRecord(profile)) continue
    const models = profile.models
    if (Array.isArray(models)) {
      for (const model of models) {
        if (!isRecord(model)) continue
        insertPricing(byRoute, entry.provider, model.id, model.pricing)
      }
    }
    const overrides = profile.modelOverrides
    if (!isRecord(overrides)) continue
    for (const [model, override] of Object.entries(overrides)) {
      if (!isRecord(override)) continue
      insertPricing(byRoute, entry.provider, model, override.pricing)
    }
  }
  return byRoute
}

/**
 * One pricing view for Chat: reads the directory and settings mirror lazily,
 * republishes when describe changes, and re-reads on adapter churn.
 */
export class ModelPricingPolicy {
  /** Snapshot consumed by usage surfaces through the inject `hooks` compartment. */
  readonly snapshot: SnapshotStore<ModelPricingSnapshot> = createSnapshotStore<ModelPricingSnapshot>({
    status: 'idle',
    byRoute: new Map(),
  })

  /** Latest successful directory; undefined until one load succeeds. */
  private directory: readonly LlmConfigurableProvider[] | undefined

  /** Whether a usage-bearing surface has asked for pricing at least once. */
  private requested = false

  /** Fences an in-flight read from a later reset/refresh. */
  private generation = 0

  private disposed = false

  private readonly unsubscribeDescribe: () => void

  /**
   * @param deps - directory read and shared settings mirror.
   */
  constructor(private readonly deps: ModelPricingPolicyDeps) {
    this.unsubscribeDescribe = deps.describe.subscribe(() => { this.recompute() })
  }

  /**
   * Start the first pricing read. Idempotent while idle is already resolved or
   * a read is running; an error state retries on the next ask. Must be called
   * by a surface that will render usage; until then no RPC runs.
   */
  ensure(): void {
    if (this.disposed) return
    this.requested = true
    const status = this.snapshot.getSnapshot().status
    if (status === 'ready' || status === 'loading') return
    this.load()
  }

  /**
   * Re-read the provider directory after an adapter-registry change. A no-op
   * before the first {@link ensure}, so background topology events stay free.
   */
  refreshDirectory(): void {
    if (this.disposed || !this.requested) return
    this.load()
  }

  /**
   * Drop the current snapshot on a connection reset. A policy that a usage
   * surface already asked for reloads against the new connection; an unused
   * policy stays idle so the reconnect costs no pricing RPC.
   */
  reset(): void {
    if (this.disposed) return
    this.generation += 1
    this.directory = undefined
    this.snapshot.set({ status: 'idle', byRoute: new Map() })
    if (this.requested) this.load()
  }

  /** Release the describe subscription and stop publishing. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.unsubscribeDescribe()
  }

  /** Start one read, publishing a loading state that keeps the last map. */
  private load(): void {
    const generation = ++this.generation
    this.snapshot.set({ status: 'loading', byRoute: this.snapshot.getSnapshot().byRoute })
    void this.resolve(generation)
  }

  /** Settle one read; a reset or newer load makes the answer stale. */
  private async resolve(generation: number): Promise<void> {
    let directory: readonly LlmConfigurableProvider[]
    try {
      const [answer] = await Promise.all([
        this.deps.listConfigurableProviders(),
        this.deps.describe.ensure(),
      ])
      if (this.disposed || generation !== this.generation) return
      if (!answer.ok) {
        this.fail()
        return
      }
      directory = answer.value
    } catch (_error: unknown) {
      // A rejecting transport is a read failure like a Remote refusal; the
      // next ensure retries from the error state.
      if (!this.disposed && generation === this.generation) this.fail()
      return
    }
    const view = this.deps.describe.getSnapshot().view
    if (view === undefined) {
      this.fail()
      return
    }
    this.directory = directory
    this.publish(view, directory)
  }

  /** Republish from a describe change once a directory is held. */
  private recompute(): void {
    if (this.disposed || this.directory === undefined) return
    const view = this.deps.describe.getSnapshot().view
    if (view === undefined) return
    this.publish(view, this.directory)
  }

  /** Publish one ready snapshot built from a directory and describe view. */
  private publish(view: SettingsDescribeView, directory: readonly LlmConfigurableProvider[]): void {
    const namespaces = new Map(view.namespaces.map(namespace => [namespace.ns, namespace]))
    this.snapshot.set({ status: 'ready', byRoute: pricingFromSettings(namespaces, directory) })
  }

  /** Publish a completed read failure. */
  private fail(): void {
    this.snapshot.set({ status: 'error', byRoute: new Map() })
  }
}

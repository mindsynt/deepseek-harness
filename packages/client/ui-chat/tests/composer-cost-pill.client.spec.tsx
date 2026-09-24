// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { LlmModelPricing } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  UsageByDayEntry, UsageByDayProjection, UsageByRouteEntry, UsageByRouteProjection, UsageByRouteSlot,
} from '@deepseek-ai/dsh-token-meter/client'
import { zh } from '../src/client/locale.ts'
import type { GlobalUsageSnapshot } from '../src/client/global-usage.ts'
import { modelPricingKey, type ModelPricingSnapshot } from '../src/client/model-pricing.ts'
import { ComposerCostPill, type ComposerCostPillProps } from '../src/client/chat/ComposerCostPill.tsx'

afterEach(cleanup)

const t: ComposerCostPillProps['t'] = makeTranslate(zh, commonZh)
const SID = 'session-1' as SessionId
const OTHER = 'session-2' as SessionId

const SLOT: UsageByRouteSlot = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

function route(provider: string, model: string, tokens: number): UsageByRouteEntry {
  const usage = { ...SLOT, uncachedInputTokens: tokens }
  return {
    provider,
    model,
    totals: usage,
    slots: Array.from({ length: 48 }, (_unused, index) => index === 0 ? usage : SLOT),
  }
}

function routeProjection(...routes: UsageByRouteEntry[]): UsageByRouteProjection {
  return { routes }
}

function dayRoute(provider: string, model: string, day: number, tokens: number): UsageByDayEntry {
  const usage = { ...SLOT, uncachedInputTokens: tokens }
  return {
    provider,
    model,
    totals: usage,
    days: [{ day, slots: Array.from({ length: 48 }, (_unused, index) => index === 0 ? usage : SLOT) }],
  }
}

function dayProjection(...routes: UsageByDayEntry[]): UsageByDayProjection {
  return { routes }
}

function selection(provider: string, model: string): ModelSelectionProjection {
  const next = { provider, model }
  return { lastUsed: next, next }
}

const PRICES: ReadonlyMap<string, LlmModelPricing> = new Map([
  [modelPricingKey('deepseek', 'chat'), { inputCacheHit: 0, inputCacheMiss: 2, output: 3 }],
  [modelPricingKey('other', 'model'), { inputCacheHit: 0, inputCacheMiss: 1, output: 0 }],
])

/** Stub the projection seat: a key-addressed table of whole values. */
function projections(values: Record<string, unknown>): ComposerCostPillProps['useProjection'] {
  return (key: string) => values[key]
}

function globalStore(init: GlobalUsageSnapshot) {
  return createSnapshotStore<GlobalUsageSnapshot>(init)
}

function snapshot(init: {
  routes?: ReadonlyMap<SessionId, UsageByRouteProjection>
  days?: ReadonlyMap<SessionId, UsageByDayProjection>
  subagents?: ReadonlySet<SessionId>
} = {}): GlobalUsageSnapshot {
  return {
    status: 'ready',
    bySession: init.routes ?? new Map([[SID, routeProjection(route('deepseek', 'chat', 1_000_000))]]),
    daysBySession: init.days ?? new Map([[SID, dayProjection(dayRoute('deepseek', 'chat', 200, 1_000_000))]]),
    subagentSessions: init.subagents ?? new Set(),
  }
}

function harness(init: {
  mode?: 'compact' | 'detailed'
  values?: Record<string, unknown>
  pricing?: ModelPricingSnapshot
  global?: SnapshotStore<GlobalUsageSnapshot>
} = {}) {
  const performance = createSnapshotStore<'compact' | 'detailed'>(init.mode ?? 'detailed')
  const pricing = createSnapshotStore<ModelPricingSnapshot>(
    init.pricing ?? { status: 'ready', byRoute: PRICES },
  )
  const global = init.global ?? globalStore(snapshot())
  const ensureModelPricing = vi.fn()
  const ensureGlobalUsage = vi.fn()
  const props: ComposerCostPillProps = {
    sessionId: SID,
    usePerformanceUsage: bindSnapshotSelector(performance),
    useModelPricing: bindSnapshotSelector(pricing),
    ensureModelPricing,
    useGlobalUsage: bindSnapshotSelector(global),
    ensureGlobalUsage,
    useProjection: projections({
      tokenUsage: { ...SLOT, uncachedInputTokens: 1_000_000 },
      usageByRoute: routeProjection(route('deepseek', 'chat', 1_000_000)),
      usageByDay: dayProjection(dayRoute('deepseek', 'chat', 200, 1_000_000)),
      modelSelection: selection('deepseek', 'chat'),
      ...init.values,
    }),
    t,
  }
  return { props, ensureModelPricing, ensureGlobalUsage }
}

describe('ComposerCostPill', () => {
  it('asks the two lazy sources, shows a summarizing reading, then the current month spend', () => {
    const global = globalStore({ status: 'idle', bySession: new Map(), daysBySession: new Map(), subagentSessions: new Set() })
    const { props, ensureModelPricing, ensureGlobalUsage } = harness({ global })
    const view = render(<ComposerCostPill {...props} />)
    expect(ensureModelPricing).toHaveBeenCalledOnce()
    expect(ensureGlobalUsage).toHaveBeenCalledOnce()
    expect(view.container.textContent).toBe('模型花费汇总中…')

    act(() => { global.set(snapshot()) })
    expect(view.getByRole('button').textContent).toBe('模型花费 2.00')
  })

  it('opens month and scope selectors with the default latest month breakdown', () => {
    const { props } = harness()
    const view = render(<ComposerCostPill {...props} />)
    const trigger = view.getByRole('button')
    expect(trigger.textContent).toBe('模型花费 2.00')
    fireEvent.click(trigger)
    const dialog = view.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('模型花费')
    expect(dialog.firstChild?.textContent).toBe('模型花费2.00')
    expect(view.getByLabelText('月份')).toHaveProperty('value', '1970-07')
    expect(view.getByLabelText('范围')).toHaveProperty('value', 'all')
    const details = dialog.querySelector('[data-model-cost-details]') as HTMLElement
    expect(details.textContent).toContain('提供方 / 模型deepseek/chat')
    expect(details.textContent).toContain('未缓存输入1,000,000 tok · 2.00')
    expect(dialog.textContent).toContain('按各会话中该模型请求发生时的配置价格估算')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('switches months and scopes, updating the reading and detail amount', () => {
    const global = globalStore(snapshot({
      routes: new Map([
        [SID, routeProjection(route('deepseek', 'chat', 1_000_000))],
        [OTHER, routeProjection(route('deepseek', 'chat', 3_000_000))],
      ]),
      days: new Map([
        [SID, dayProjection(dayRoute('deepseek', 'chat', 100, 1_000_000))],
        [OTHER, dayProjection(dayRoute('deepseek', 'chat', 200, 3_000_000))],
      ]),
      subagents: new Set([OTHER]),
    }))
    const { props } = harness({
      global,
      values: {
        usageByRoute: routeProjection(route('deepseek', 'chat', 1_000_000)),
        usageByDay: dayProjection(dayRoute('deepseek', 'chat', 100, 1_000_000)),
      },
    })
    const view = render(<ComposerCostPill {...props} />)
    // Default: latest month (1970-07) across all sessions.
    expect(view.getByRole('button').textContent).toBe('模型花费 6.00')

    fireEvent.click(view.getByRole('button'))
    fireEvent.change(view.getByLabelText('月份'), { target: { value: 'all' } })
    expect(view.getByRole('button').textContent).toBe('模型花费 8.00')

    fireEvent.change(view.getByLabelText('范围'), { target: { value: 'main' } })
    expect(view.getByRole('button').textContent).toBe('模型花费 2.00')
    expect(view.getByRole('dialog').textContent).toContain('未缓存输入1,000,000 tok · 2.00')

    fireEvent.change(view.getByLabelText('月份'), { target: { value: '1970-04' } })
    expect(view.getByRole('button').textContent).toBe('模型花费 2.00')
  })

  it('keeps subagent sessions only in the all-sessions scope', () => {
    const global = globalStore(snapshot({
      routes: new Map([
        [SID, routeProjection(route('deepseek', 'chat', 1_000_000))],
        [OTHER, routeProjection(route('deepseek', 'chat', 3_000_000))],
      ]),
      days: new Map([
        [SID, dayProjection(dayRoute('deepseek', 'chat', 200, 1_000_000))],
        [OTHER, dayProjection(dayRoute('deepseek', 'chat', 200, 3_000_000))],
      ]),
      subagents: new Set([OTHER]),
    }))
    const { props } = harness({ global })
    const view = render(<ComposerCostPill {...props} />)
    expect(view.getByRole('button').textContent).toBe('模型花费 8.00')
    fireEvent.click(view.getByRole('button'))
    fireEvent.change(view.getByLabelText('范围'), { target: { value: 'main' } })
    expect(view.getByRole('button').textContent).toBe('模型花费 2.00')
    fireEvent.change(view.getByLabelText('范围'), { target: { value: 'current' } })
    expect(view.getByRole('button').textContent).toBe('模型花费 2.00')
  })

  it('stays absent without a durable selection, tokens, pricing, data, or in compact mode', () => {
    const noSelection = harness({ values: { modelSelection: undefined } })
    expect(render(<ComposerCostPill {...noSelection.props} />).container.textContent).toBe('')
    cleanup()

    const noTokens = harness({ values: { tokenUsage: SLOT } })
    expect(noTokens.ensureModelPricing).not.toHaveBeenCalled()
    expect(noTokens.ensureGlobalUsage).not.toHaveBeenCalled()
    expect(render(<ComposerCostPill {...noTokens.props} />).container.textContent).toBe('')
    cleanup()

    const pricingLoading = harness({ pricing: { status: 'loading', byRoute: new Map() } })
    expect(render(<ComposerCostPill {...pricingLoading.props} />).container.textContent).toBe('')
    cleanup()

    const noData = harness({
      global: globalStore(snapshot({ routes: new Map(), days: new Map() })),
      values: { usageByRoute: undefined, usageByDay: undefined },
    })
    expect(render(<ComposerCostPill {...noData.props} />).container.textContent).toBe('')
    cleanup()

    const compact = harness({ mode: 'compact' })
    expect(compact.ensureGlobalUsage).not.toHaveBeenCalled()
    expect(render(<ComposerCostPill {...compact.props} />).container.textContent).toBe('')
  })
})

/**
 * Selected-model spend reading at the trailing end of the composer row.
 *
 * The reading joins every listed Session's `usageByRoute`/`usageByDay`
 * projections, filters by the chosen month and session scope, and prices the
 * selected model's own buckets. Clicking opens a Token-usage-style breakdown
 * with month and scope selectors.
 */

import { memo, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  estimateUsageByRouteBreakdown, mergeUsageByDay, mergeUsageByRoute,
  usageByDayForMonth, usageMonthKey, usageMonths,
  type TokenUsageProjection, type UsageByDayProjection, type UsageByRouteProjection,
  type UsageCostPart, type UsageMonthOffset,
} from '@deepseek-ai/dsh-token-meter/client'
import type {
  ChatViewSlotProps, GlobalCostInjected, PerformanceUsageInjected,
} from '../contract/slots.ts'
import { modelPricingKey, modelPricingLookup } from '../model-pricing.ts'
import { formatCostAmount } from './cost-format.ts'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import { formatExactTokens } from './token-format.ts'
import css from './StatsPills.module.css'
import dialogCss from './stat-dialog.module.css'

/** Session scope offered by the spend dialog. */
type CostScope = 'all' | 'main' | 'current'

/** Props received by the composer-dock model-spend reading. */
export interface ComposerCostPillProps
  extends InjectFace<PerformanceUsageInjected>, InjectFace<GlobalCostInjected> {
  /** Viewed Session, whose live projection replaces its listed baseline. */
  sessionId: SessionId
  /** The session projection read seat shared with the statistics pills. */
  useProjection: UseProjection
  /** The owning dock's locale seat. */
  t: ChatViewSlotProps['t']
}

/** Whether the session has any billed token activity worth pricing. */
function hasTokens(usage: TokenUsageProjection | undefined): boolean {
  return usage !== undefined
    && (usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0
      || usage.outputTokens > 0)
}

/** One bucket as token count plus its estimate. */
function bucketText(part: UsageCostPart, t: ChatViewSlotProps['t']): string {
  return `${t('message.turnUsage.count', { count: formatExactTokens(part.tokens, t) })} · ${formatCostAmount(part.amount)}`
}

/**
 * Render the selected model's spend and its click-open breakdown.
 * @param props - projection seat, pricing source, global usage source, and locale.
 * @returns the spend reading, or null while compact/without usage/unpriced.
 */
export const ComposerCostPill = memo(function ComposerCostPill({
  sessionId, useProjection, usePerformanceUsage, useModelPricing, ensureModelPricing,
  useGlobalUsage, ensureGlobalUsage, t,
}: ComposerCostPillProps) {
  const mode = usePerformanceUsage(value => value)
  const usage = useProjection('tokenUsage')
  const liveUsageByRoute: UsageByRouteProjection | undefined = useProjection('usageByRoute')
  const liveUsageByDay: UsageByDayProjection | undefined = useProjection('usageByDay')
  const selection: ModelSelectionProjection | undefined = useProjection('modelSelection')
  const pricing = useModelPricing(snapshot => snapshot)
  const globalUsage = useGlobalUsage(snapshot => snapshot)
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
  const [scope, setScope] = useState<CostScope>('all')
  const [selectedMonth, setSelectedMonth] = useState<string>('')
  const tokens = hasTokens(usage)
  const detailed = mode === 'detailed'
  useEffect(() => {
    // Compact keeps the statistics row free of cost and pays no pricing or
    // cross-Session read for a reading it never shows.
    if (detailed && tokens) ensureModelPricing()
  }, [detailed, ensureModelPricing, tokens])
  useEffect(() => {
    // A reset returns the policy to idle and waits for this ask, keeping the
    // cross-Session read behind the connection-reset work that replaces the
    // Session list.
    if (detailed && tokens && globalUsage.status === 'idle') ensureGlobalUsage()
  }, [detailed, ensureGlobalUsage, globalUsage.status, tokens])

  /** Whether one listed Session belongs to the chosen scope. */
  const inScope = (id: SessionId): boolean => scope === 'all'
    ? true
    : scope === 'main'
      ? !globalUsage.subagentSessions.has(id)
      : id === sessionId

  const mergedRoutes = useMemo(() => {
    const projections: UsageByRouteProjection[] = []
    for (const [id, projection] of globalUsage.bySession) {
      if (id === sessionId || !inScope(id)) continue
      projections.push(projection)
    }
    if (inScope(sessionId)) {
      const current = liveUsageByRoute ?? globalUsage.bySession.get(sessionId)
      if (current !== undefined) projections.push(current)
    }
    return mergeUsageByRoute(projections)
  }, [globalUsage.bySession, globalUsage.subagentSessions, liveUsageByRoute, scope, sessionId])

  const mergedDays = useMemo(() => {
    const projections: UsageByDayProjection[] = []
    for (const [id, projection] of globalUsage.daysBySession) {
      if (id === sessionId || !inScope(id)) continue
      projections.push(projection)
    }
    if (inScope(sessionId)) {
      const current = liveUsageByDay ?? globalUsage.daysBySession.get(sessionId)
      if (current !== undefined) projections.push(current)
    }
    return mergeUsageByDay(projections)
  }, [globalUsage.daysBySession, globalUsage.subagentSessions, liveUsageByDay, scope, sessionId])

  const current = selection?.next ?? null
  const offsetOf: UsageMonthOffset = (provider, model) =>
    pricing.byRoute.get(modelPricingKey(provider, model))?.utcOffsetMinutes ?? 480
  const modelDayRoutes = useMemo(() => current === null
    ? []
    : mergedDays.routes.filter(route => route.provider === current.provider && route.model === current.model),
  [current, mergedDays.routes])
  const months = useMemo(
    () => usageMonths({ routes: modelDayRoutes }, offsetOf),
    [modelDayRoutes, pricing.byRoute],
  )
  const defaultMonth = useMemo(() => {
    if (current === null) return ''
    const currentMonth = usageMonthKey(Date.now(), offsetOf(current.provider, current.model))
    return months.includes(currentMonth) ? currentMonth : (months[0] ?? '')
  }, [current, months, pricing.byRoute])
  const month = selectedMonth === '' ? defaultMonth : selectedMonth
  const modelProjection = useMemo(() => {
    if (current === null) return undefined
    if (month === '' || month === 'all') {
      return { routes: mergedRoutes.routes.filter(route => route.provider === current.provider && route.model === current.model) }
    }
    const monthly = usageByDayForMonth({ routes: modelDayRoutes }, month, offsetOf)
    return { routes: monthly.routes }
  }, [current, mergedRoutes.routes, modelDayRoutes, month, pricing.byRoute])
  const modelCost = modelProjection === undefined
    ? undefined
    : estimateUsageByRouteBreakdown(modelProjection, modelPricingLookup(pricing.byRoute))
  const hasScopeData = mergedRoutes.routes.length > 0 || mergedDays.routes.length > 0
  const ready = detailed && tokens && pricing.status === 'ready'
    && globalUsage.status === 'ready' && hasScopeData && modelCost?.kind === 'priced'
  useEffect(() => {
    if (!ready && open) setOpen(false)
  }, [open, ready, setOpen])

  if (!detailed || !tokens || pricing.status !== 'ready') return null
  if (globalUsage.status !== 'ready') {
    return (
      <span ref={rootRef} className={css.costRoot}>
        <span className={`${css.pill} ${css.cost}`} data-composer-cost>
          {t('composerCost.loading')}
        </span>
      </span>
    )
  }
  /* v8 ignore next 4 -- the ready flag above already required scope data and a priced breakdown */
  if (current === null || modelCost === undefined || modelCost.kind !== 'priced' || !hasScopeData) return null
  const scopeOptions: readonly CostScope[] = ['all', 'main', 'current']
  const monthOptions = [
    { value: 'all', label: t('composerCost.monthAll') },
    ...months.map(value => ({ value, label: value })),
  ]
  const scopeLabels: Readonly<Record<CostScope, string>> = {
    all: t('composerCost.scopeAll'),
    main: t('composerCost.scopeMain'),
    current: t('composerCost.scopeCurrent'),
  }
  return (
    <span ref={rootRef} className={css.costRoot}>
      <button
        type="button"
        className={`${css.pill} ${css.cost}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
        data-composer-cost
      >
        {t('composerCost.label', { amount: formatCostAmount(modelCost.amount) })}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('composerCost.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconDatabaseOutlineRegular />
              {t('composerCost.title')}
            </span>
            <span className={dialogCss.titleValue}>{formatCostAmount(modelCost.amount)}</span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          <div className={dialogCss.controls}>
            <label className={dialogCss.control}>
              <span className={dialogCss.controlLabel}>{t('composerCost.month')}</span>
              <select
                className={dialogCss.select}
                value={month === '' ? 'all' : month}
                aria-label={t('composerCost.month')}
                onChange={(event) => { setSelectedMonth(event.target.value) }}
              >
                {monthOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className={dialogCss.control}>
              <span className={dialogCss.controlLabel}>{t('composerCost.scope')}</span>
              <select
                className={dialogCss.select}
                value={scope}
                aria-label={t('composerCost.scope')}
                onChange={(event) => { setScope(event.target.value as CostScope) }}
              >
                {scopeOptions.map(option => <option key={option} value={option}>{scopeLabels[option]}</option>)}
              </select>
            </label>
          </div>
          <dl className={dialogCss.details} data-model-cost-details>
            <dt>{t('message.turnUsage.model')}</dt>
            <dd className={dialogCss.route}>{`${current.provider}/${current.model}`}</dd>
            <dt>{t('message.turnUsage.input')}</dt>
            <dd>{bucketText(modelCost.cacheMiss, t)}</dd>
            <dt>{t('message.turnUsage.cacheRead')}</dt>
            <dd>{bucketText(modelCost.cacheHit, t)}</dd>
            <dt>{t('message.turnUsage.output')}</dt>
            <dd>{bucketText(modelCost.output, t)}</dd>
          </dl>
          <p className={dialogCss.note}>{t('composerCost.note')}</p>
        </div>,
        document.body,
      )}
    </span>
  )
})

/** One pi-ai model's offered reasoning levels, declared as level → wire spelling. */

import type { ReactNode } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * pi-ai's thinking levels in escalation order. Hardcoded here because the set
 * is the adapter's wire vocabulary, not a settings-local list; a declaration
 * stores it as the `reasoningEfforts` dict keys.
 */
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type ReasoningLevel = typeof REASONING_LEVELS[number]

/** One level's checkbox copy. */
const LEVEL_COPY: Readonly<Record<ReasoningLevel, ModelsKey>> = {
  off: 'reasoningOff',
  minimal: 'reasoningMinimal',
  low: 'reasoningLow',
  medium: 'reasoningMedium',
  high: 'reasoningHigh',
  xhigh: 'reasoningXhigh',
  max: 'reasoningMax',
}

/** Props of {@link ModelReasoningEfforts}. */
interface ModelReasoningEffortsProps {
  /** Effective model row, including fields outside the curated editor. */
  model: DeepSeekModelDraft
  /** One-based row position for the accessible group label. */
  position: number
  /** Prevent changes while read-only or saving. */
  disabled: boolean
  /** Section copy. */
  t: (key: ModelsKey) => string
  /** Replace this row, preserving unrelated configuration. */
  onChange: (model: DeepSeekModelDraft) => void
}

/** The draft's declared levels, or undefined when the field is absent or `false`. */
function declaredEfforts(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Edit one pi-ai model's offered reasoning levels. A checked level is declared
 * with its own id as the wire spelling; `off` is declared valueless so dispatch
 * sends nothing for it. No level checked removes the declaration, leaving a
 * hand-declared model exactly as a model that offers no levels.
 * @param props - model draft and row replacement action.
 * @returns the labeled level checkboxes.
 */
export function ModelReasoningEfforts(
  { model, position, disabled, t, onChange }: ModelReasoningEffortsProps,
): ReactNode {
  const declared = declaredEfforts(model['reasoningEfforts'])
  const checked = (level: ReasoningLevel): boolean => declared !== undefined && Object.hasOwn(declared, level)
  const toggle = (level: ReasoningLevel, on: boolean): void => {
    const levels: Record<string, string | null> = {}
    for (const candidate of REASONING_LEVELS) {
      if (candidate === level ? !on : !checked(candidate)) continue
      const wire = declared?.[candidate]
      // A declared level keeps a spelling already in the draft; only `off`
      // turns valueless, which is the one key pi-ai reads as "send nothing".
      levels[candidate] = candidate === 'off'
        ? null
        : typeof wire === 'string' && wire.length > 0 ? wire : candidate
    }
    const next = { ...model }
    if (Object.keys(levels).length === 0) Reflect.deleteProperty(next, 'reasoningEfforts')
    else next['reasoningEfforts'] = levels
    onChange(next)
  }
  // A dict with only `off` is refused by the adapter, so it must never be
  // saved: the row-level validator blocks the write and this line explains it.
  const offOnly = declared !== undefined && Object.keys(declared).length > 0
    && !REASONING_LEVELS.some(level => level !== 'off' && Object.hasOwn(declared, level))
  return (
    <fieldset className={styles['modelInputTypes']} aria-label={`${t('reasoningEfforts')} ${String(position)}`}>
      <legend className={styles['modelFieldLabel']}>{t('reasoningEfforts')}</legend>
      <div className={styles['modelInputChoices']}>
        {REASONING_LEVELS.map(level => (
          <Checkbox
            key={level}
            label={t(LEVEL_COPY[level])}
            checked={checked(level)}
            disabled={disabled}
            onChange={(on) => { toggle(level, on) }}
          />
        ))}
      </div>
      {offOnly ? <p className={styles['error']}>{t('reasoningNeedsThinkingLevel')}</p> : null}
    </fieldset>
  )
}

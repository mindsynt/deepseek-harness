/**
 * Per-model pricing editor shared by the DeepSeek and pi-ai catalog editors.
 *
 * One model's `pricing` record holds three required base prices per 1,000,000
 * tokens, an optional UTC offset in minutes, and optional ordered half-hour
 * time bands. A price is edited as text and only parsed into the draft on a
 * readable keystroke, so `1.` is never rewritten to `1` while the field is
 * focused; unreadable text stays visible past blur and the row validator
 * refuses the save. Unknown keys already on the record survive every edit.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconPlusOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The three base price keys in display order. */
const PRICE_FIELDS = ['inputCacheHit', 'inputCacheMiss', 'output'] as const
type PriceField = typeof PRICE_FIELDS[number]

/** One price field's label key. */
const PRICE_LABEL: Readonly<Record<PriceField, ModelsKey>> = {
  inputCacheHit: 'modelPricingCacheHit',
  inputCacheMiss: 'modelPricingCacheMiss',
  output: 'modelPricingOutput',
}

/** Accepted price spellings: a non-negative decimal without an exponent. */
const PRICE_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)$/

/** Accepted UTC offsets: an optionally negative whole number of minutes. */
const OFFSET_PATTERN = /^-?\d+$/

/** Accepted band times: a `HH:mm` mark on a half-hour boundary. */
const HALF_HOUR_PATTERN = /^(?:[01]\d|2[0-3]):(?:00|30)$/

/** A plain record, or undefined for arrays, null, and primitives. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** One model's ordered band entries, or an empty list for an absent or malformed field. */
function bandsOf(pricing: Record<string, unknown> | undefined): readonly unknown[] {
  const bands = pricing?.['timeBands']
  return Array.isArray(bands) ? bands : []
}

/** Whether one stored value is a usable non-negative price. */
function priceValid(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Whether one stored value is a half-hour-aligned `HH:mm` time. */
function timeValid(value: unknown): value is string {
  return typeof value === 'string' && HALF_HOUR_PATTERN.test(value)
}

/**
 * Read a typed price.
 * @param text - raw field text.
 * @returns the parsed price; `undefined` when blank, `NaN` when unreadable
 * (the caller keeps the text and the row validator refuses the save).
 */
export function parsePrice(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  if (!PRICE_PATTERN.test(trimmed)) return Number.NaN
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * Spell a stored price back into the field.
 * @param value - stored non-negative price.
 * @returns the field text.
 */
export function formatPrice(value: number): string {
  return String(value)
}

/**
 * Validate the pricing record the adapters and token meter read.
 * @param value - one model row's `pricing` value, or undefined when absent.
 * @returns the section copy key of the first failure, or undefined when valid.
 */
export function validateModelPricing(
  value: unknown,
): 'modelPricingInvalid' | 'modelPricingTimeInvalid' | 'modelPricingOffsetInvalid' | undefined {
  if (value === undefined) return undefined
  const pricing = recordOf(value)
  if (pricing === undefined) return 'modelPricingInvalid'
  if (PRICE_FIELDS.some(field => !priceValid(pricing[field]))) return 'modelPricingInvalid'
  const utcOffset = pricing['utcOffsetMinutes']
  if (utcOffset !== undefined
    && (typeof utcOffset !== 'number' || !Number.isInteger(utcOffset) || utcOffset < -720 || utcOffset > 840)) {
    return 'modelPricingOffsetInvalid'
  }
  const bands = pricing['timeBands']
  if (bands !== undefined) {
    if (!Array.isArray(bands)) return 'modelPricingTimeInvalid'
    for (const entry of bands) {
      const band = recordOf(entry)
      if (band === undefined) return 'modelPricingTimeInvalid'
      const start = band['start']
      const end = band['end']
      if (!timeValid(start) || !timeValid(end) || start === end) return 'modelPricingTimeInvalid'
      for (const field of PRICE_FIELDS) {
        if (!priceValid(band[field])) return 'modelPricingInvalid'
      }
    }
  }
  return undefined
}

/** Props of {@link ModelPricingFields}. */
interface ModelPricingFieldsProps {
  /** Effective model row, including fields outside the curated editor. */
  model: DeepSeekModelDraft
  /** One-based model row position for accessible labels. */
  position: number
  /** Prevent changes while read-only or saving. */
  disabled: boolean
  /** Section copy. */
  t: (key: ModelsKey) => string
  /** Replace this row, preserving unrelated configuration. */
  onChange: (model: DeepSeekModelDraft) => void
}

/**
 * Edit one model's base prices, optional UTC offset, and ordered time bands.
 * @param props - model draft, row position, and row replacement action.
 * @returns the pricing fieldset.
 */
export function ModelPricingFields({ model, position, disabled, t, onChange }: ModelPricingFieldsProps): ReactNode {
  // Per-field text buffers: a partially typed decimal keeps its keystrokes
  // instead of being re-derived from the parsed count, and unreadable text
  // stays on screen after blur so the row validator names something visible.
  // The map is keyed by buffer seat, not by model position: this component
  // instance owns exactly one model row.
  const [editing, setEditing] = useState<ReadonlyMap<string, string>>(() => new Map())
  const pricing = recordOf(model['pricing'])
  const bands = bandsOf(pricing)

  /** Apply one pricing-record mutation and replace the model with the result. */
  const writePricing = (apply: (next: Record<string, unknown>) => void): void => {
    const next: Record<string, unknown> = { ...pricing }
    apply(next)
    const copy = { ...model }
    if (Object.keys(next).length === 0) Reflect.deleteProperty(copy, 'pricing')
    else copy['pricing'] = next
    onChange(copy)
  }

  /** Keep one field's raw text, then parse it into the draft. */
  const edit = (
    buffer: string,
    text: string,
    parsed: number | string | undefined,
    apply: (next: Record<string, unknown>, parsed: number | string | undefined) => void,
  ): void => {
    setEditing(current => new Map(current).set(buffer, text))
    writePricing((next) => { apply(next, parsed) })
  }

  /** Drop one field's buffer when its text parses into the draft. */
  const settle = (buffer: string, parsed: number | undefined): void => {
    if (parsed !== undefined && Number.isNaN(parsed)) return
    setEditing((current) => {
      const next = new Map(current)
      next.delete(buffer)
      return next
    })
  }

  /** What a buffer or a stored number shows in one price input. */
  const priceText = (buffer: string, stored: unknown): string => {
    const typed = editing.get(buffer)
    if (typed !== undefined) return typed
    return typeof stored === 'number' && Number.isFinite(stored) ? formatPrice(stored) : ''
  }

  const setBasePrice = (field: PriceField, fieldText: string): void => {
    const parsed = parsePrice(fieldText)
    edit(`price:${field}`, fieldText, parsed, (next, value) => {
      if (value === undefined) Reflect.deleteProperty(next, field)
      else next[field] = value
    })
  }

  const setOffset = (fieldText: string): void => {
    const trimmed = fieldText.trim()
    const parsed = trimmed.length === 0
      ? undefined
      : OFFSET_PATTERN.test(trimmed) ? Number(trimmed) : Number.NaN
    edit('offset', fieldText, parsed, (next, value) => {
      if (value === undefined) Reflect.deleteProperty(next, 'utcOffsetMinutes')
      else next['utcOffsetMinutes'] = value
    })
  }

  /** Copy a band and replace one part, or delete a blank price part. */
  const setBandPart = (index: number, part: 'start' | 'end' | PriceField, partText: string): void => {
    const parsed = part === 'start' || part === 'end' ? partText : parsePrice(partText)
    edit(`band:${String(index)}:${part}`, partText, parsed, (next, value) => {
      const copy = [...bandsOf(next)]
      const band = { ...recordOf(copy[index]) }
      if (value === undefined) Reflect.deleteProperty(band, part)
      else band[part] = value
      copy[index] = band
      next['timeBands'] = copy
    })
  }

  const addBand = (): void => {
    writePricing((next) => {
      next['timeBands'] = [...bandsOf(next), { start: '', end: '' }]
    })
  }

  const removeBand = (index: number): void => {
    // Buffers after the removed band move down with their rows.
    setEditing((current) => {
      const next = new Map<string, string>()
      for (const [buffer, text] of current) {
        const match = /^band:(\d+):(.+)$/.exec(buffer)
        if (match === null) { next.set(buffer, text); continue }
        const at = Number(match[1])
        if (at === index) continue
        next.set(at > index ? `band:${String(at - 1)}:${match[2] as string}` : buffer, text)
      }
      return next
    })
    writePricing((next) => {
      const copy = [...bandsOf(next)]
      copy.splice(index, 1)
      if (copy.length === 0) Reflect.deleteProperty(next, 'timeBands')
      else next['timeBands'] = copy
    })
  }

  const bandLabel = (index: number): string =>
    `${t('modelPricingBand')} ${String(position)}-${String(index + 1)}`

  return (
    <fieldset
      className={styles['modelPricing']}
      aria-label={`${t('modelPricing')} ${String(position)}`}
    >
      <legend className={styles['modelFieldLabel']}>{t('modelPricing')}</legend>
      <p className={styles['modelPricingHint']}>{t('modelPricingHint')}</p>
      <div className={styles['modelPricingBase']}>
        {PRICE_FIELDS.map((field) => {
          const label = t(PRICE_LABEL[field])
          return (
            <label className={styles['modelField']} key={field}>
              <span className={styles['modelFieldLabel']}>{label}</span>
              <input
                className={styles['input']}
                type="text"
                inputMode="decimal"
                value={priceText(`price:${field}`, pricing?.[field])}
                aria-label={`${label} ${String(position)}`}
                disabled={disabled}
                onChange={(event) => { setBasePrice(field, event.target.value) }}
                onBlur={() => { settle(`price:${field}`, parsePrice(editing.get(`price:${field}`) ?? '')) }}
              />
            </label>
          )
        })}
      </div>
      <fieldset
        className={styles['modelPricingBands']}
        aria-label={`${t('modelPricingBands')} ${String(position)}`}
      >
        <legend className={styles['modelFieldLabel']}>{t('modelPricingBands')}</legend>
        <label className={styles['modelField']}>
          <span className={styles['modelFieldLabel']}>{t('modelPricingUtcOffset')}</span>
          <input
            className={styles['input']}
            type="text"
            inputMode="numeric"
            value={priceText('offset', pricing?.['utcOffsetMinutes'])}
            aria-label={`${t('modelPricingUtcOffset')} ${String(position)}`}
            disabled={disabled}
            onChange={(event) => { setOffset(event.target.value) }}
            onBlur={() => {
              const buffered = editing.get('offset') ?? ''
              const trimmed = buffered.trim()
              settle('offset', trimmed.length === 0 ? undefined : OFFSET_PATTERN.test(trimmed) ? Number(trimmed) : Number.NaN)
            }}
          />
          <span className={styles['modelPricingHint']}>{t('modelPricingUtcOffsetHint')}</span>
        </label>
        {bands.map((entry, index) => {
          const band = recordOf(entry)
          const label = bandLabel(index)
          return (
            <fieldset className={styles['modelPricingBand']} key={index} aria-label={label}>
              <span className={styles['modelPricingBandTitle']}>{`${t('modelPricingBand')} ${String(index + 1)}`}</span>
              <button
                type="button"
                className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
                aria-label={`${t('modelPricingRemoveBand')} ${String(position)}-${String(index + 1)}`}
                title={t('modelPricingRemoveBand')}
                disabled={disabled}
                onClick={() => { removeBand(index) }}
              >
                <IconTrashOutlineRegular size={14} />
              </button>
              <div className={styles['modelPricingBandGrid']}>
                <div className={styles['modelPricingBandTimes']}>
                  {(['start', 'end'] as const).map((part) => {
                    const partLabel = t(part === 'start' ? 'modelPricingBandStart' : 'modelPricingBandEnd')
                    const stored = band?.[part]
                    return (
                      <label className={styles['modelField']} key={part}>
                        <span className={styles['modelFieldLabel']}>{partLabel}</span>
                        <input
                          className={styles['input']}
                          type="time"
                          step={1800}
                          value={typeof stored === 'string' ? stored : ''}
                          aria-label={`${partLabel} ${String(position)}-${String(index + 1)}`}
                          disabled={disabled}
                          onChange={(event) => { setBandPart(index, part, event.target.value) }}
                        />
                      </label>
                    )
                  })}
                </div>
                {PRICE_FIELDS.map((field) => {
                  const fieldLabel = t(PRICE_LABEL[field])
                  return (
                    <label className={styles['modelField']} key={field}>
                      <span className={styles['modelFieldLabel']}>{fieldLabel}</span>
                      <input
                        className={styles['input']}
                        type="text"
                        inputMode="decimal"
                        value={priceText(`band:${String(index)}:${field}`, band?.[field])}
                        aria-label={`${fieldLabel} ${String(position)}-${String(index + 1)}`}
                        disabled={disabled}
                        onChange={(event) => { setBandPart(index, field, event.target.value) }}
                        onBlur={() => {
                          const buffer = `band:${String(index)}:${field}`
                          settle(buffer, parsePrice(editing.get(buffer) ?? ''))
                        }}
                      />
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )
        })}
        <button
          type="button"
          className={styles['addModelButton']}
          aria-label={`${t('modelPricingAddBand')} ${String(position)}`}
          disabled={disabled}
          onClick={addBand}
        >
          <IconPlusOutlineRegular size={14} />
          {t('modelPricingAddBand')}
        </button>
      </fieldset>
    </fieldset>
  )
}

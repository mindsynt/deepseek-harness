// @vitest-environment jsdom
/** Per-model pricing helpers and the shared base/offset/time-band editor. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { validateDeepSeekModels } from '../src/client/DeepSeekModelsEditor.tsx'
import type { DeepSeekModelDraft } from '../src/client/DeepSeekModelsEditor.tsx'
import {
  formatPrice, ModelPricingFields, parsePrice, validateModelPricing,
} from '../src/client/ModelPricingFields.tsx'
import { en } from '../src/client/locales.ts'
import type { ModelsKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: ModelsKey): string => en[key]

const BASE = { inputCacheHit: 1, inputCacheMiss: 2, output: 3 }
const BAND_PRICES = { inputCacheHit: 0.5, inputCacheMiss: 1, output: 2 }

/** Render one row and expose the last draft the editor produced. */
function mountPricing(model: DeepSeekModelDraft, position = 1, disabled = false) {
  const onChange = vi.fn<(next: DeepSeekModelDraft) => void>()
  const fields = (
    <ModelPricingFields
      model={model}
      position={position}
      disabled={disabled}
      t={t}
      onChange={onChange}
    />
  )
  const view = render(fields)
  return {
    onChange,
    view,
    /** Rerender with the draft the last change produced. */
    settle(): DeepSeekModelDraft {
      const last = onChange.mock.calls.at(-1)?.[0]
      if (last === undefined) throw new Error('the editor produced no change')
      view.rerender(
        <ModelPricingFields
          model={last}
          position={position}
          disabled={disabled}
          t={t}
          onChange={onChange}
        />,
      )
      return last
    },
    last(): DeepSeekModelDraft {
      const last = onChange.mock.calls.at(-1)?.[0]
      if (last === undefined) throw new Error('the editor produced no change')
      return last
    },
  }
}

/** Change one input by its accessible label. */
function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText<HTMLInputElement>(label), { target: { value } })
}

it('reads blank, decimal, trailing-dot, and unreadable price text', () => {
  expect(parsePrice('')).toBeUndefined()
  expect(parsePrice('   ')).toBeUndefined()
  expect(parsePrice('0')).toBe(0)
  expect(parsePrice('12.50')).toBe(12.5)
  expect(parsePrice('.5')).toBe(0.5)
  expect(parsePrice('1.')).toBe(1)
  expect(parsePrice('-1')).toBeNaN()
  expect(parsePrice('1e3')).toBeNaN()
  expect(parsePrice('abc')).toBeNaN()
  expect(parsePrice('9'.repeat(400))).toBeNaN()
  expect(formatPrice(0.25)).toBe('0.25')
  expect(formatPrice(2)).toBe('2')
})

it('names the first pricing failure through the shared model validator', () => {
  expect(validateDeepSeekModels([{ id: 'm' }])).toBeUndefined()
  expect(validateDeepSeekModels([{ id: 'm', pricing: BASE }])).toBeUndefined()
  expect(validateDeepSeekModels([{ id: 'm', pricing: { ...BASE, output: '3' } }]))
    .toEqual({ index: 0, key: 'modelPricingInvalid' })
  expect(validateDeepSeekModels([{ id: 'm', pricing: { ...BASE, timeBands: 'soon' } }]))
    .toEqual({ index: 0, key: 'modelPricingTimeInvalid' })
  expect(validateDeepSeekModels([{ id: 'm', pricing: { ...BASE, utcOffsetMinutes: 900 } }]))
    .toEqual({ index: 0, key: 'modelPricingOffsetInvalid' })
})

it('validates base prices, offsets, and half-hour bands', () => {
  const band = { start: '09:00', end: '18:00', ...BAND_PRICES }
  expect(validateModelPricing(undefined)).toBeUndefined()
  expect(validateModelPricing(BASE)).toBeUndefined()
  expect(validateModelPricing([])).toBe('modelPricingInvalid')
  expect(validateModelPricing({ inputCacheHit: 1, inputCacheMiss: 2 })).toBe('modelPricingInvalid')
  expect(validateModelPricing({ ...BASE, inputCacheMiss: -1 })).toBe('modelPricingInvalid')
  expect(validateModelPricing({ ...BASE, output: Number.NaN })).toBe('modelPricingInvalid')
  expect(validateModelPricing({ ...BASE, output: '3' })).toBe('modelPricingInvalid')
  expect(validateModelPricing({ ...BASE, utcOffsetMinutes: -720 })).toBeUndefined()
  expect(validateModelPricing({ ...BASE, utcOffsetMinutes: 840 })).toBeUndefined()
  expect(validateModelPricing({ ...BASE, utcOffsetMinutes: 1.5 })).toBe('modelPricingOffsetInvalid')
  expect(validateModelPricing({ ...BASE, utcOffsetMinutes: Number.NaN })).toBe('modelPricingOffsetInvalid')
  expect(validateModelPricing({ ...BASE, utcOffsetMinutes: '480' })).toBe('modelPricingOffsetInvalid')
  expect(validateModelPricing({ ...BASE, utcOffsetMinutes: -721 })).toBe('modelPricingOffsetInvalid')
  expect(validateModelPricing({ ...BASE, utcOffsetMinutes: 841 })).toBe('modelPricingOffsetInvalid')
  expect(validateModelPricing({ ...BASE, timeBands: [] })).toBeUndefined()
  expect(validateModelPricing({ ...BASE, timeBands: [band] })).toBeUndefined()
  expect(validateModelPricing({ ...BASE, timeBands: 'soon' })).toBe('modelPricingTimeInvalid')
  expect(validateModelPricing({ ...BASE, timeBands: [null] })).toBe('modelPricingTimeInvalid')
  expect(validateModelPricing({ ...BASE, timeBands: [{ ...band, start: 900 }] })).toBe('modelPricingTimeInvalid')
  expect(validateModelPricing({ ...BASE, timeBands: [{ ...band, start: '24:00' }] })).toBe('modelPricingTimeInvalid')
  expect(validateModelPricing({ ...BASE, timeBands: [{ ...band, start: '09:15' }] })).toBe('modelPricingTimeInvalid')
  expect(validateModelPricing({ ...BASE, timeBands: [{ ...band, end: '09:00' }] })).toBe('modelPricingTimeInvalid')
  expect(validateModelPricing({ ...BASE, timeBands: [{ ...band, output: -2 }] })).toBe('modelPricingInvalid')
  expect(validateModelPricing({ ...BASE, timeBands: [{ start: '09:00', end: '18:00' }] })).toBe('modelPricingInvalid')
  expect(validateModelPricing({ ...BASE, timeBands: [band, { ...band, end: '09:00' }] }))
    .toBe('modelPricingTimeInvalid')
})

it('edits the three base prices behind per-field text buffers and clears the key', () => {
  const mounted = mountPricing({ id: 'm' })
  const hit = screen.getByLabelText<HTMLInputElement>(`${en.modelPricingCacheHit} 1`)
  const miss = screen.getByLabelText<HTMLInputElement>(`${en.modelPricingCacheMiss} 1`)
  // An untouched price has no buffer to settle.
  fireEvent.blur(miss)

  fireEvent.change(hit, { target: { value: '0.' } })
  expect(mounted.last()).toEqual({ id: 'm', pricing: { inputCacheHit: 0 } })
  mounted.settle()
  // The trailing dot is a partial keystroke, not a value to rewrite.
  expect(hit.value).toBe('0.')
  fireEvent.blur(hit)
  expect(hit.value).toBe('0')

  type(`${en.modelPricingCacheMiss} 1`, '1.5')
  mounted.settle()
  type(`${en.modelPricingOutput} 1`, '2')
  expect(mounted.last()).toEqual({ id: 'm', pricing: { inputCacheHit: 0, inputCacheMiss: 1.5, output: 2 } })

  mounted.settle()
  type(`${en.modelPricingCacheHit} 1`, '')
  mounted.settle()
  type(`${en.modelPricingCacheMiss} 1`, '')
  mounted.settle()
  type(`${en.modelPricingOutput} 1`, '')
  expect(mounted.last()).toEqual({ id: 'm' })
  expect(validateModelPricing(undefined)).toBeUndefined()
})

it('keeps unreadable price text visible past blur and rejects the draft', () => {
  const mounted = mountPricing({ id: 'm', pricing: BASE })
  const output = screen.getByLabelText<HTMLInputElement>(`${en.modelPricingOutput} 1`)
  fireEvent.change(output, { target: { value: 'abc' } })
  fireEvent.blur(output)
  expect(output.value).toBe('abc')
  const draft = mounted.last()
  expect(draft).toEqual({ id: 'm', pricing: { ...BASE, output: Number.NaN } })
  expect(validateModelPricing(draft['pricing'])).toBe('modelPricingInvalid')
})

it('preserves unknown pricing fields and values the editor does not edit', () => {
  const mounted = mountPricing({
    id: 'm',
    pricing: { ...BASE, region: 'cn', nested: { currency: 'CNY' } },
  })
  type(`${en.modelPricingOutput} 1`, '4')
  expect(mounted.last()).toEqual({
    id: 'm',
    pricing: { ...BASE, output: 4, region: 'cn', nested: { currency: 'CNY' } },
  })
})

it('treats a malformed pricing or band record as an empty draft', () => {
  const mounted = mountPricing({ id: 'm', pricing: 'soon' })
  type(`${en.modelPricingCacheHit} 1`, '1')
  expect(mounted.last()).toEqual({ id: 'm', pricing: { inputCacheHit: 1 } })
  cleanup()

  const malformed = mountPricing({ id: 'm', pricing: { ...BASE, timeBands: 'later' } })
  fireEvent.click(screen.getByLabelText(`${en.modelPricingAddBand} 1`))
  expect(malformed.last()).toEqual({
    id: 'm',
    pricing: { ...BASE, timeBands: [{ start: '', end: '' }] },
  })
  cleanup()

  const bands = mountPricing({ id: 'm', pricing: { ...BASE, timeBands: ['bad'] } })
  expect(screen.getByLabelText<HTMLInputElement>(`${en.modelPricingBandStart} 1-1`).value).toBe('')
  type(`${en.modelPricingBandStart} 1-1`, '09:00')
  expect(bands.last()).toEqual({ id: 'm', pricing: { ...BASE, timeBands: [{ start: '09:00' }] } })
})

it('edits an offset, keeps invalid text, and drops a blank offset', () => {
  const mounted = mountPricing({ id: 'm', pricing: BASE })
  const offset = screen.getByLabelText<HTMLInputElement>(`${en.modelPricingUtcOffset} 1`)
  // An untouched offset has no buffer to settle.
  fireEvent.blur(offset)
  type(`${en.modelPricingUtcOffset} 1`, '480')
  expect(mounted.last()).toEqual({ id: 'm', pricing: { ...BASE, utcOffsetMinutes: 480 } })
  mounted.settle()
  fireEvent.blur(offset)
  expect(offset.value).toBe('480')

  fireEvent.change(offset, { target: { value: 'north' } })
  fireEvent.blur(offset)
  expect(offset.value).toBe('north')
  const invalid = mounted.last()
  expect(invalid['pricing']).toEqual({ ...BASE, utcOffsetMinutes: Number.NaN })
  expect(validateModelPricing(invalid['pricing'])).toBe('modelPricingOffsetInvalid')

  mounted.settle()
  type(`${en.modelPricingUtcOffset} 1`, '')
  fireEvent.blur(offset)
  expect(mounted.last()).toEqual({ id: 'm', pricing: BASE })
})

it('adds, edits, and removes a band, preserving the bands after the removed one', () => {
  const mounted = mountPricing({ id: 'm', pricing: { ...BASE, utcOffsetMinutes: 480 } })
  fireEvent.click(screen.getByLabelText(`${en.modelPricingAddBand} 1`))
  expect(mounted.last()).toEqual({
    id: 'm',
    pricing: { ...BASE, utcOffsetMinutes: 480, timeBands: [{ start: '', end: '' }] },
  })

  mounted.settle()
  // An untouched band price has no buffer to settle.
  fireEvent.blur(screen.getByLabelText<HTMLInputElement>(`${en.modelPricingOutput} 1-1`))
  type(`${en.modelPricingBandStart} 1-1`, '09:00')
  mounted.settle()
  type(`${en.modelPricingBandEnd} 1-1`, '18:00')
  mounted.settle()
  type(`${en.modelPricingCacheHit} 1-1`, '0.5')
  mounted.settle()
  type(`${en.modelPricingCacheMiss} 1-1`, '1')
  mounted.settle()
  type(`${en.modelPricingOutput} 1-1`, '2')
  expect(mounted.last()['pricing']).toEqual({
    ...BASE,
    utcOffsetMinutes: 480,
    timeBands: [{ start: '09:00', end: '18:00', ...BAND_PRICES }],
  })

  mounted.settle()
  fireEvent.click(screen.getByLabelText(`${en.modelPricingAddBand} 1`))
  mounted.settle()
  type(`${en.modelPricingBandStart} 1-2`, '22:00')
  mounted.settle()
  type(`${en.modelPricingBandEnd} 1-2`, '06:00')
  mounted.settle()
  type(`${en.modelPricingOutput} 1-2`, 'bad')
  mounted.settle()
  fireEvent.blur(screen.getByLabelText<HTMLInputElement>(`${en.modelPricingOutput} 1-2`))
  expect(screen.getByLabelText<HTMLInputElement>(`${en.modelPricingOutput} 1-2`).value).toBe('bad')

  // Removing the first band carries the second band's buffer down with it.
  fireEvent.click(screen.getByLabelText(`${en.modelPricingRemoveBand} 1-1`))
  const afterRemove = mounted.settle()
  expect(afterRemove['pricing']).toEqual({
    ...BASE,
    utcOffsetMinutes: 480,
    timeBands: [{ start: '22:00', end: '06:00', output: Number.NaN }],
  })
  expect(screen.getByLabelText<HTMLInputElement>(`${en.modelPricingOutput} 1-1`).value).toBe('bad')
  expect(validateModelPricing(afterRemove['pricing'])).toBe('modelPricingInvalid')

  // Removing the last band drops the key; base prices remain.
  fireEvent.click(screen.getByLabelText(`${en.modelPricingRemoveBand} 1-1`))
  expect(mounted.last()).toEqual({ id: 'm', pricing: { ...BASE, utcOffsetMinutes: 480 } })
})

it('clears a band price and keeps the hour and sibling price parts', () => {
  const mounted = mountPricing({
    id: 'm',
    pricing: { ...BASE, timeBands: [{ start: '09:00', end: '18:00', ...BAND_PRICES }] },
  })
  const output = screen.getByLabelText<HTMLInputElement>(`${en.modelPricingOutput} 1-1`)
  type(`${en.modelPricingOutput} 1-1`, '')
  expect(output.value).toBe('')
  const cleared = mounted.last()
  expect(cleared['pricing']).toEqual({
    ...BASE,
    timeBands: [{ start: '09:00', end: '18:00', inputCacheHit: 0.5, inputCacheMiss: 1 }],
  })
  expect(validateModelPricing(cleared['pricing'])).toBe('modelPricingInvalid')
})

it('keeps a buffer that sits before a removed band', () => {
  const mounted = mountPricing({
    id: 'm',
    pricing: {
      ...BASE,
      timeBands: [
        { start: '09:00', end: '18:00', ...BAND_PRICES },
        { start: '22:00', end: '06:00', ...BAND_PRICES },
      ],
    },
  })
  const firstOutput = screen.getByLabelText<HTMLInputElement>(`${en.modelPricingOutput} 1-1`)
  type(`${en.modelPricingOutput} 1-1`, '0.')
  mounted.settle()
  expect(firstOutput.value).toBe('0.')
  fireEvent.click(screen.getByLabelText(`${en.modelPricingRemoveBand} 1-2`))
  mounted.settle()
  expect(screen.getByLabelText<HTMLInputElement>(`${en.modelPricingOutput} 1-1`)).toBe(firstOutput)
  expect(firstOutput.value).toBe('0.')
})

it('dropping the last pricing field removes the whole pricing key', () => {
  const mounted = mountPricing({
    id: 'm',
    pricing: { ...BASE, utcOffsetMinutes: 480, timeBands: [{ start: '09:00', end: '18:00', ...BAND_PRICES }] },
  })
  type(`${en.modelPricingCacheHit} 1`, '')
  mounted.settle()
  type(`${en.modelPricingCacheMiss} 1`, '')
  mounted.settle()
  type(`${en.modelPricingOutput} 1`, '')
  mounted.settle()
  type(`${en.modelPricingUtcOffset} 1`, '')
  mounted.settle()
  const withBand = mounted.last()
  expect(withBand['pricing']).toEqual({ timeBands: [{ start: '09:00', end: '18:00', ...BAND_PRICES }] })
  fireEvent.click(screen.getByLabelText(`${en.modelPricingRemoveBand} 1-1`))
  expect(mounted.last()).toEqual({ id: 'm' })
})

it('labels every control with the model position and, per band, the band position', () => {
  render(<ModelPricingFields
    model={{ id: 'm', pricing: { ...BASE, timeBands: [{ start: '09:00', end: '18:00', ...BAND_PRICES }] } }}
    position={2}
    disabled={true}
    t={t}
    onChange={vi.fn()}
  />)
  expect(screen.getByLabelText(`${en.modelPricing} 2`)).toBeTruthy()
  expect(screen.getByLabelText(`${en.modelPricingCacheHit} 2`).hasAttribute('disabled')).toBe(true)
  expect(screen.getByLabelText(`${en.modelPricingUtcOffset} 2`)).toBeTruthy()
  expect(screen.getByLabelText(`${en.modelPricingBandStart} 2-1`)).toBeTruthy()
  expect(screen.getByLabelText(`${en.modelPricingBandEnd} 2-1`)).toBeTruthy()
  expect(screen.getByLabelText(`${en.modelPricingOutput} 2-1`)).toBeTruthy()
  expect(screen.getByLabelText(`${en.modelPricingRemoveBand} 2-1`).hasAttribute('disabled')).toBe(true)
  expect(screen.getByLabelText(`${en.modelPricingAddBand} 2`)).toBeTruthy()
})

// @vitest-environment jsdom
/** Catalog reads preserve draft ownership and discard responses for a previous provider. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { validateDeepSeekModels } from '../src/client/DeepSeekModelsEditor.tsx'
import { ModelListEditor } from '../src/client/ModelListEditor.tsx'
import type { ModelDiscoveryOutcome, ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function operations(discoverModels: ModelsOperations['discoverModels']): ModelsOperations {
  return {
    discoverModels,
    describeCredential: vi.fn(),
    storeCredential: vi.fn(),
    removeCredential: vi.fn(),
    writeSettings: vi.fn(),
  }
}

it('ignores a late catalog response after the provider changes', async () => {
  const oldCatalog = Promise.withResolvers<ModelDiscoveryOutcome>()
  const newCatalog = Promise.withResolvers<ModelDiscoveryOutcome>()
  const actions = operations(vi.fn()
    .mockReturnValueOnce(oldCatalog.promise)
    .mockReturnValueOnce(newCatalog.promise))
  const onChange = vi.fn()
  const props = {
    models: [{ id: 'm' }], onChange, operations: actions,
    disabled: false, t: (key: keyof typeof en) => en[key], onBusyChange: () => {},
  }
  const { rerender } = render(<ModelListEditor {...props} catalogProvider="old" probe={{ settingsNs: 'llm-pi-ai', provider: 'old' }} />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).disabled).toBe(true)
  rerender(<ModelListEditor {...props} catalogProvider="new" probe={{ settingsNs: 'llm-pi-ai', provider: 'new' }} />)
  await act(async () => { newCatalog.resolve({ kind: 'found', models: [{ id: 'm', inputModalities: ['text', 'image'] }] }) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)
  await act(async () => { oldCatalog.resolve({ kind: 'found', models: [{ id: 'm', inputModalities: ['text'] }] }) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
})

it('uses provider input defaults for a model absent from the installed catalog', async () => {
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'custom' }]} onChange={onChange} defaultInput={['image']} catalogProvider="openai"
    probe={{ settingsNs: 'llm-pi-ai', provider: 'openai' }} disabled={false} t={key => en[key]} onBusyChange={() => {}}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const text = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputText })
  await waitFor(() => { expect(text.disabled).toBe(false) })
  expect(text.checked).toBe(false)
  fireEvent.click(text)
  expect(onChange).toHaveBeenCalledWith([{ id: 'custom', input: ['text', 'image'] }])
})

it('inherits catalog inputs once an incomplete draft has a model id', async () => {
  const onChange = vi.fn()
  const props = {
    onChange, catalogProvider: 'openai',
    probe: { settingsNs: 'llm-pi-ai', provider: 'openai' },
    disabled: false, t: (key: keyof typeof en) => en[key], onBusyChange: () => {},
    operations: operations(() => Promise.resolve({
      kind: 'found', models: [{ id: 'vision', inputModalities: ['text', 'image'] }],
    })),
  }
  const { rerender } = render(<ModelListEditor {...props} models={[{}]} />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const image = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage })
  await waitFor(() => { expect(image.disabled).toBe(false) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputText }).checked).toBe(true)
  expect(image.checked).toBe(false)
  expect(onChange).not.toHaveBeenCalled()

  const id = screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`)
  expect(id.value).toBe('')
  fireEvent.change(id, { target: { value: 'vision' } })
  expect(onChange).toHaveBeenCalledExactlyOnceWith([{ id: 'vision' }])
  rerender(<ModelListEditor {...props} models={[{ id: 'vision' }]} />)
  expect(image.checked).toBe(true)
  expect(onChange).toHaveBeenCalledTimes(1)
})

it('restores inherited image input after a failed catalog read is retried manually', async () => {
  const discover = vi.fn<ModelsOperations['discoverModels']>()
    .mockResolvedValueOnce({ kind: 'refused', message: 'Catalog unavailable' })
    .mockResolvedValueOnce({ kind: 'found', models: [{ id: 'vision', inputModalities: ['text', 'image'] }] })
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'vision' }]} onChange={onChange} catalogProvider="openai"
    probe={{ settingsNs: 'llm-pi-ai', provider: 'openai' }} disabled={false} t={key => en[key]} onBusyChange={() => {}}
    operations={operations(discover)}
  />)
  await screen.findByText('Catalog unavailable')
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const image = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage })
  expect(image.checked).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  const picker = await screen.findByRole('dialog', { name: en.fetchTitle })
  fireEvent.click(within(picker).getByRole('button', { name: en.cancel }))
  expect(image.checked).toBe(true)
  expect(screen.queryByText('Catalog unavailable')).toBeNull()
  expect(discover).toHaveBeenCalledTimes(2)
  expect(onChange).not.toHaveBeenCalled()
})

it('declares per-model reasoning levels and drops them when cleared', () => {
  const onChange = vi.fn()
  const view = (
    models: { id: string; reasoningEfforts?: Record<string, string | null> }[],
  ) => (
    <ModelListEditor
      models={models} onChange={onChange}
      probe={{ settingsNs: 'llm-pi-ai', provider: 'acme' }} disabled={false}
      t={key => en[key]} onBusyChange={() => {}}
      operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
    />
  )
  const { rerender } = render(view([{ id: 'thinker' }]))
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  fireEvent.click(screen.getByRole('checkbox', { name: en.reasoningOff }))
  expect(onChange).toHaveBeenLastCalledWith([{ id: 'thinker', reasoningEfforts: { off: null } }])

  rerender(view([{ id: 'thinker', reasoningEfforts: { off: null } }]))
  fireEvent.click(screen.getByRole('checkbox', { name: en.reasoningHigh }))
  expect(onChange).toHaveBeenLastCalledWith([{ id: 'thinker', reasoningEfforts: { off: null, high: 'high' } }])

  rerender(view([{ id: 'thinker', reasoningEfforts: { off: null, high: 'high' } }]))
  fireEvent.click(screen.getByRole('checkbox', { name: en.reasoningOff }))
  expect(onChange).toHaveBeenLastCalledWith([{ id: 'thinker', reasoningEfforts: { high: 'high' } }])
})

it('refuses a reasoning declaration with only off before the write', () => {
  expect(validateDeepSeekModels([{ id: 'thinker', reasoningEfforts: { off: null } }]))
    .toEqual({ index: 0, key: 'modelReasoningInvalid' })
  expect(validateDeepSeekModels([{ id: 'thinker', reasoningEfforts: {} }]))
    .toEqual({ index: 0, key: 'modelReasoningInvalid' })
  expect(validateDeepSeekModels([{ id: 'thinker', reasoningEfforts: false }])).toBeUndefined()
  expect(validateDeepSeekModels([{ id: 'thinker', reasoningEfforts: { off: null, high: 'high' } }])).toBeUndefined()
})

it('edits base prices and a time band through the pi-ai row pricing controls', () => {
  type PricingModel = { id: string; headers?: Record<string, string>; pricing?: unknown }
  const onChange = vi.fn()
  const model: PricingModel = { id: 'm', headers: { 'X-Keep': 'yes' } }
  const view = (models: PricingModel[]) => (
    <ModelListEditor
      models={models}
      onChange={onChange}
      defaultInput={['text']}
      probe={{ settingsNs: 'llm-pi-ai', provider: 'acme' }}
      disabled={false}
      t={key => en[key]}
      onBusyChange={() => {}}
      operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
    />
  )
  const { rerender } = render(view([model]))
  const settle = (): void => { rerender(view(onChange.mock.calls.at(-1)?.[0] as PricingModel[])) }
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))

  fireEvent.change(screen.getByLabelText(`${en.modelPricingCacheHit} 1`), { target: { value: '0.5' } })
  expect(onChange).toHaveBeenLastCalledWith([{ ...model, pricing: { inputCacheHit: 0.5 } }])
  settle()
  fireEvent.change(screen.getByLabelText(`${en.modelPricingCacheMiss} 1`), { target: { value: '1' } })
  settle()
  fireEvent.change(screen.getByLabelText(`${en.modelPricingOutput} 1`), { target: { value: '2' } })
  settle()
  expect(onChange).toHaveBeenLastCalledWith([{
    ...model,
    pricing: { inputCacheHit: 0.5, inputCacheMiss: 1, output: 2 },
  }])

  fireEvent.click(screen.getByLabelText(`${en.modelPricingAddBand} 1`))
  expect(onChange).toHaveBeenLastCalledWith([{
    ...model,
    pricing: { inputCacheHit: 0.5, inputCacheMiss: 1, output: 2, timeBands: [{ start: '', end: '' }] },
  }])
  settle()
  fireEvent.change(screen.getByLabelText(`${en.modelPricingBandStart} 1-1`), { target: { value: '09:00' } })
  settle()
  fireEvent.change(screen.getByLabelText(`${en.modelPricingBandEnd} 1-1`), { target: { value: '18:00' } })
  settle()
  fireEvent.change(screen.getByLabelText(`${en.modelPricingCacheHit} 1-1`), { target: { value: '0.25' } })
  settle()
  fireEvent.change(screen.getByLabelText(`${en.modelPricingCacheMiss} 1-1`), { target: { value: '0.5' } })
  settle()
  fireEvent.change(screen.getByLabelText(`${en.modelPricingOutput} 1-1`), { target: { value: '1' } })
  settle()
  expect(onChange).toHaveBeenLastCalledWith([{
    ...model,
    pricing: {
      inputCacheHit: 0.5, inputCacheMiss: 1, output: 2,
      timeBands: [{ start: '09:00', end: '18:00', inputCacheHit: 0.25, inputCacheMiss: 0.5, output: 1 }],
    },
  }])

  fireEvent.click(screen.getByLabelText(`${en.modelPricingRemoveBand} 1-1`))
  expect(onChange).toHaveBeenLastCalledWith([{
    ...model,
    pricing: { inputCacheHit: 0.5, inputCacheMiss: 1, output: 2 },
  }])

  fireEvent.click(screen.getByLabelText(`${en.removeModel} 1`))
  expect(onChange).toHaveBeenLastCalledWith([])
})

it('keeps sibling pi-ai rows unchanged while editing reasoning', () => {
  const onChange = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'first' }, { id: 'second' }]}
    onChange={onChange}
    probe={{ settingsNs: 'llm-pi-ai', provider: 'acme' }}
    disabled={false}
    t={key => en[key]}
    onBusyChange={() => {}}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  fireEvent.click(screen.getByRole('checkbox', { name: en.reasoningOff }))
  expect(onChange).toHaveBeenLastCalledWith([
    { id: 'first', reasoningEfforts: { off: null } },
    { id: 'second' },
  ])
})

it('keeps sibling pi-ai rows unchanged while pricing one row', () => {
  const onChange = vi.fn()
  const models = [
    { id: 'first', pricing: { inputCacheHit: 1, inputCacheMiss: 2, output: 3 } },
    { id: 'second', pricing: { inputCacheHit: 4, inputCacheMiss: 5, output: 6 } },
  ]
  render(<ModelListEditor
    models={models}
    onChange={onChange}
    probe={{ settingsNs: 'llm-pi-ai', provider: 'acme' }}
    disabled={false}
    t={key => en[key]}
    onBusyChange={() => {}}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  fireEvent.change(screen.getByLabelText(`${en.modelPricingOutput} 1`), { target: { value: '7' } })
  expect(onChange).toHaveBeenLastCalledWith([
    { id: 'first', pricing: { inputCacheHit: 1, inputCacheMiss: 2, output: 7 } },
    { id: 'second', pricing: { inputCacheHit: 4, inputCacheMiss: 5, output: 6 } },
  ])
})

it('drops pricing text buffers when the reset action returns to inheritance', () => {
  const onChange = vi.fn()
  const onReset = vi.fn()
  render(<ModelListEditor
    models={[{ id: 'm', pricing: { inputCacheHit: 1, inputCacheMiss: 2, output: 3 } }]}
    overridden={true}
    onChange={onChange}
    onReset={onReset}
    probe={{ settingsNs: 'llm-pi-ai', provider: 'acme' }}
    disabled={false}
    t={key => en[key]}
    onBusyChange={() => {}}
    operations={operations(() => Promise.resolve({ kind: 'found', models: [] }))}
  />)
  fireEvent.click(screen.getByRole('button', { name: `${en.modelAdvanced} 1` }))
  const hit = screen.getByLabelText<HTMLInputElement>(`${en.modelPricingCacheHit} 1`)
  fireEvent.change(hit, { target: { value: '9' } })
  fireEvent.click(screen.getByText(en.resetModels))
  expect(onReset).toHaveBeenCalledTimes(1)
  // The remounted editor reads the stored draft, not the discarded buffer.
  expect(screen.getByLabelText<HTMLInputElement>(`${en.modelPricingCacheHit} 1`).value).toBe('1')
})

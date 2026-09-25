// @vitest-environment jsdom
/**
 * Remote hosts section presentation: the list states, the connection check,
 * and the two dialogs driven through their props and a real snapshot store.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteHostAddRequest } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteHostsSection } from '../src/client/RemoteHostsSection.tsx'
import type { RemoteHostsSectionProps } from '../src/client/RemoteHostsSection.tsx'
import type {
  RemoteHostActionOutcome, RemoteHostRow, RemoteHostTestOutcome, RemoteHostsListState,
} from '../src/client/hosts-source.ts'
import { en, type RemoteHostsLocaleKey } from '../src/client/locales.ts'
import type { RemoteHostSelectionState } from '../src/client/selection.ts'

afterEach(cleanup)

/** The English dictionary with `{name}` placeholders substituted. */
const t = ((key: RemoteHostsLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as RemoteHostsSectionProps['t']

/**
 * One host row.
 * @param id - registry identity.
 * @param overrides - fields this case changes.
 * @returns the row.
 */
function row(id: string, overrides: Partial<RemoteHostRow> = {}): RemoteHostRow {
  return {
    id,
    label: overrides.label ?? id,
    host: overrides.host ?? `${id}.example`,
    workspace: overrides.workspace ?? '/srv/work',
    open: overrides.open ?? false,
  }
}

/**
 * Build the props and the observable list source one case drives.
 * @param initial - the list state the section opens on.
 * @param selected - the workspace-creation host the section opens on.
 * @returns the sources, the injected callbacks, and the composed props.
 */
function bench(
  initial: RemoteHostsListState = { rows: [], ready: false },
  selected: RemoteHostSelectionState = {},
) {
  const store = createSnapshotStore<RemoteHostsListState>(initial)
  const selection = createSnapshotStore<RemoteHostSelectionState>(selected)
  const refresh = vi.fn()
  const sampleWorlds = vi.fn()
  const selectHost = vi.fn<(next: RemoteHostSelectionState) => void>()
  const addHost = vi.fn<(request: RemoteHostAddRequest) => Promise<RemoteHostActionOutcome>>(
    async () => ({ ok: true }),
  )
  const removeHost = vi.fn<(id: string) => Promise<RemoteHostActionOutcome>>(async () => ({ ok: true }))
  const testConnection = vi.fn<(id: string) => Promise<RemoteHostTestOutcome>>(
    async () => ({ ok: true, host: 'alpha.example', port: 22, hostKeys: [] }),
  )
  const props = {
    close: vi.fn(),
    t,
    useList: bindSnapshotSelector(store),
    useSelectedHost: bindSnapshotSelector(selection),
    refresh,
    sampleWorlds,
    selectHost,
    addHost,
    removeHost,
    testConnection,
  } as unknown as RemoteHostsSectionProps
  return {
    store, selection, refresh, sampleWorlds, selectHost, addHost, removeHost, testConnection, props,
  }
}

/** Fill every add-dialog field except the private key. */
function fillDraft(secret?: string): void {
  // The registry identity is derived from the name, so the name is entered
  // first and the three remote paths are opened through advanced options.
  fireEvent.change(screen.getByLabelText(en.fieldLabel), { target: { value: 'Alpha' } })
  fireEvent.change(screen.getByLabelText(en.fieldHost), { target: { value: 'alpha.example' } })
  fireEvent.change(screen.getByLabelText(en.fieldPort), { target: { value: '22' } })
  fireEvent.change(screen.getByLabelText(en.fieldUser), { target: { value: 'deploy' } })
  fireEvent.click(screen.getByRole('button', { name: en.showAdvanced }))
  fireEvent.change(screen.getByLabelText(en.fieldRoot), { target: { value: '/srv/dsh' } })
  fireEvent.change(screen.getByLabelText(en.fieldWorkspace), { target: { value: '/srv/work' } })
  fireEvent.change(screen.getByLabelText(en.fieldManifest), { target: { value: '/tmp/helper.json' } })
  if (secret !== undefined) {
    fireEvent.change(screen.getByLabelText(en.fieldPrivateKey), { target: { value: secret } })
  }
}

describe('RemoteHostsSection', () => {
  it('shows the loading line before the first baseline and the empty line after it', () => {
    const b = bench()
    render(<RemoteHostsSection {...b.props} />)
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.getByText(en.title)).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()

    act(() => { b.store.set({ rows: [], ready: true }) })
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByText(en.loading)).toBeNull()
  })

  it('lists every host with its endpoint facts and execution-world state', () => {
    const b = bench({ rows: [row('alpha', { label: 'Alpha', open: true }), row('bravo')], ready: true })
    render(<RemoteHostsSection {...b.props} />)

    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('alpha.example')).toBeTruthy()
    expect(screen.getByText('bravo.example')).toBeTruthy()
    expect(screen.getAllByText('/srv/work')).toHaveLength(2)
    expect(screen.getByText(en.worldOpen)).toBeTruthy()
    expect(screen.getByText(en.worldClosed)).toBeTruthy()
    // The closed world states what it costs instead of reading as "not opened
    // yet": only the row without a world carries it.
    expect(screen.getAllByText(en.worldClosedHint)).toHaveLength(1)
    expect(screen.getAllByText(en.hostField)).toHaveLength(2)
    expect(screen.getAllByText(en.workspaceField)).toHaveLength(2)
    expect(screen.getAllByText(en.worldField)).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: en.remove })).toHaveLength(2)
  })

  it('re-samples the live world state when the section opens', () => {
    const b = bench({ rows: [row('alpha', { open: true })], ready: true })
    render(<RemoteHostsSection {...b.props} />)
    // The followed stream announces record writes only, so the state it holds
    // for an already-open section is re-read when the section mounts.
    expect(b.sampleWorlds).toHaveBeenCalledTimes(1)
  })

  it('names the unrecoverable world of a selected host that is no longer open', () => {
    const b = bench(
      { rows: [row('alpha', { label: 'Alpha' })], ready: true },
      { hostId: 'alpha', hostLabel: 'Alpha' },
    )
    render(<RemoteHostsSection {...b.props} />)
    expect(screen.getByText(en.selectedWorldClosed)).toBeTruthy()
    // The selection itself stays: the record is still registered, and the
    // warning is what keeps the choice from reading as usable.
    expect(screen.getByRole('button', { name: en.useLocal })).toBeTruthy()
    expect(b.selectHost).not.toHaveBeenCalled()
  })

  it('leaves a selected host whose world is still open unlabelled', () => {
    const b = bench(
      { rows: [row('alpha', { label: 'Alpha', open: true })], ready: true },
      { hostId: 'alpha', hostLabel: 'Alpha' },
    )
    render(<RemoteHostsSection {...b.props} />)
    expect(screen.queryByText(en.selectedWorldClosed)).toBeNull()
  })

  it('selects a host row as the workspace-creation world and shows the selected state', () => {
    const b = bench({ rows: [row('alpha', { label: 'Alpha' }), row('bravo')], ready: true })
    render(<RemoteHostsSection {...b.props} />)
    // Nothing selected yet: the section starts on this machine.
    expect(screen.getByText(en.workspaceHost)).toBeTruthy()
    expect(screen.getByText(en.localLabel)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.useLocal })).toBeNull()

    const selectAlpha = screen.getByRole('button', { name: 'Use “Alpha” for new workspaces' })
    expect(selectAlpha.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(selectAlpha)
    expect(b.selectHost).toHaveBeenCalledWith({ hostId: 'alpha', hostLabel: 'Alpha' })

    act(() => { b.selection.set({ hostId: 'alpha', hostLabel: 'Alpha' }) })
    // Selected state: the pressed control, its badge, and the world named as
    // the creation target instead of the local line.
    expect(screen.getByRole('button', { name: 'Use “Alpha” for new workspaces' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText(en.selected)).toBeTruthy()
    expect(screen.queryByText(en.localLabel)).toBeNull()
    expect(screen.getAllByText('Alpha')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: en.useLocal }))
    expect(b.selectHost).toHaveBeenLastCalledWith({})
  })

  it('returns to this machine when the followed list drops the selected host', () => {
    const b = bench({ rows: [row('bravo')], ready: true }, { hostId: 'alpha', hostLabel: 'Alpha' })
    render(<RemoteHostsSection {...b.props} />)
    expect(b.selectHost).toHaveBeenCalledWith({})
  })

  it('keeps a selection whose host the arriving baseline has not listed yet', () => {
    const b = bench({ rows: [], ready: false }, { hostId: 'alpha', hostLabel: 'Alpha' })
    render(<RemoteHostsSection {...b.props} />)
    expect(b.selectHost).not.toHaveBeenCalled()
    expect(screen.queryByText(en.localLabel)).toBeNull()
  })

  it('reports the ended stream and re-reads the list on refresh', () => {
    const b = bench({ rows: [row('alpha')], ready: true, failure: 'remote host list ended' })
    render(<RemoteHostsSection {...b.props} />)

    expect(screen.getByText(en.listFailed)).toBeTruthy()
    expect(screen.getByText('remote host list ended')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(b.refresh).toHaveBeenCalledTimes(1)
  })

  it('runs one connection check at a time and shows the reached endpoint and its keys', async () => {
    const b = bench({ rows: [row('alpha'), row('bravo')], ready: true })
    const pending = Promise.withResolvers<RemoteHostTestOutcome>()
    b.testConnection.mockReturnValueOnce(pending.promise)
    render(<RemoteHostsSection {...b.props} />)

    fireEvent.click(screen.getAllByRole('button', { name: en.testConnection })[0]!)
    expect(await screen.findByText(en.testing)).toBeTruthy()
    // The other row's check joins nothing while one is in flight.
    fireEvent.click(screen.getByRole('button', { name: en.testConnection }))
    expect(b.testConnection).toHaveBeenCalledTimes(1)

    pending.resolve({ ok: true, host: 'alpha.example', port: 22, hostKeys: ['alpha.example ssh-ed25519 AAAA'] })
    expect(await screen.findByText('Connection succeeded: alpha.example:22')).toBeTruthy()
    expect(screen.getByText(en.fingerprints)).toBeTruthy()
    expect(screen.getByText('alpha.example ssh-ed25519 AAAA')).toBeTruthy()
    expect(b.testConnection).toHaveBeenNthCalledWith(1, 'alpha')
  })

  it('shows a check that recorded no host key and a refused check', async () => {
    const b = bench({ rows: [row('alpha'), row('bravo', { label: 'Bravo' })], ready: true })
    b.testConnection
      .mockResolvedValueOnce({ ok: true, host: 'alpha.example', port: 22, hostKeys: [] })
      .mockResolvedValueOnce({ ok: false, message: 'no stored login material' })
    render(<RemoteHostsSection {...b.props} />)

    fireEvent.click(screen.getAllByRole('button', { name: en.testConnection })[0]!)
    expect(await screen.findByText(en.fingerprintsEmpty)).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: en.testConnection })[1]!)
    expect(await screen.findByText(en.testFailed)).toBeTruthy()
    expect(screen.getByText('no stored login material')).toBeTruthy()
    expect(b.testConnection).toHaveBeenNthCalledWith(2, 'bravo')
  })

  it('refuses a port the wire cannot carry before calling the Host', async () => {
    const b = bench({ rows: [], ready: true })
    render(<RemoteHostsSection {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.addHost }))
    const dialog = screen.getByRole('dialog', { name: en.addTitle })
    const port = screen.getByLabelText(en.fieldPort)
    const confirm = within(dialog).getByRole('button', { name: en.submit })
    expect(port.getAttribute('aria-invalid')).toBeNull()

    for (const value of ['abc', '0', '70000']) {
      fireEvent.change(port, { target: { value } })
      fireEvent.click(confirm)
      expect(screen.getByText(en.portInvalid)).toBeTruthy()
      expect(port.getAttribute('aria-invalid')).toBe('true')
    }
    expect(b.addHost).not.toHaveBeenCalled()

    fireEvent.change(port, { target: { value: '22' } })
    fireEvent.click(confirm)
    await vi.waitFor(() => { expect(b.addHost).toHaveBeenCalledTimes(1) })
  })

  it('adds a host without a private key and closes the dialog on success', async () => {
    const b = bench({ rows: [], ready: true })
    render(<RemoteHostsSection {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.addHost }))
    fillDraft()

    const dialog = screen.getByRole('dialog', { name: en.addTitle })
    expect(screen.getByText(en.privateKeyHint)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en.submit }))

    await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(b.addHost).toHaveBeenCalledWith({
      id: 'alpha',
      label: 'Alpha',
      root: '/srv/dsh',
      workspace: '/srv/work',
      manifest: '/tmp/helper.json',
      login: { host: 'alpha.example', port: 22, user: 'deploy' },
    })
  })

  it('reveals the remote paths through advanced options, and hides them again', () => {
    const b = bench({ rows: [], ready: true })
    render(<RemoteHostsSection {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.addHost }))

    expect(screen.queryByLabelText(en.fieldRoot)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.showAdvanced }))
    expect(screen.getByLabelText(en.fieldRoot)).toBeTruthy()
    expect(screen.getByLabelText(en.fieldManifest)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.closeAdvanced }))
    expect(screen.queryByLabelText(en.fieldRoot)).toBeNull()
    expect(screen.queryByLabelText(en.fieldManifest)).toBeNull()
  })

  it('expands a pasted ssh url into the host, port, and user fields', () => {
    const b = bench({ rows: [], ready: true })
    render(<RemoteHostsSection {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.addHost }))
    fireEvent.change(screen.getByLabelText(en.fieldHost), {
      target: { value: 'ssh://deploy@alpha.example:2222' },
    })
    expect(screen.getByLabelText(en.fieldHost)).toHaveProperty('value', 'alpha.example')
    expect(screen.getByLabelText(en.fieldPort)).toHaveProperty('value', '2222')
    expect(screen.getByLabelText(en.fieldUser)).toHaveProperty('value', 'deploy')

    // A url without a user or a port stays in the field for the human to finish.
    fireEvent.change(screen.getByLabelText(en.fieldHost), { target: { value: 'ssh://alpha.example' } })
    expect(screen.getByLabelText(en.fieldHost)).toHaveProperty('value', 'ssh://alpha.example')
  })

  it('sends the entered password instead of a private key when password login is chosen', async () => {
    const b = bench({ rows: [], ready: true })
    render(<RemoteHostsSection {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.addHost }))
    fireEvent.change(screen.getByLabelText(en.fieldLabel), { target: { value: 'Alpha' } })
    fireEvent.change(screen.getByLabelText(en.fieldHost), { target: { value: 'alpha.example' } })
    fireEvent.change(screen.getByLabelText(en.fieldPort), { target: { value: '22' } })
    fireEvent.change(screen.getByLabelText(en.fieldUser), { target: { value: 'deploy' } })

    expect(screen.getByLabelText(en.fieldPrivateKey)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.authPassword }))
    expect(screen.queryByLabelText(en.fieldPrivateKey)).toBeNull()
    fireEvent.change(screen.getByLabelText(en.fieldPassword), { target: { value: 's3cret' } })
    fireEvent.click(screen.getByRole('button', { name: en.submit }))

    await vi.waitFor(() => { expect(b.addHost).toHaveBeenCalledTimes(1) })
    expect(b.addHost).toHaveBeenCalledWith(expect.objectContaining({
      id: 'alpha',
      root: '~/work',
      workspace: '~/work',
      manifest: '~/dist/ssh-helper/manifest.json',
      login: { host: 'alpha.example', port: 22, user: 'deploy', privateKey: 's3cret' },
    }))
  })

  it('keeps the entered draft on a refusal and never renders the private key', async () => {
    const b = bench({ rows: [], ready: true })
    const secret = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----'
    b.addHost.mockResolvedValueOnce({ ok: false, message: "remote host 'alpha' is already registered" })
    render(<RemoteHostsSection {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.addHost }))
    fillDraft(secret)

    const dialog = screen.getByRole('dialog', { name: en.addTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: en.submit }))

    expect(await screen.findByText("remote host 'alpha' is already registered")).toBeTruthy()
    expect(screen.getByRole('dialog', { name: en.addTitle })).toBeTruthy()
    expect(screen.getByLabelText(en.fieldPrivateKey)).toHaveProperty('value', secret)
    expect(screen.queryByText(secret)).toBeNull()
    expect(b.addHost).toHaveBeenCalledWith(expect.objectContaining({
      login: { host: 'alpha.example', port: 22, user: 'deploy', privateKey: secret },
    }))

    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.addHost).toHaveBeenCalledTimes(1)
  })

  it('removes a host only after the confirmation, and reports a refusal', async () => {
    const b = bench({ rows: [row('alpha', { label: 'Alpha' })], ready: true })
    const pending = Promise.withResolvers<RemoteHostActionOutcome>()
    b.removeHost.mockReturnValueOnce(pending.promise)
    render(<RemoteHostsSection {...b.props} />)

    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    const dialog = screen.getByRole('dialog', { name: 'Remove Alpha?' })
    expect(within(dialog).getByText(en.removeDescription)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.removeHost).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    const pendingDialog = screen.getByRole('dialog', { name: 'Remove Alpha?' })
    fireEvent.click(within(pendingDialog).getByRole('button', { name: en.remove }))
    expect(await within(pendingDialog).findByText(en.removing)).toBeTruthy()
    expect(within(pendingDialog).getByRole('button', { name: en.cancel })).toHaveProperty('disabled', true)

    pending.resolve({ ok: false, message: 'remote host alpha is unknown' })
    expect(await within(pendingDialog).findByText('remote host alpha is unknown')).toBeTruthy()
    const retry = within(pendingDialog).getByRole('button', { name: en.remove })
    expect(retry).toHaveProperty('disabled', false)
    expect(b.removeHost).toHaveBeenCalledWith('alpha')

    b.removeHost.mockResolvedValueOnce({ ok: true })
    fireEvent.click(retry)
    await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })
})

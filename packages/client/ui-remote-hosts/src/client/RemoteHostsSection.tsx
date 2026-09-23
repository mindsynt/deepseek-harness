/** Remote hosts settings section: the host list, its actions, the two dialogs, and the workspace-creation host choice. */

import { useEffect, useState } from 'react'
import type { RemoteHostAddRequest } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import { AddHostDialog } from './AddHostDialog.tsx'
import { HostRow } from './HostRow.tsx'
import type {
  RemoteHostActionOutcome, RemoteHostRow, RemoteHostTestOutcome, RemoteHostsListState,
} from './hosts-source.ts'
import { RemoveHostDialog } from './RemoveHostDialog.tsx'
import type { RemoteHostSelectionState } from './selection.ts'
import css from './RemoteHostsSection.module.css'

/** Registration-side business face of the section. */
export interface RemoteHostsSectionInjected {
  hooks: {
    /** The followed host list of the current generation. */
    list: HostObservable<RemoteHostsListState>
    /** The host currently selected as the workspace-creation world. */
    selectedHost: HostObservable<RemoteHostSelectionState>
  }
  /** Reopen the follow stream and re-read its baseline. */
  refresh: () => void
  /** Re-read every host's live execution-world state into the rendered list. */
  sampleWorlds: () => void
  /** Select the workspace-creation world; an empty state selects the Harness host. */
  selectHost: (selection: RemoteHostSelectionState) => void
  /** Add one host from the dialog's entered request. */
  addHost: (request: RemoteHostAddRequest) => Promise<RemoteHostActionOutcome>
  /** Remove one host. */
  removeHost: (id: string) => Promise<RemoteHostActionOutcome>
  /** Check one host's stored login. */
  testConnection: (id: string) => Promise<RemoteHostTestOutcome>
}

/** Props the renderer binds for the section. */
export type RemoteHostsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.remoteHosts'>
  & InjectFace<RemoteHostsSectionInjected>

/**
 * Render the host list with add, remove, connection-check, and refresh actions,
 * plus the choice of which host new workspaces address.
 * @param props - composed slot props: copy, the list source, the selection, and the host operations.
 * @returns the section element tree.
 */
export function RemoteHostsSection({
  t, useList, useSelectedHost, refresh, sampleWorlds, selectHost, addHost, removeHost, testConnection,
}: RemoteHostsSectionProps) {
  const list = useList(value => value)
  const selected = useSelectedHost(value => value)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<RemoteHostRow>()
  const [testingId, setTestingId] = useState<string>()
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, RemoteHostTestOutcome>>>({})

  // The followed stream announces durable record writes only, so a world that
  // stopped after its last baseline would still read as open here; the section
  // re-samples the list it renders as soon as it opens.
  useEffect(() => { sampleWorlds() }, [sampleWorlds])

  // A selection whose host left the registry (removed here, or by another
  // client) would send every later create at a world that no longer exists;
  // the baseline that dropped it is what retires the selection.
  const selectedHostMissing = selected.hostId !== undefined && list.ready
    && !list.rows.some(row => row.id === selected.hostId)
  useEffect(() => {
    if (selectedHostMissing) selectHost({})
  }, [selectedHostMissing, selectHost])

  // A host can stay registered while the world this process held for it is
  // gone, and a world never reconnects: the selection keeps a name it can no
  // longer run anything against, so the section says so beside it.
  const selectedWorldClosed = selected.hostId !== undefined
    && list.rows.some(row => row.id === selected.hostId && !row.open)

  // One check at a time: the section has one result slot per row, and a second
  // concurrent check would let an older answer overwrite a newer one.
  const runTest = async (id: string): Promise<void> => {
    if (testingId !== undefined) return
    setTestingId(id)
    const outcome = await testConnection(id)
    setOutcomes(previous => ({ ...previous, [id]: outcome }))
    setTestingId(undefined)
  }

  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <div className={css.toolbar}>
        <Button size="sm" onClick={refresh}>{t('refresh')}</Button>
        <Button size="sm" variant="primary" onClick={() => { setAdding(true) }}>{t('addHost')}</Button>
      </div>
      <p className={css.selection} role="status">
        <span className={css.selectionLabel}>{t('workspaceHost')}</span>
        <span className={css.selectionValue}>{selected.hostLabel ?? t('localLabel')}</span>
        {selected.hostId === undefined
          ? null
          : <Button size="sm" variant="outline" onClick={() => { selectHost({}) }}>{t('useLocal')}</Button>}
      </p>
      {selectedWorldClosed
        ? <p className={css.alarm} role="status">{t('selectedWorldClosed')}</p>
        : null}
      {list.failure === undefined ? null : (
        <p className={css.error} role="status">
          {t('listFailed')} <span className={css.detail}>{list.failure}</span>
        </p>
      )}
      {!list.ready
        ? <p className={css.empty}>{t('loading')}</p>
        : list.rows.length === 0
          ? <p className={css.empty}>{t('empty')}</p>
          : (
            <ul className={css.list}>
              {list.rows.map(row => (
                <HostRow
                  key={row.id}
                  row={row}
                  t={t}
                  selected={row.id === selected.hostId}
                  testing={testingId === row.id}
                  outcome={outcomes[row.id]}
                  onSelect={() => { selectHost({ hostId: row.id, hostLabel: row.label }) }}
                  onTest={() => { void runTest(row.id) }}
                  onRemove={() => { setRemoving(row) }}
                />
              ))}
            </ul>
          )}
      {adding
        ? <AddHostDialog t={t} onClose={() => { setAdding(false) }} onSubmit={addHost} />
        : null}
      {removing === undefined
        ? null
        : (
          <RemoveHostDialog
            t={t}
            row={removing}
            onClose={() => { setRemoving(undefined) }}
            onSubmit={removeHost}
          />
        )}
    </div>
  )
}

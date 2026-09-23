/** One registered remote host: identity, endpoint facts, actions, and the last check. */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostRow, RemoteHostTestOutcome } from './hosts-source.ts'
import css from './HostRow.module.css'

/** Props of one host row. */
export interface HostRowProps {
  /** The host this row presents. */
  row: RemoteHostRow
  /** Section copy. */
  t: TranslateNS<'settings.remoteHosts'>
  /** Whether this host is the selected workspace-creation world. */
  selected: boolean
  /** Whether this row's connection check is running. */
  testing: boolean
  /** The last connection-check outcome of this row; absent before one ran. */
  outcome?: RemoteHostTestOutcome | undefined
  /** Select this host as the workspace-creation world. */
  onSelect: () => void
  /** Run a connection check for this row. */
  onTest: () => void
  /** Ask to remove this row's host. */
  onRemove: () => void
}

/**
 * Render one host row with its endpoint facts and the last connection result.
 * @param props - row data, copy, selection, per-row check state, and the three actions.
 * @returns the row element tree.
 */
export function HostRow({ row, t, selected, testing, outcome, onSelect, onTest, onRemove }: HostRowProps) {
  return (
    <li className={css.row} data-selected={selected ? 'true' : undefined}>
      <div className={css.head}>
        <span className={css.label}>{row.label}</span>
        <code className={css.id}>{row.id}</code>
      </div>
      <dl className={css.facts}>
        <dt className={css.term}>{t('hostField')}</dt>
        <dd className={css.value}>{row.host}</dd>
        <dt className={css.term}>{t('workspaceField')}</dt>
        <dd className={css.value}>{row.workspace}</dd>
        <dt className={css.term}>{t('worldField')}</dt>
        <dd className={css.value} data-open={row.open ? 'true' : undefined}>
          {row.open ? t('worldOpen') : t('worldClosed')}
        </dd>
      </dl>
      {row.open
        ? null
        : <p className={css.worldClosed} role="status">{t('worldClosedHint')}</p>}
      <div className={css.actions}>
        <Button
          size="sm"
          variant={selected ? 'primary' : 'outline'}
          aria-pressed={selected}
          aria-label={t('selectAria', { name: row.label })}
          onClick={onSelect}
        >
          {selected ? t('selected') : t('select')}
        </Button>
        <Button size="sm" disabled={testing} onClick={onTest}>
          {testing ? t('testing') : t('testConnection')}
        </Button>
        <Button size="sm" variant="outline" onClick={onRemove}>{t('remove')}</Button>
      </div>
      {outcome === undefined ? null : (
        <div className={css.outcome} data-ok={outcome.ok ? 'true' : 'false'} role="status">
          {outcome.ok
            ? <p className={css.ok}>{t('testSucceeded', { endpoint: `${outcome.host}:${outcome.port}` })}</p>
            : <p className={css.error}>{t('testFailed')} <span className={css.detail}>{outcome.message}</span></p>}
          {outcome.ok ? (
            <div className={css.keys}>
              <span className={css.keysLabel}>{t('fingerprints')}</span>
              {outcome.hostKeys.length === 0
                ? <p className={css.detail}>{t('fingerprintsEmpty')}</p>
                : (
                  <ul className={css.keyList}>
                    {outcome.hostKeys.map(line => <li key={line}><code>{line}</code></li>)}
                  </ul>
                )}
            </div>
          ) : null}
        </div>
      )}
    </li>
  )
}

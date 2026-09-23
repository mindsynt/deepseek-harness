/** Remove-host dialog: one confirmation before the Host closes the world and drops the record. */

import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostActionOutcome, RemoteHostRow } from './hosts-source.ts'
import css from './RemoveHostDialog.module.css'

/** Props of the removal confirmation. */
export interface RemoveHostDialogProps {
  /** The host this confirmation addresses. */
  row: RemoteHostRow
  /** Section copy. */
  t: TranslateNS<'settings.remoteHosts'>
  /** Close the dialog without removing. */
  onClose: () => void
  /** Remove the host; a refusal keeps the dialog open with its diagnostic. */
  onSubmit: (id: string) => Promise<RemoteHostActionOutcome>
}

/**
 * Render the removal confirmation. It is mounted only while a row is selected,
 * so every confirmation starts settled.
 * @param props - the addressed row, copy, and the close and submit callbacks.
 * @returns the dialog element tree.
 */
export function RemoveHostDialog({ row, t, onClose, onSubmit }: RemoveHostDialogProps) {
  const [removing, setRemoving] = useState(false)
  const [failure, setFailure] = useState<string>()

  const submit = async (): Promise<void> => {
    setRemoving(true)
    const outcome = await onSubmit(row.id)
    setRemoving(false)
    if (outcome.ok) onClose()
    else setFailure(outcome.message)
  }

  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t('removeTitle', { label: row.label })}
      description={t('removeDescription')}
      footer={(
        <div className={css.footer}>
          <Button variant="outline" disabled={removing} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={removing} onClick={() => { void submit() }}>
            {removing ? t('removing') : t('remove')}
          </Button>
        </div>
      )}
    >
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}</p>}
    </Modal>
  )
}

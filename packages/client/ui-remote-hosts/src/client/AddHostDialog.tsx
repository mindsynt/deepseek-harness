/** Add-host dialog: entered login material, remote paths, and the local artifact manifest. */

import { useId, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { RemoteHostAddRequest } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostActionOutcome } from './hosts-source.ts'
import css from './AddHostDialog.module.css'

/** The unfiled form draft one add dialog holds. */
interface HostDraft {
  id: string
  label: string
  host: string
  port: string
  user: string
  privateKey: string
  root: string
  workspace: string
  manifest: string
}

/** A draft with every field empty. */
const EMPTY_DRAFT: HostDraft = {
  id: '',
  label: '',
  host: '',
  port: '',
  user: '',
  privateKey: '',
  root: '',
  workspace: '',
  manifest: '',
}

/** Props of the add dialog. */
export interface AddHostDialogProps {
  /** Section copy. */
  t: TranslateNS<'settings.remoteHosts'>
  /** Close the dialog without adding. */
  onClose: () => void
  /** Submit the entered host; a refusal keeps the dialog open with its diagnostic. */
  onSubmit: (request: RemoteHostAddRequest) => Promise<RemoteHostActionOutcome>
}

/**
 * Render the add-host dialog. It is mounted only while open, so every open
 * starts from an empty draft.
 * @param props - copy, close, and submit callbacks.
 * @returns the dialog element tree.
 */
export function AddHostDialog({ t, onClose, onSubmit }: AddHostDialogProps) {
  const [draft, setDraft] = useState<HostDraft>(EMPTY_DRAFT)
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [portInvalid, setPortInvalid] = useState(false)
  const idPrefix = useId()

  const change = (field: keyof HostDraft) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      const { value } = event.currentTarget
      setDraft(previous => ({ ...previous, [field]: value }))
    }

  // The entered port travels on the wire as a number, so the form refuses a
  // value the wire cannot carry before the Host would have to.
  const submit = async (): Promise<void> => {
    const port = Number(draft.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortInvalid(true)
      return
    }
    setPortInvalid(false)
    setSubmitting(true)
    const outcome = await onSubmit({
      id: draft.id,
      label: draft.label,
      root: draft.root,
      workspace: draft.workspace,
      manifest: draft.manifest,
      login: {
        host: draft.host,
        port,
        user: draft.user,
        ...(draft.privateKey === '' ? {} : { privateKey: draft.privateKey }),
      },
    })
    setSubmitting(false)
    if (outcome.ok) onClose()
    else setFailure(outcome.message)
  }

  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t('addTitle')}
      description={t('addDescription')}
      footer={(
        <div className={css.footer}>
          <Button variant="outline" disabled={submitting} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={submitting} onClick={() => { void submit() }}>
            {submitting ? t('submitting') : t('submit')}
          </Button>
        </div>
      )}
    >
      <form className={css.form}>
        <label className={css.field} htmlFor={`${idPrefix}-id`}>
          <span className={css.label}>{t('fieldId')}</span>
          <Input id={`${idPrefix}-id`} value={draft.id} onChange={change('id')} />
        </label>
        <label className={css.field} htmlFor={`${idPrefix}-label`}>
          <span className={css.label}>{t('fieldLabel')}</span>
          <Input id={`${idPrefix}-label`} value={draft.label} onChange={change('label')} />
        </label>
        <label className={css.field} htmlFor={`${idPrefix}-host`}>
          <span className={css.label}>{t('fieldHost')}</span>
          <Input id={`${idPrefix}-host`} value={draft.host} onChange={change('host')} />
        </label>
        <label className={css.field} htmlFor={`${idPrefix}-port`}>
          <span className={css.label}>{t('fieldPort')}</span>
          <Input
            id={`${idPrefix}-port`}
            inputMode="numeric"
            aria-invalid={portInvalid ? 'true' : undefined}
            value={draft.port}
            onChange={change('port')}
          />
        </label>
        <label className={css.field} htmlFor={`${idPrefix}-user`}>
          <span className={css.label}>{t('fieldUser')}</span>
          <Input id={`${idPrefix}-user`} value={draft.user} onChange={change('user')} />
        </label>
        <div className={css.field}>
          {/* The hint sits outside the label so it never joins the field's accessible name. */}
          <label className={css.label} htmlFor={`${idPrefix}-key`}>{t('fieldPrivateKey')}</label>
          <textarea
            id={`${idPrefix}-key`}
            className={css.textarea}
            spellCheck={false}
            value={draft.privateKey}
            onChange={change('privateKey')}
          />
          <span className={css.hint}>{t('privateKeyHint')}</span>
        </div>
        <label className={css.field} htmlFor={`${idPrefix}-root`}>
          <span className={css.label}>{t('fieldRoot')}</span>
          <Input id={`${idPrefix}-root`} value={draft.root} onChange={change('root')} />
        </label>
        <label className={css.field} htmlFor={`${idPrefix}-workspace`}>
          <span className={css.label}>{t('fieldWorkspace')}</span>
          <Input id={`${idPrefix}-workspace`} value={draft.workspace} onChange={change('workspace')} />
        </label>
        <label className={css.field} htmlFor={`${idPrefix}-manifest`}>
          <span className={css.label}>{t('fieldManifest')}</span>
          <Input id={`${idPrefix}-manifest`} value={draft.manifest} onChange={change('manifest')} />
        </label>
      </form>
      {portInvalid ? <p className={css.invalid} role="alert">{t('portInvalid')}</p> : null}
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}</p>}
    </Modal>
  )
}

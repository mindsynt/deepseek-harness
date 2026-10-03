/** Add-host dialog: the entered SSH login material. */
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
}

/** A draft with every field empty. */
const EMPTY_DRAFT: HostDraft = {
  id: '',
  label: '',
  host: '',
  port: '',
  user: '',
  privateKey: '',
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
  const [requiredMissing, setRequiredMissing] = useState(false)
  const [portInvalid, setPortInvalid] = useState(false)
  const idPrefix = useId()

  const change = (field: keyof HostDraft) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      const { value } = event.currentTarget
      setDraft((previous) => {
        // A pasted ssh://user@host:port fills the fields it names. Parsed here
        // so the fields update as the user types, not only at submit time.
        if (field === 'host' && value.startsWith('ssh://')) {
          const parsed = parseSshUrl(value)
          if (parsed) {
            const next = { ...previous, host: parsed.host, port: parsed.port, user: parsed.user }
            if (!next.id) next.id = slug(parsed.host)
            return next
          }
        }
        const next = { ...previous, [field]: value }
        if (!previous.id) next.id = slug(next.label) || slug(next.host)
        return next
      })
    }

  const submit = async (): Promise<void> => {
    // A missing field and a port the wire cannot carry are separate failures:
    // an empty port is a field not entered, a bad port is one that was.
    const requiredMissing = [draft.label, draft.host, draft.port, draft.user]
      .some(value => value.trim().length === 0)
    const port = Number(draft.port)
    const portInvalid = draft.port.trim().length > 0 && (!Number.isInteger(port) || port < 1 || port > 65535)
    setRequiredMissing(requiredMissing)
    setPortInvalid(portInvalid)
    if (requiredMissing || portInvalid) return

    setSubmitting(true)
    const outcome = await onSubmit({
      id: draft.id,
      label: draft.label.trim(),
      login: {
        host: draft.host.trim(),
        port,
        user: draft.user.trim(),
        ...(draft.privateKey.trim().length > 0 ? { privateKey: draft.privateKey.trim() } : {}),
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
        <label className={css.field} htmlFor={`${idPrefix}-label`}>
          <span className={css.label}>{t('fieldLabel')}</span>
          <Input
            id={`${idPrefix}-label`}
            aria-invalid={requiredMissing ? 'true' : undefined}
            value={draft.label}
            onChange={change('label')}
          />
        </label>

        <label className={css.field} htmlFor={`${idPrefix}-host`}>
          <span className={css.label}>{t('fieldHost')}</span>
          <Input
            id={`${idPrefix}-host`}
            aria-invalid={requiredMissing ? 'true' : undefined}
            value={draft.host}
            onChange={change('host')}
          />
        </label>

        <label className={css.field} htmlFor={`${idPrefix}-port`}>
          <span className={css.label}>{t('fieldPort')}</span>
          <Input
            id={`${idPrefix}-port`}
            inputMode="numeric"
            aria-invalid={requiredMissing || portInvalid ? 'true' : undefined}
            value={draft.port}
            onChange={change('port')}
          />
        </label>

        <label className={css.field} htmlFor={`${idPrefix}-user`}>
          <span className={css.label}>{t('fieldUser')}</span>
          <Input
            id={`${idPrefix}-user`}
            aria-invalid={requiredMissing ? 'true' : undefined}
            value={draft.user}
            onChange={change('user')}
          />
        </label>

        <div className={css.field}>
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
      </form>
      {requiredMissing ? <p className={css.invalid} role="alert">{t('requiredMissing')}</p> : null}
      {portInvalid ? <p className={css.invalid} role="alert">{t('portInvalid')}</p> : null}
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}</p>}
    </Modal>
  )
}

/** Parse ssh://user@host:port into its components. */
function parseSshUrl(url: string): { user: string; host: string; port: string } | null {
  const [, user, host, port] = url.match(/^ssh:\/\/([^:@/]+)@([^:]+):(\d+)$/) ?? []
  if (user === undefined || host === undefined || port === undefined) return null
  return { user, host, port }
}

/**
 * The host token the Workspace domain reserves for the Harness's own execution
 * world, so a remote host claiming it would read as this machine in every
 * host-token lookup. Mirrored here, client-only: the suggestion must never
 * hand the user the reserved token.
 * @see packages/workspace/workspace/src/paths.ts
 */
const RESERVED_LOCAL_HOST_ID = 'local'

/** Registry identity from free text: ASCII letters, digits, dots, and dashes. */
function slug(text: string): string {
  const token = text.replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40)
  return token === RESERVED_LOCAL_HOST_ID ? `${token}-remote` : token
}

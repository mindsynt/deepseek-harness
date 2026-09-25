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
  password: string
  authMode: 'key' | 'password'
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
  password: '',
  authMode: 'key' as const,
  root: '~/work',
  workspace: '~/work',
  manifest: '~/dist/ssh-helper/manifest.json',
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
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
        ...(draft.authMode === 'password' && draft.password ? { privateKey: draft.password } : {}),
        ...(draft.authMode === 'key' && draft.privateKey ? { privateKey: draft.privateKey } : {}),
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

        <div className={css.field} style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            variant={draft.authMode === 'key' ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setDraft(p => ({ ...p, authMode: 'key' }))}
          >{t('authKey')}</Button>
          <Button
            variant={draft.authMode === 'password' ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setDraft(p => ({ ...p, authMode: 'password', privateKey: '' }))}
          >{t('authPassword')}</Button>
        </div>

        {draft.authMode === 'key' ? (
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
        ) : (
          <label className={css.field} htmlFor={`${idPrefix}-password`}>
            <span className={css.label}>{t('fieldPassword')}</span>
            <Input id={`${idPrefix}-password`} type="password" value={draft.password} onChange={change('password')} />
          </label>
        )}

        <div className={css.field}>
          <Button variant="outline" size="sm" onClick={() => setAdvancedOpen(!advancedOpen)}>
            {advancedOpen ? t('closeAdvanced') : t('showAdvanced')}
          </Button>
        </div>

        {advancedOpen ? (
          <div className={css.advanced}>
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
          </div>
        ) : null}
      </form>
      {portInvalid ? <p className={css.invalid} role="alert">{t('portInvalid')}</p> : null}
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}</p>}
    </Modal>
  )
}

/** Parse ssh://user@host:port into its components. */
function parseSshUrl(url: string): { host: string; port: string; user: string } | null {
  const [, user, host, port] = url.match(/^ssh:\/\/([^:@/]+)@([^:]+):(\d+)$/) ?? []
  if (user === undefined || host === undefined || port === undefined) return null
  return { user, host, port }
}

/** Registry identity from free text: ASCII letters, digits, dots, and dashes. */
function slug(text: string): string {
  return text.replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40)
}

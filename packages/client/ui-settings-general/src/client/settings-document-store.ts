/** State owner for the optional local settings-document action. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Browser state of the Host-owned settings document. */
export interface SettingsDocumentState {
  /** Metadata-loading phase; unavailable means the document is absent, the Host cannot open it natively, or the read failed. */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** Whether one native-open request is in flight. */
  opening: boolean
  /** Last metadata/native-open diagnostic; UI exposes only localized copy. */
  error: string | null
}

/** Derives document availability from the shared mirror and the Host opener probe, then invokes the pathless open operation. */
export class SettingsDocumentStore {
  /** uSES-safe state source shared by the registered header action. */
  readonly store: SnapshotStore<SettingsDocumentState> = createSnapshotStore({
    status: 'idle', opening: false, error: null,
  })

  private following: (() => void) | undefined
  /** Host answer to the opener probe; undefined until the first load settles. */
  private canOpenDocument: boolean | undefined

  /**
   * @param ctx - the plugin's context, whose `remote.settings` namespace opens
   * the provider document.
   * @param describeFace - the shared mirror's describe face (`hasDocument` source).
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * Begin following the mirror (idempotent), probe the native opener, and
   * reflect whether the current provider's document can be offered.
   * @returns settlement once the snapshot reflects both facts.
   */
  async load(): Promise<void> {
    this.following ??= this.describeFace.subscribe(() => { this.derive() })
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    // The opener capability is a Host fact beside the document metadata; a
    // refused probe removes only this action, exactly like an absent document.
    const capability = Promise.resolve()
      .then(() => this.ctx.remote.settings.canOpenSettingsDocument())
      .then(result => result.ok ? result.value : false)
      .catch(() => false)
    const [canOpen] = await Promise.all([capability, this.describeFace.ensure()])
    this.canOpenDocument = canOpen
    this.derive()
  }

  /**
   * Open the loaded document once; concurrent gestures collapse behind the in-flight action.
   * @returns after the native-open request settles, or immediately when unavailable/already opening.
   */
  async open(): Promise<void> {
    const current = this.store.getSnapshot()
    if (current.status !== 'ready' || current.opening) return
    this.store.update((state) => {
      state.opening = true
      state.error = null
    })
    try {
      const result = await this.ctx.remote.settings.openSettingsDocument()
      if (!result.ok) {
        const { message } = result.error
        this.store.update((state) => { state.error = message })
      }
    } finally {
      this.store.update((state) => { state.opening = false })
    }
  }

  /** Stop following the mirror. */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    // The mirror may publish before the opener probe settles; hold the action
    // out of both ready and unavailable until both facts are known.
    if (this.canOpenDocument === undefined) return
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.view === undefined) {
      // A held failure with no answer means the document cannot be located;
      // without one the read is still in flight and loading stands.
      if (mirrored.error !== null) {
        this.store.update((state) => {
          state.status = 'unavailable'
          state.error = mirrored.error
        })
      }
      return
    }
    const { hasDocument } = mirrored.view
    this.store.update((state) => {
      state.status = hasDocument && this.canOpenDocument === true ? 'ready' : 'unavailable'
      state.error = null
    })
  }
}

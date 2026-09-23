/**
 * The workspace-creation host selection: which execution world a newly
 * created Workspace addresses.
 *
 * The fact crosses packages — this package's settings section writes it and
 * ui-workspace reads it when it lists a directory and creates a Workspace —
 * so it is owned on the object layer as a Client service instead of living in
 * one registration's declared store, whose instance is private to that
 * registration. The value is published as a bare snapshot source, so each
 * consuming registration binds it in its reserved `hooks` compartment and a
 * component reads it through a framework hook.
 *
 * @module @deepseek-ai/dsh-client-ui-remote-hosts/selection
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** The selected workspace-creation world. */
export interface RemoteHostSelectionState {
  /** Registry identity of the selected remote host; absent selects the Harness host. */
  readonly hostId?: string
  /** Display label of that host, carried so a browsing surface can name the world it lists. */
  readonly hostLabel?: string
}

/** The workspace-creation host selection every consuming surface reads. */
export interface RemoteHostSelection {
  /** Bare snapshot source of the current selection; the same reference until the selection moves. */
  readonly source: ObservableSnapshot<RemoteHostSelectionState>
  /**
   * Replace the selection.
   * @param selection - the selected host, or an empty state for the Harness host.
   */
  select(selection: RemoteHostSelectionState): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote host selected as the workspace-creation world, owned by ui-remote-hosts. */
    remoteHostSelection: RemoteHostSelection
  }
}

/** Owns the single workspace-creation host selection. */
export class RemoteHostSelectionService extends Service implements RemoteHostSelection {
  /** @see {@link RemoteHostSelection.source} */
  readonly source: ObservableSnapshot<RemoteHostSelectionState>
  private readonly state = createSnapshotStore<RemoteHostSelectionState>({})

  /** @param ctx - client root Context the service registers under. */
  constructor(ctx: Context) {
    super(ctx, 'remoteHostSelection')
    this.source = this.state
  }

  /** @see {@link RemoteHostSelection.select} */
  select(selection: RemoteHostSelectionState): void {
    this.state.set({ ...selection })
  }
}

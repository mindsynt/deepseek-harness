/**
 * Optional read of the workspace-creation host selection.
 *
 * ui-remote-hosts owns `ctx.remoteHostSelection`. A composition that drops
 * that row must keep browsing and creating Workspaces on the Harness host
 * instead of suspending on a service no fiber provides, so this read resolves
 * the service through `ctx.get` at every read and re-binds whenever its
 * registration changes: a provider activated late, or removed under HMR,
 * takes effect for the next directory listing and the next creation.
 *
 * @module @deepseek-ai/dsh-client-ui-workspace/host-selection
 */

import type { Context } from '@deepseek-ai/cordis'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostSelectionState } from '@deepseek-ai/dsh-client-ui-remote-hosts/client'

/** The optional workspace-creation host selection as one apply reads it. */
export interface WorkspaceHostSelectionRead {
  /**
   * Source for a registration's reserved `hooks` compartment: the provider's
   * own snapshot source while it is registered, otherwise one stable empty
   * state.
   */
  readonly source: HostObservable<RemoteHostSelectionState>
  /**
   * The host of the workspace-creation world.
   * @returns the selected remote host id, or undefined while no remote host is
   *   selected or ui-remote-hosts is not registered.
   */
  hostId(): string | undefined
}

/**
 * Create the optional host-selection read for one apply.
 * @param ctx - client root context whose service registrations the read follows.
 * @returns the read used by directory browsing, Workspace creation, and the labels the surfaces render.
 */
export function createWorkspaceHostSelection(ctx: Context): WorkspaceHostSelectionRead {
  const listeners = new Set<() => void>()
  // One stable reference while no provider is registered, so a hook bound
  // before the provider loads keeps seeing the same empty snapshot.
  const absent: RemoteHostSelectionState = {}
  let stopProvider: (() => void) | undefined

  const notify = (): void => {
    notifySubscribers(listeners, '[ui-workspace] remote host selection')
  }
  const provider = (): HostObservable<RemoteHostSelectionState> | undefined =>
    ctx.get('remoteHostSelection')?.source

  const rebind = (): void => {
    stopProvider?.()
    stopProvider = provider()?.subscribe(() => { notify() })
    notify()
  }

  ctx.effect(() => {
    rebind()
    const stop = ctx.on('internal/service', (name) => {
      if (name === 'remoteHostSelection') rebind()
    })
    return () => {
      stop()
      stopProvider?.()
      stopProvider = undefined
    }
  }, 'ui-workspace: optional remote host selection')

  return {
    source: {
      getSnapshot: () => provider()?.getSnapshot() ?? absent,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    hostId: () => provider()?.getSnapshot().hostId,
  }
}

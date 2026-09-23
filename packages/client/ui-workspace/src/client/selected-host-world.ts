/**
 * Pre-flight sample of the execution world a browse or creation entry
 * addresses.
 *
 * A remote host's execution world never reconnects: a lost connection
 * invalidates its pending operations and the Host holds no world for that id
 * afterwards, so an entry that reaches it can only fail. The followed host
 * list announces durable record writes only, which leaves a world that stopped
 * after its last baseline unannounced; this probe reads the existing
 * `hosts.list` verb at the moment an entry opens instead of adding a second
 * protocol.
 *
 * @module @deepseek-ai/dsh-client-ui-workspace/selected-host-world
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'

/** Whether a browse or creation entry can address the selected execution world. */
export type SelectedWorldState = 'addressable' | 'disconnected'

/** One sample of the selected workspace-creation world. */
export type SelectedHostWorldProbe = () => Promise<SelectedWorldState>

/**
 * Read the generated `hosts` Remote namespace.
 *
 * The namespace is an optional service for this package: a composition that
 * mounts no remote-host capability must keep browsing and creating on this
 * machine, so the read is a strict global lookup rather than a declared
 * injection, and it runs per sample because the namespace can be mounted later.
 */
export type HostsNamespaceRead = () => ClientRemote['hosts'] | undefined

/**
 * Create the probe one apply hands to its surfaces.
 * @param hosts - reads the generated `hosts` Remote namespace; undefined while
 *   the composition mounts no remote-host capability.
 * @param selectedHostId - reads the selected workspace-creation host; undefined
 *   is the Harness host, which always holds its own execution world.
 * @returns the probe the browse and creation entries run before they address a world.
 */
export function createSelectedHostWorldProbe(
  hosts: HostsNamespaceRead,
  selectedHostId: () => string | undefined,
): SelectedHostWorldProbe {
  return async () => {
    const hostId = selectedHostId()
    // This machine is not a remote execution world, so no host world can be gone.
    if (hostId === undefined) return 'addressable'
    const face = hosts()
    // A composition with no remote-host namespace holds no world a browse or
    // create could address, so nothing here can be reported as disconnected.
    if (face === undefined) return 'addressable'
    // A refused or rejected list is the carrier's own failure, which the
    // connection state reports: claiming a disconnected world here would blame
    // the host for a request that never reached it, so the entry proceeds and
    // the operation it starts answers for itself.
    const listed = await face.list().catch(() => undefined)
    if (listed === undefined || !listed.ok) return 'addressable'
    return listed.value.items.some(item => item.record.id === hostId && item.open)
      ? 'addressable'
      : 'disconnected'
  }
}

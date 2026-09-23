/**
 * Host Remote owner for GUI-managed SSH hosts: it lists the durable host
 * records with their live execution-world state, adds a host from entered login
 * material and a local helper-artifact manifest, removes one, checks that a
 * stored login still reaches its endpoint, and streams host-list changes.
 *
 * The registry (`ctx.remoteHosts`) owns records, realms and helper
 * provisioning, and the credentials store (`ctx.sshHostCredentials`) owns the
 * login material and the controlled OpenSSH identity. This package composes
 * both and adds no SSH behavior of its own; every entered secret stays in the
 * credential store and never reaches a returned value.
 *
 * @module @deepseek-ai/dsh-hosts-controller
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { ControlledSshIdentity } from '@deepseek-ai/dsh-host-credentials'
import { readHelperArtifact } from '@deepseek-ai/dsh-ssh-host-registry'
import type { RemoteHostHandle, RemoteHostId, RemoteHostSpec } from '@deepseek-ai/dsh-ssh-host-registry'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { followRemoteHosts, remoteHostView } from './feed.ts'
import type {
  RemoteHostAddRequest,
  RemoteHostAddValue,
  RemoteHostRemoveRequest,
  RemoteHostRemoveValue,
  RemoteHostTestRequest,
  RemoteHostTestValue,
  RemoteHostsFollowFrame,
  RemoteHostsListValue,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host SSH host-management API and Remote namespace owner. */
    hostsController: HostsController
  }
}

/**
 * Host service backing the generated `ctx.remote.hosts` namespace.
 *
 * Reads and writes report through `RemoteError` codes: `hosts/unknown-host`
 * when no stored login exists, `hosts/already-exists` when an id is taken,
 * `hosts/add-failed` when adding failed and the message must say what happened
 * to the partial state, and `hosts/no-login-identity` when an open host cannot
 * be checked.
 */
export class HostsController extends TypertRemoteService {
  /** Activation waits for the registry that owns records and the store that owns logins. */
  static inject = ['remoteHosts', 'sshHostCredentials']

  /** @param ctx - Host context carrying the remote-host registry and the credential store. */
  constructor(ctx: Context) {
    super(ctx, 'hostsController', { namespace: 'hosts' })
  }

  /**
   * Read every registered host: its durable record plus whether this process
   * currently holds an open execution world for it.
   * @returns every persisted record in id order, each with its open state.
   */
  @Remote('list')
  list(): RemoteHostsListValue {
    return { items: this.ctx.remoteHosts.records().map(record => remoteHostView(this.ctx, record)) }
  }

  /**
   * Store entered login material, install the helper from a local artifact
   * manifest, and open the host's execution world.
   *
   * These steps are one transaction: a failure removes the stored login, the
   * persisted record and any realm the registry opened, and reports that
   * outcome in a `hosts/add-failed` message. An id that a record or an open
   * world already uses is refused before anything is stored, so a failed add
   * never removes an existing host.
   * @param request - identity, remote paths, artifact manifest and entered login.
   * @returns the registered host as this call opened it.
   * @throws RemoteError when the id is taken or the add failed.
   */
  @Remote('add')
  async add(request: RemoteHostAddRequest): Promise<RemoteHostAddValue> {
    this.assertAddable(request.id)
    const id = brandString<RemoteHostId>(request.id)
    let handle: RemoteHostHandle
    try {
      await this.ctx.sshHostCredentials.store(request.id, request.login)
      const artifact = await readHelperArtifact({
        id,
        label: request.label,
        host: request.login.host,
        root: request.root,
        workspace: request.workspace,
        manifest: request.manifest,
      })
      handle = await this.ctx.remoteHosts.provisionFromLogin({
        id,
        label: request.label,
        login: request.login,
        root: request.root,
        workspace: request.workspace,
        artifact,
        manifest: request.manifest,
      })
    } catch (error) {
      throw await this.rollback(request.id, error)
    }
    return {
      host: {
        record: {
          id: request.id,
          label: request.label,
          host: handle.spec.host,
          root: request.root,
          workspace: request.workspace,
          manifest: request.manifest,
          helperHash: handle.spec.helperHash,
        },
        open: true,
      },
    }
  }

  /**
   * Remove one host's execution world, its persisted record and its stored
   * login material. Removing an id that is already gone resolves the same way,
   * so a repeated removal is safe.
   *
   * The wire method is `delete`, not `remove`: the Gateway Client installs a
   * namespace's methods on its namespace service, and `remove` is one of that
   * service's own members, so an endpoint published as `remove` is refused at
   * mount time.
   * @param request - identity of the host to remove.
   * @returns removal confirmation.
   */
  @Remote('delete')
  async remove(request: RemoteHostRemoveRequest): Promise<RemoteHostRemoveValue> {
    await this.ctx.remoteHosts.forget(brandString<RemoteHostId>(request.id))
    return { removed: true }
  }

  /**
   * Check that one host's stored login still reaches its endpoint by trusting
   * the host keys that endpoint currently publishes.
   *
   * A host with no open world is checked through a freshly materialized
   * identity, which is removed again afterwards; an open world's own identity is
   * borrowed instead, because the open handle owns those files and closing it is
   * the one removal. The check never writes a stored login and never returns
   * one.
   * @param request - identity of the host to check.
   * @returns the checked endpoint and the host keys its `known_hosts` records.
   * @throws RemoteError when no stored login exists, or when the open world was
   * opened from a configured artifact rather than stored login material.
   */
  @Remote('testConnection')
  async testConnection(request: RemoteHostTestRequest): Promise<RemoteHostTestValue> {
    const login = await this.ctx.sshHostCredentials.load(request.id)
    if (login === undefined) {
      throw new RemoteError(
        'hosts/unknown-host',
        `remote host '${request.id}' has no stored login material; add the host before checking its connection`,
        { id: request.id },
      )
    }
    const open = this.ctx.remoteHosts.get(brandString<RemoteHostId>(request.id))
    const identity = open === undefined
      ? await this.ctx.sshHostCredentials.materialize(login)
      : liveIdentity(open.spec)
    try {
      await this.ctx.sshHostCredentials.trustFirstUse(identity, { host: login.host, port: login.port })
      return {
        host: login.host,
        port: login.port,
        hostKeys: await readHostKeyLines(identity.knownHostsPath),
      }
    } finally {
      await identity.dispose()
    }
  }

  /**
   * Stream a complete host baseline followed by ordered increments, so a
   * browser list refreshes without polling.
   *
   * Only durable record changes are announced; the open flag is read from the
   * live registry at each baseline and upsert.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered host increments.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<RemoteHostsFollowFrame> {
    return followRemoteHosts(this.ctx, signal)
  }

  /**
   * Refuse an id a record or an open execution world already uses.
   * @param id - the id the caller asked to add.
   * @throws RemoteError when this registry already knows that id.
   */
  private assertAddable(id: string): void {
    const taken = this.ctx.remoteHosts.get(brandString<RemoteHostId>(id)) !== undefined
      || this.ctx.remoteHosts.records().some(record => record.id === id)
    if (taken) {
      throw new RemoteError(
        'hosts/already-exists',
        `remote host '${id}' is already registered; remove it before adding it again`,
        { id },
      )
    }
  }

  /**
   * Remove every trace of a failed add and describe the outcome.
   * @param id - the id the failed add used.
   * @param failure - the caught failure that stopped the add.
   * @returns the failure to throw, naming the id, the cause and the cleanup outcome.
   */
  private async rollback(id: string, failure: unknown): Promise<RemoteError> {
    const reason = reasonOf(failure)
    try {
      await this.ctx.remoteHosts.forget(brandString<RemoteHostId>(id))
    } catch (cleanupFailure) {
      return new RemoteError(
        'hosts/add-failed',
        `remote host '${id}' could not be added: ${reason}; removing its partial record and stored login also failed: ${reasonOf(cleanupFailure)}`,
        { id },
        { cause: failure },
      )
    }
    return new RemoteError(
      'hosts/add-failed',
      `remote host '${id}' could not be added: ${reason}; its stored login, record and any opened execution world were removed`,
      { id },
      { cause: failure },
    )
  }
}

/**
 * Address the controlled identity an open host handle already owns.
 *
 * The handle owns every generated file and removes them when it closes, so the
 * borrowed identity's `dispose` is deliberately neutral: a connection check
 * must never delete the configuration the open world still addresses. The
 * handle carries `sshConfigFile` exactly when the registry opened it from login
 * material and the credentials store wrote that configuration.
 * @param spec - the open host's resolved coordinates.
 * @returns the identity the credentials store wrote for that host.
 * @throws RemoteError when the world was opened from a configured artifact instead.
 */
function liveIdentity(spec: RemoteHostSpec): ControlledSshIdentity {
  const configPath = spec.sshConfigFile
  if (configPath === undefined) {
    throw new RemoteError(
      'hosts/no-login-identity',
      `remote host '${String(spec.id)}' is open from a configured helper artifact, so it has no stored-login identity to check`,
      { id: String(spec.id) },
    )
  }
  const directory = dirname(configPath)
  return {
    alias: spec.host,
    configPath,
    directory,
    knownHostsPath: join(directory, 'known_hosts'),
    dispose: () => Promise.resolve(),
  }
}

/**
 * Read every host-key line one identity's `known_hosts` records.
 * @param path - absolute path of the DSH-controlled `known_hosts` file.
 * @returns the file's non-empty lines.
 */
async function readHostKeyLines(path: string): Promise<readonly string[]> {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter(line => line.length > 0)
}

/**
 * Describe a caught value for a diagnostic.
 * @param error - the caught value.
 * @returns the error message, or the string form of a non-error.
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default HostsController

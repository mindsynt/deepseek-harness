/**
 * Per-host execution worlds: one isolated Cordis realm per registered remote host.
 *
 * The execution services are process-wide singletons, so several SSH hosts can
 * coexist in one process only by rebinding `ssh`, `fs`, `subprocess` and
 * `sandbox` under per-host isolation labels. A realm mounts the four SSH
 * providers into those labels and resolves them back from them; service names
 * that stay unisolated — `sandboxPolicy` today — keep resolving from the parent.
 * @module @deepseek-ai/dsh-ssh-host-registry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SshHostCredentials } from '@deepseek-ai/dsh-host-credentials'
import type { SshHelperInstaller } from '@deepseek-ai/dsh-helper-installer'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { sshComposition } from './composition.ts'
import { declaredHosts, provisionDeclaredHosts, restorePersistedHosts } from './config.ts'
import { remoteHostDomainSpec } from './spec.ts'
import type { RemoteHostRecord } from './spec.ts'
import type {
  RemoteHostHandle,
  RemoteHostId,
  RemoteHostLoginProvisionRequest,
  RemoteHostProvisionRequest,
  RemoteHostRegistry,
  RemoteHostSpec,
  RemoteHostWorld,
} from './types.ts'

export type {
  RemoteHostHandle,
  RemoteHostId,
  RemoteHostLogin,
  RemoteHostLoginProvisionRequest,
  RemoteHostProvisionRequest,
  RemoteHostRecord,
  RemoteHostRegistry,
  RemoteHostSpec,
  RemoteHostWorld,
} from './types.ts'
export { remoteHostDomainSpec, remoteHostRecord } from './spec.ts'
export { readHelperArtifact } from './config.ts'
export { sshComposition } from './composition.ts'

/** Stable plugin name of the remote-host registry. */
export const name = 'ssh-host-registry'

/**
 * Activation dependency: provisioning runs through the mounted installer, login
 * provisioning through the mounted credentials service, and host records through
 * the mounted domain data form.
 */
export const inject = ['sshHelperInstaller', 'sshHostCredentials', 'storageDomain']

/** One host a profile opens at startup. */
export interface RemoteHostEntryConfig {
  /** Registry identity; a non-empty token, never a path. */
  readonly id: string
  /** Caller-facing label; omission uses the id. */
  readonly label?: string
  /** OpenSSH host alias. */
  readonly host: string
  /** Absolute remote directory receiving the digest-named install directory. */
  readonly root: string
  /** Absolute remote default workspace. */
  readonly workspace: string
  /** Absolute local path of this host's artifact manifest; omission uses the plugin-level one. */
  readonly manifest?: string
}

/** Plugin config: the SSH hosts this deployment opens while the plugin activates. */
export interface Config {
  /** Hosts provisioned and opened while the plugin activates; omission opens none. */
  readonly hosts?: readonly RemoteHostEntryConfig[]
  /** Absolute local path of an artifact manifest every entry without its own `manifest` uses. */
  readonly manifest?: string
}

/** Config schema: host entries are shapes only; field rules are enforced at activation. */
export const Config: z<Config> = z.object({
  hosts: z.array(z.object({
    id: z.string().required(),
    label: z.string(),
    host: z.string().required(),
    root: z.string().required(),
    workspace: z.string().required(),
    manifest: z.string(),
  })),
  manifest: z.string(),
}) as z<Config>

/**
 * Composition point mounting one host's execution services into its isolated realm.
 * Deployments and tests both supply one; {@link sshComposition} is the default.
 * @param realm - the isolated context of exactly one host.
 * @param spec - resolved connection and helper coordinates of that host.
 * @returns the execution services resolved inside `realm`.
 */
export type RemoteHostComposition = (realm: Context, spec: RemoteHostSpec) => Promise<RemoteHostWorld>

/**
 * Compose the registry on a context: validate the declared hosts, mount the
 * service, provision every declared host exactly once through the mounted
 * `sshHelperInstaller`, then restore every persisted host the config does not
 * declare through the mounted `sshHostCredentials` (the declared injections
 * delay activation until all three services exist).
 * @param ctx - the context the plugin is mounted on.
 * @param config - the declared hosts and the default artifact manifest.
 * @returns a promise settling once every declared and restored host is open.
 * @throws when the config is invalid, a manifest or archive cannot be read, a
 * host cannot be provisioned, or a persisted record has no stored login
 * material.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const hosts = declaredHosts(config)
  await ctx.plugin(RemoteHostRegistryService)
  // The registry is provided by the child fiber just mounted, not injected into
  // this one, so a Loader-mounted entry must read it through `ctx.get`.
  const registry = ctx.get('remoteHosts')
  if (registry === undefined) throw new Error('ssh host registry: the mounted service is unavailable')
  const credentials = ctx.get('sshHostCredentials')
  if (credentials === undefined) throw new Error('ssh host registry: sshHostCredentials is unavailable for startup recovery')
  await provisionDeclaredHosts(registry, hosts)
  await restorePersistedHosts(registry, credentials, hosts)
}

/** No-op plugin body; the fiber it starts owns exactly one host realm. */
function realmOwner(): void {}

/** Execution service names one host realm rebinds. */
const REALM_SERVICES = ['ssh', 'fs', 'subprocess', 'sandbox'] as const

/**
 * Isolate every execution service name for one host, each name under its own label.
 *
 * Cordis keys a service implementation by isolation label alone, so the four
 * names cannot share one label: the second `provide` would collide, and a read
 * of the second name would return the first implementation. The loader's named
 * realms key their symbols by label AND service name for the same reason.
 * @param ctx - the context the registry is mounted on.
 * @param id - the host whose realm is opened.
 * @returns the isolated context that host's providers mount on.
 */
function hostRealm(ctx: Context, id: RemoteHostId): Context {
  return REALM_SERVICES.reduce<Context>(
    (realm, service) => realm.isolate(service, Symbol(`${id}:${service}`)),
    ctx,
  )
}

/** Registry owning one isolated execution realm per open remote host. */
export class RemoteHostRegistryService extends Service implements RemoteHostRegistry {
  /**
   * Persisted records live in `storageDomain`; a mount that cannot reach it
   * stays pending instead of activating without durability.
   */
  static inject = ['storageDomain']

  private readonly hosts = new Map<RemoteHostId, RemoteHostHandle>()
  /** Ids whose realm is still being composed; a second open must not start one. */
  private readonly opening = new Set<RemoteHostId>()
  /** The open domain, held so its close effect and requeued reads share one handle. */
  private domain: Domain<typeof remoteHostDomainSpec> | undefined
  /** The `hosts` table handle, present exactly while {@link domain} is open. */
  private hostsTable: KvTable<RemoteHostId, RemoteHostRecord> | undefined
  /** In-flight or settled open, so concurrent first uses open the domain once. */
  private domainOpen: Promise<KvTable<RemoteHostId, RemoteHostRecord>> | undefined

  /**
   * @param ctx - the context the registry is mounted on.
   * @param composition - mounts one host's execution services into its realm.
   * @param installer - helper installer used by {@link provision}; defaults to the mounted service.
   * @param credentials - login credentials used by {@link provisionFromLogin}; defaults to the mounted service.
   */
  constructor(
    ctx: Context,
    private readonly composition: RemoteHostComposition = sshComposition,
    private readonly installer?: SshHelperInstaller,
    private readonly credentials?: SshHostCredentials,
  ) {
    super(ctx, 'remoteHosts')
    // Registered first so disposal runs it last: the domain outlives every
    // realm that reads or writes its records.
    ctx.effect(() => () => this.closeDomain())
    ctx.effect(() => () => this.closeAll())
  }

  /** Open the record domain while activating, so {@link records} reads synchronously afterwards. */
  protected async [Service.init](): Promise<void> {
    await this.tableOf()
  }

  /**
   * Open one host realm; a duplicate id fails loud.
   * @param spec - resolved connection and helper coordinates of the host.
   * @returns the open handle.
   * @throws when the id is already open, or when the composition fails to provide a world.
   */
  async open(spec: RemoteHostSpec): Promise<RemoteHostHandle> {
    return this.openHandle(spec)
  }

  /**
   * Open one host realm, optionally owning a resource until the handle closes.
   * @param spec - resolved connection and helper coordinates of the host.
   * @param release - releases the resource the handle owns; runs after the realm is gone.
   * @returns the open handle.
   * @throws when the id is already open, or when the composition fails to provide a world.
   */
  private async openHandle(spec: RemoteHostSpec, release?: () => Promise<void>): Promise<RemoteHostHandle> {
    this.assertAvailable(spec.id)
    this.opening.add(spec.id)
    try {
      const owner = await this.ctx.plugin(realmOwner)
      const realm = hostRealm(owner.ctx, spec.id)
      let world: RemoteHostWorld
      try {
        world = await this.composition(realm, spec)
      } catch (error) {
        await owner.dispose()
        throw error
      }
      const closed = Promise.withResolvers<void>()
      let closing: Promise<void> | undefined
      const handle: RemoteHostHandle = {
        spec,
        world,
        closed: closed.promise,
        close: async () => {
          closing ??= (async () => {
            await owner.dispose()
            this.hosts.delete(spec.id)
            await release?.()
            closed.resolve()
          })()
          await closing
        },
      }
      this.hosts.set(spec.id, handle)
      return handle
    } finally {
      this.opening.delete(spec.id)
    }
  }

  /**
   * Install the helper on a host, then open its realm from the returned coordinates.
   * @param request - host, remote root, workspace and artifact.
   * @returns the opened handle.
   * @throws when the id is already open, when no installer is mounted, or when the install fails.
   */
  async provision(request: RemoteHostProvisionRequest): Promise<RemoteHostHandle> {
    this.assertAvailable(request.id)
    const installation = await this.resolveInstaller().install({
      host: request.host,
      root: request.root,
      workspace: request.workspace,
      artifact: request.artifact,
    })
    return this.open({
      id: request.id,
      label: request.label,
      host: request.host,
      node: installation.node,
      helper: installation.helper,
      helperHash: installation.helperHash,
      workspace: installation.workspace,
    })
  }

  /**
   * Materialize entered login material, trust its host key, install the helper
   * through that identity, then open the realm it addresses.
   *
   * The returned handle owns the materialized identity: closing it releases the
   * realm and then removes the identity's generated directory, once. A failure
   * from host-key trust through composition removes the identity before the
   * failure is rethrown; when that removal also fails, the failure is reported
   * with the original provisioning error as its `cause`.
   *
   * A request carrying `manifest` persists one host record after the realm
   * opens, with `host` taken from the materialized alias and `helperHash` from
   * the installation. A record write that fails closes the opened realm and
   * its identity before rethrowing, so a failed call leaves no open host.
   * Without `manifest` the realm still opens and no record is written — the
   * host then survives no restart.
   * @param request - identity, login material, remote root, workspace and artifact.
   * @returns the opened handle.
   * @throws when the id is already open, when no credentials service is
   * reachable, or when trust, install, composition or record persistence fails.
   */
  async provisionFromLogin(request: RemoteHostLoginProvisionRequest): Promise<RemoteHostHandle> {
    this.assertAvailable(request.id)
    const credentials = this.resolveCredentials()
    const identity = await credentials.materialize(request.login)
    let handle: RemoteHostHandle
    let record: RemoteHostRecord | undefined
    try {
      await credentials.trustFirstUse(identity, { host: request.login.host, port: request.login.port })
      const installation = await this.resolveInstaller().install({
        host: identity.alias,
        root: request.root,
        workspace: request.workspace,
        artifact: request.artifact,
        sshConfigFile: identity.configPath,
      })
      record = request.manifest === undefined ? undefined : {
        id: request.id,
        label: request.label,
        host: identity.alias,
        root: request.root,
        workspace: request.workspace,
        manifest: request.manifest,
        helperHash: installation.helperHash,
      }
      handle = await this.openHandle({
        id: request.id,
        label: request.label,
        host: identity.alias,
        sshConfigFile: identity.configPath,
        node: installation.node,
        helper: installation.helper,
        helperHash: installation.helperHash,
        workspace: installation.workspace,
      }, () => identity.dispose())
    } catch (error) {
      try {
        await identity.dispose()
      } catch (removalError) {
        throw new Error(`remote host ${request.id}: provisioning failed and the materialized identity could not be removed: ${String(removalError)}`, { cause: error })
      }
      throw error
    }
    if (record !== undefined) {
      try {
        await this.save(record)
      } catch (error) {
        // The handle owns the identity, so closing it is the single removal;
        // the outer failure path must not dispose the identity a second time.
        await handle.close()
        throw error
      }
    }
    return handle
  }

  /**
   * The open handle for an id, or undefined.
   * @param id - the host id to look up.
   * @returns the open handle, or `undefined` when that id is not open.
   */
  get(id: RemoteHostId): RemoteHostHandle | undefined {
    return this.hosts.get(id)
  }

  /**
   * Every open handle.
   * @returns the open handles in the order they were opened.
   */
  list(): readonly RemoteHostHandle[] {
    return [...this.hosts.values()]
  }

  /**
   * Close one host realm; unknown ids are a no-op.
   * @param id - the host id to close.
   * @returns a promise settling once the realm and its providers are released.
   */
  async close(id: RemoteHostId): Promise<void> {
    await this.hosts.get(id)?.close()
  }

  /**
   * Every persisted host record, in id order.
   * @returns a fresh array of records sorted by id.
   * @throws when the domain is not open, so a caller never reads an empty registry for a missing store.
   */
  records(): readonly RemoteHostRecord[] {
    return [...this.requireHostsTable().entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([, record]) => record)
  }

  /**
   * Persist one host record, replacing any record with the same id.
   * @param record - the record to write.
   * @returns a promise settling once the record is durable.
   */
  async save(record: RemoteHostRecord): Promise<void> {
    const table = await this.tableOf()
    await table.put(brandString<RemoteHostId>(record.id), record)
  }

  /**
   * Close one host, remove its persisted record, and forget its stored login material.
   *
   * The order matters: the realm — and the identity its handle owns — is gone
   * before the record and the stored login are removed. A repeat for an id
   * that is closed and already unrecorded resolves, and still asks the
   * credentials service to forget the id.
   * @param id - the host to remove.
   * @returns a promise settling once the realm, record and stored login are removed.
   * @throws when no credentials service is reachable, or when record removal or credential removal fails.
   */
  async forget(id: RemoteHostId): Promise<void> {
    await this.close(id)
    await (await this.tableOf()).delete(id)
    await this.resolveCredentials().forget(id)
  }

  /** Release every open realm; the registry's own disposal calls this. */
  private async closeAll(): Promise<void> {
    await Promise.all([...this.hosts.values()].map(handle => handle.close()))
  }

  /** Close the record domain; the registry's own disposal calls this. */
  private async closeDomain(): Promise<void> {
    const domain = this.domain
    this.domain = undefined
    this.hostsTable = undefined
    this.domainOpen = undefined
    await domain?.close()
  }

  /**
   * The `hosts` table, opening the domain on first use.
   * @returns the open table handle.
   * @throws when this context has no `storageDomain` service, or when the domain fails to open.
   */
  private tableOf(): Promise<KvTable<RemoteHostId, RemoteHostRecord>> {
    this.domainOpen ??= this.openDomain()
    return this.domainOpen
  }

  /**
   * Open the declared domain and keep its handle for reads, writes and disposal.
   * @returns the open `hosts` table handle.
   * @throws when this context has no `storageDomain` service, or when the domain fails to open.
   */
  private async openDomain(): Promise<KvTable<RemoteHostId, RemoteHostRecord>> {
    const facility = this.ctx.get('storageDomain')
    if (facility === undefined) {
      throw new Error('remote host persistence needs @deepseek-ai/dsh-storage-domain mounted in this context')
    }
    const domain = await facility.open(remoteHostDomainSpec)
    this.domain = domain
    this.hostsTable = domain.table('hosts')
    return this.hostsTable
  }

  /**
   * The already-open `hosts` table.
   * @returns the open table handle.
   * @throws when the domain has not been opened, so a synchronous read never invents an empty registry.
   */
  private requireHostsTable(): KvTable<RemoteHostId, RemoteHostRecord> {
    if (this.hostsTable === undefined) throw new Error('remote host registry records are not open yet')
    return this.hostsTable
  }

  /**
   * Reject an id whose realm is open or still composing, so a duplicate never starts a second realm.
   * @param id - the host id about to open.
   * @throws when that id already has an open or in-flight realm.
   */
  private assertAvailable(id: RemoteHostId): void {
    if (this.hosts.has(id) || this.opening.has(id)) throw new Error(`remote host ${id} is already open`)
  }

  /**
   * The installer provisioning runs through.
   * @returns the constructor-injected installer, else the mounted `sshHelperInstaller` service.
   * @throws when this context has neither.
   */
  private resolveInstaller(): SshHelperInstaller {
    const installer = this.installer ?? this.ctx.get('sshHelperInstaller')
    if (installer === undefined) {
      throw new Error('remote host provisioning needs @deepseek-ai/dsh-helper-installer mounted in this context')
    }
    return installer
  }

  /**
   * The credentials service login provisioning runs through.
   * @returns the constructor-injected service, else the mounted `sshHostCredentials` service.
   * @throws when this context has neither.
   */
  private resolveCredentials(): SshHostCredentials {
    const credentials = this.credentials ?? this.ctx.get('sshHostCredentials')
    if (credentials === undefined) {
      throw new Error('remote host login provisioning needs @deepseek-ai/dsh-host-credentials mounted in this context')
    }
    return credentials
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { remoteHosts: RemoteHostRegistryService }
}

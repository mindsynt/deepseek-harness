# SSH

English | [中文](ssh.zh.md)

The [SSH provider family](../../packages/ssh/README.md) supplies one remote filesystem/process world through a deployment-owned OpenSSH connection. The Harness, model transport and Session storage remain on the host. The family implements the existing filesystem, subprocess and sandbox APIs; it introduces no SSH-specific model tools.

## Execution coordinates

Filesystem identities, executable lookup, process cwd, sandbox workspace roots and language-server file URLs refer to the SSH host. Providers canonicalize paths where the files exist, preserving filesystem interpretation of `symlink/..`. The policy resolver carries absolute execution-world spelling without trying to resolve remote paths on the Harness host.

`processPath()` supplies a path usable by the paired subprocess provider. `processPathFromHostPath()` remains unavailable for SSH; installing a remote artifact does not make an arbitrary host path portable. [`NodePtcRuntime`](../../packages/ptc-runtime/ptc-runtime-node/README.md) therefore takes an explicitly installed, digest-verified remote bootstrap.

## Transport and trust

Administrative RPC uses the helper’s SSH exec streams. Ordinary stdin, stdout, stderr, terminal output and optional fd 7 control traffic use separately authenticated forwarded Unix sockets. Each forwarded stream has its own SSH channel window; paused program output does not share the control or administrative window. All channels still share connection bandwidth and transport failure.

Deployment authentication, installed artifact verification and per-stream TLS authentication belong to [`dsh-ssh`](../../packages/ssh/ssh/README.md). The helper executes filesystem and process requests with trusted local providers on the remote machine. SSH is a transport; the selected remote sandbox provider enforces file effects.

## Process lifetime and cancellation

A process is reserved before its streams are connected, and launch is accepted at most once. `done` reports the direct result; `waitForExit` observes the remote managed range. Terminal operations retain the asynchronous shared API. Preparation cancellation, launched-process termination and provider disposal release their owned resources through the helper.

Administrative deadlines bound individual RPC observations; they do not replace the execution deadline chosen by a Bash or ptc-runtime consumer. Remote waits can remain pending while other requests progress. SSH loss invalidates pending operations; helper EOF, signals and lease expiry start remote cleanup. The client reports unconfirmed outcomes honestly and never reconnects to replay a possibly executed action.

## Composition scope

Headless records and checks Session cwd through the mounted filesystem provider. Remote FS, Bash, terminal, LSP and PTC consumers can therefore share those coordinates. Web workspace views that assume host filesystem access need separate integration; replacing providers alone does not make those views remote-aware.

See the [decision record](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) for the alternatives and verification obligations.

## Connection API

```ts type-equiv
/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Absolute remote Node executable. */
  node: string
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /**
   * Absolute local OpenSSH client configuration file passed to `ssh -F`; when
   * omitted, the client falls back to its own default configuration, so an
   * alias defined only in a DSH-generated file is unreachable.
   */
  sshConfigFile?: string
  /** Optional preinstalled built PTC entry, paired with its expected digest. */
  bootstrapPath?: string
  /** SHA-256 of bootstrapPath; both fields must be supplied together. */
  bootstrapHash?: string
  /** Connection and administrative-request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded resource cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
}
```

```ts public-api
/** One non-reconnecting SSH session; loss invalidates all active operations. */
declare class SshConnection extends Service {
  static Config: schema<Config>;
  /** Verified remote helper coordinates; callers must await this before launch. */
  readonly ready: Promise<Hello>;
  constructor(ctx: Context, config: Config);
  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void>;
  /** Verified remote Node executable for the paired PTC runtime. */
  get nodeExecutable(): string;
  /** Verified preinstalled PTC entry; unconfigured runtimes fail before program execution. */
  get bootstrapPath(): string;
  /**
     * Send a helper operation; cancellation never replays an ambiguous mutation.
     * @param method - the private helper operation.
     * @param params - JSON request fields validated by the helper.
     * @param result - response validation before returning provider-visible data.
     * @param signal - cancellation, which does not undo completed remote effects.
     * @param wait - allow a process observation to outlast the administrative deadline.
     * @returns the validated remote result.
     */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>;
  /**
     * Forward one authenticated stream through an independent SSH channel.
     * @param endpoint - private coordinates issued by this connection's helper.
     * @param signal - cancellation of allocation and the resulting socket.
     * @returns a paused socket; attach a consumer before resuming it.
     */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket>;
  /** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
  dispose(): Promise<void>;
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhostscontroller--hostscontroller"></a>

### `ctx.hostsController` — `HostsController`

Host service backing the generated `ctx.remote.hosts` namespace.

Reads and writes report through `RemoteError` codes: `hosts/unknown-host` when no stored login exists, `hosts/already-exists` when an id is taken, `hosts/add-failed` when adding failed and the message must say what happened to the partial state, and `hosts/no-login-identity` when an open host cannot be checked.

```ts cordis-catalog
/**
 * Read every registered host: its durable record plus whether this process
 * currently holds an open execution world for it.
 * @returns every persisted record in id order, each with its open state.
 */
@Remote('list') list(): RemoteHostsListValue

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
@Remote('add') async add(request: RemoteHostAddRequest): Promise<RemoteHostAddValue>

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
@Remote('delete') async remove(request: RemoteHostRemoveRequest): Promise<RemoteHostRemoveValue>

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
@Remote('testConnection') async testConnection(request: RemoteHostTestRequest): Promise<RemoteHostTestValue>

/**
 * Stream a complete host baseline followed by ordered increments, so a
 * browser list refreshes without polling.
 *
 * Only durable record changes are announced; the open flag is read from the
 * live registry at each baseline and upsert.
 * @param signal - generation cancellation.
 * @returns baseline followed by ordered host increments.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<RemoteHostsFollowFrame>
```

Source: [`packages/api/hosts-controller/src/index.ts`](../../packages/api/hosts-controller/src/index.ts)

<a id="ctxremotehosts--remotehostregistryservice"></a>

### `ctx.remoteHosts` — `RemoteHostRegistryService`

Registry owning one isolated execution realm per open remote host.

```ts cordis-catalog
/**
 * Open one host realm; a duplicate id fails loud.
 * @param spec - resolved connection and helper coordinates of the host.
 * @returns the open handle.
 * @throws when the id is already open, or when the composition fails to provide a world.
 */
async open(spec: RemoteHostSpec): Promise<RemoteHostHandle>

/**
 * Install the helper on a host, then open its realm from the returned coordinates.
 * @param request - host, remote root, workspace and artifact.
 * @returns the opened handle.
 * @throws when the id is already open, when no installer is mounted, or when the install fails.
 */
async provision(request: RemoteHostProvisionRequest): Promise<RemoteHostHandle>

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
async provisionFromLogin(request: RemoteHostLoginProvisionRequest): Promise<RemoteHostHandle>

/**
 * The open handle for an id, or undefined.
 * @param id - the host id to look up.
 * @returns the open handle, or `undefined` when that id is not open.
 */
get(id: RemoteHostId): RemoteHostHandle | undefined

/**
 * Every open handle.
 * @returns the open handles in the order they were opened.
 */
list(): readonly RemoteHostHandle[]

/**
 * Close one host realm; unknown ids are a no-op.
 * @param id - the host id to close.
 * @returns a promise settling once the realm and its providers are released.
 */
async close(id: RemoteHostId): Promise<void>

/**
 * Every persisted host record, in id order.
 * @returns a fresh array of records sorted by id.
 * @throws when the domain is not open, so a caller never reads an empty registry for a missing store.
 */
records(): readonly RemoteHostRecord[]

/**
 * Persist one host record, replacing any record with the same id.
 * @param record - the record to write.
 * @returns a promise settling once the record is durable.
 */
async save(record: RemoteHostRecord): Promise<void>

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
async forget(id: RemoteHostId): Promise<void>
```

Source: [`packages/ssh/host-registry/src/index.ts`](../../packages/ssh/host-registry/src/index.ts)

<a id="ctxssh--sshconnection"></a>

### `ctx.ssh` — `SshConnection`

One non-reconnecting SSH session; loss invalidates all active operations.

```ts cordis-catalog
/**
 * Send a helper operation; cancellation never replays an ambiguous mutation.
 * @param method - the private helper operation.
 * @param params - JSON request fields validated by the helper.
 * @param result - response validation before returning provider-visible data.
 * @param signal - cancellation, which does not undo completed remote effects.
 * @param wait - allow a process observation to outlast the administrative deadline.
 * @returns the validated remote result.
 */
async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>

/**
 * Forward one authenticated stream through an independent SSH channel.
 * @param endpoint - private coordinates issued by this connection's helper.
 * @param signal - cancellation of allocation and the resulting socket.
 * @returns a paused socket; attach a consumer before resuming it.
 */
async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket>

/** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
dispose(): Promise<void>
```

Source: [`packages/ssh/ssh/src/index.ts`](../../packages/ssh/ssh/src/index.ts)

<a id="ctxsshhelperinstaller--sshhelperinstallerservice"></a>

### `ctx.sshHelperInstaller` — `SshHelperInstallerService`

Installer service: places one verified helper artifact on a host, or confirms an identical install already there. Every remote command is single-line and single-quotes each interpolated path.

```ts cordis-catalog
/**
 * Provision one host, or confirm an identical install already exists.
 * @param request - host, remote root, workspace, artifact and optional local SSH client configuration.
 * @returns verified coordinates for the SSH connection config.
 * @throws when the host cannot run the engine range, a remote command fails, or the installed entry digest differs from the artifact.
 */
async install(request: HelperInstallRequest): Promise<HelperInstallation>
```

Source: [`packages/ssh/helper-installer/src/index.ts`](../../packages/ssh/helper-installer/src/index.ts)

<a id="ctxsshhostcredentials--sshhostcredentialsservice"></a>

### `ctx.sshHostCredentials` — `SshHostCredentialsService`

Store one host's login material and materialize its DSH-controlled OpenSSH identity on demand.

Validation happens before any file or record write, so a rejected login leaves both the credential store and the state directory untouched.

```ts cordis-catalog
/**
 * Write one host's controlled configuration and identity.
 * @param login - host, port, user and optional private key.
 * @returns the identity whose alias addresses that host.
 * @throws when a field is malformed, or a generated file cannot be written.
 */
async materialize(login: RemoteHostLogin): Promise<ControlledSshIdentity>

/**
 * Store one host's login material so later sessions reuse it without prompting.
 * @param id - the host's registry id.
 * @param login - host, port, user and optional private key.
 * @throws when the id or a login field is malformed, or the credential store rejects the write.
 */
async store(id: string, login: RemoteHostLogin): Promise<void>

/**
 * The stored login material, or undefined while none is stored.
 * @param id - the host's registry id.
 * @returns the stored login, or `undefined` when this id has no record.
 * @throws when the id is malformed or the stored record is not this package's payload.
 */
async load(id: string): Promise<RemoteHostLogin | undefined>

/**
 * Remove stored material and any materialized files for that id.
 * @param id - the host's registry id.
 * @throws when the id is malformed or the stored record is not this package's payload.
 */
async forget(id: string): Promise<void>

/**
 * Append one confirmed host-key line to a materialized identity's `known_hosts`.
 * @param identity - the identity whose `known_hosts` receives the line.
 * @param line - one non-empty, single-line `known_hosts` entry.
 * @throws when the line is empty, spans lines, carries a NUL character, or holds fewer than two fields.
 */
async pinHostKey(identity: ControlledSshIdentity, line: string): Promise<void>

/**
 * Trust a host's published keys for the first time by scanning the real
 * endpoint and recording what it publishes. Only lines the identity's
 * `known_hosts` does not already carry are appended, so repeated calls for
 * one endpoint change nothing and earlier lines survive untouched.
 * @param identity - the identity whose `known_hosts` receives the keys.
 * @param endpoint - real host and port whose keys are scanned.
 * @throws when the endpoint is malformed, the scan fails, a scanned line is malformed, or the host publishes no key.
 */
async trustFirstUse(identity: ControlledSshIdentity, endpoint: HostKeyEndpoint): Promise<void>
```

Source: [`packages/ssh/host-credentials/src/index.ts`](../../packages/ssh/host-credentials/src/index.ts)
<!-- END GENERATED cordis-surface -->

# SSH

English | [中文](ssh.zh.md)

The [SSH provider family](../../packages/ssh/README.md) supplies one remote filesystem/process world through a deployment-owned OpenSSH connection. The Harness, model transport and Session storage remain on the host. The family implements the existing filesystem, subprocess and sandbox APIs; it introduces no SSH-specific model tools.

## Architecture

The SSH provider family uses **native SSH** — no remote helper daemon is required. Filesystem operations use the SFTP subsystem; process execution uses SSH exec channels. Remote hosts need only an OpenSSH server; no Node.js runtime, tar, or GNU coreutils are required on the remote machine.

## Execution coordinates

Filesystem identities, executable lookup, process cwd, sandbox workspace roots and language-server file URLs refer to the SSH host. Providers canonicalize paths where the files exist, preserving filesystem interpretation of `symlink/..`. The policy resolver carries absolute execution-world spelling without trying to resolve remote paths on the Harness host.

`processPath()` supplies a path usable by the paired subprocess provider. `processPathFromHostPath()` remains unavailable for SSH. [`NodePtcRuntime`](../../packages/ptc-runtime/ptc-runtime-node/README.md) therefore requires an explicitly installed, digest-verified remote bootstrap.

## Transport and trust

Filesystem operations use the SFTP subsystem over an independent SSH channel. Process execution uses SSH exec channels, each with its own channel window. Interactive terminals use PTY requests over SSH exec channels.

SSH authentication is handled by the `ssh2` library on the host machine. Host key verification uses OpenSSH's standard `known_hosts` mechanism through the credentials service. Each connection is independent; loss of a connection invalidates all active operations on that connection.

## Process lifetime and cancellation

A process is spawned through an SSH exec channel. `done` reports the exit code, stdout and stderr. `wait()` observes the process until it exits. `write()` sends data to the process's stdin. `resize()` adjusts the PTY size for terminal sessions.

SSH loss invalidates pending operations. The client reports unconfirmed outcomes honestly and never reconnects to replay a possibly executed action.

## Composition scope

Headless records and checks Session cwd through the mounted filesystem provider. Remote FS, Bash, terminal, LSP and PTC consumers can therefore share those coordinates. Web workspace views that assume host filesystem access need separate integration; replacing providers alone does not make those views remote-aware.

See the [decision record](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) for the alternatives and verification obligations.

## Connection API

```ts type-equiv
/** Deployment-owned SSH identity; no model argument selects these values. */
interface Config {
  /** Remote host address (hostname or IP). */
  host: string
  /** Remote port (default: 22). */
  port?: number
  /** Username. */
  username: string
  /** Private key content (PEM format). */
  privateKey?: string
  /** Password (mutually exclusive with privateKey). */
  password?: string
  /** Local OpenSSH client configuration file to read identity from. */
  identityFile?: string
  /** Path to known_hosts file. */
  knownHostsFile?: string
  /** Connection timeout in milliseconds (default: 30000). */
  connectTimeout?: number
  /** Keepalive interval in milliseconds (default: 30000). */
  keepaliveInterval?: number
  /** Keepalive count max (default: 3). */
  keepaliveCountMax?: number
  /** Strict host key checking mode. */
  strictHostKeyChecking?: 'yes' | 'no' | 'accept-new'
  /** Maximum SFTP read size in bytes (default: 64MB). */
  maxSftpReadBytes?: number
  /** Maximum exec output size in bytes (default: 64MB). */
  maxExecOutputBytes?: number
}
```

```ts public-api
/** One non-reconnecting SSH session; loss invalidates all active operations. */
declare class SshNativeConnection extends Service {
  static Config: schema<Config>;
  /** Resolves when the connection and SFTP subsystem are ready. */
  readonly ready: Promise<void>;
  constructor(ctx: Context, config: Config);
  /** Hold plugin readiness until the connection is established. */
  async [Service.init](): Promise<void>;
  /** The underlying ssh2 Client, available after readiness. */
  get clientConnection(): Client;
  /** The SFTP client, available after readiness. */
  get sftpClient(): SFTPWrapper;
  /** Get file stat information. */
  async sftpStat(path: string): Promise<NativeSftpStat | undefined>;
  /** Get file stat information (follow symlinks). */
  async sftpLstat(path: string): Promise<NativeSftpStat | undefined>;
  /** Read a file. */
  async sftpRead(path: string): Promise<Buffer | undefined>;
  /** Read a range from a file. */
  async sftpReadRange(path: string, offset: number, length: number): Promise<Buffer>;
  /** Write a file. */
  async sftpWrite(path: string, data: Buffer): Promise<void>;
  /** Create a directory. */
  async sftpMkdir(path: string): Promise<void>;
  /** List directory entries. */
  async sftpReaddir(path: string): Promise<NativeSftpEntry[] | undefined>;
  /** Resolve a path to its canonical form. */
  async sftpRealpath(path: string): Promise<NativeSftpRealpath | undefined>;
  /** Remove a file. */
  async sftpUnlink(path: string): Promise<void>;
  /** Spawn a command on the remote host. */
  async exec(command: string, options?: NativeExecOptions): Promise<NativeExecHandle>;
  /** Resolve an executable on the remote host. */
  async resolveExecutable(command: string): Promise<string | undefined>;
  /** Get the terminal environment on the remote host. */
  async terminalEnvironment(): Promise<{ shellPath: string; shellArgs: string[] }>;
  /** Tear down the connection and all running operations. */
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
 * Store entered login material and open the host's execution world.
 *
 * These steps are one transaction: a failure removes the stored login, the
 * persisted record and any realm the registry opened, and reports that
 * outcome in a `hosts/add-failed` message. An id that a record or an open
 * world already uses is refused before anything is stored, so a failed add
 * never removes an existing host.
 * @param request - identity, label and entered login.
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
async open(spec: NativeRemoteHostSpec): Promise<RemoteHostHandle>

/**
 * Install the helper on a host, then open its realm from the returned coordinates.
 * @param _request - host, remote root, workspace and artifact.
 * @returns the opened handle.
 * @throws when the id is already open, when no installer is mounted, or when the install fails.
 */
async provision(_request: RemoteHostProvisionRequest): Promise<RemoteHostHandle>

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
 * @param _request - identity, login material, remote root, workspace and artifact.
 * @returns the opened handle.
 * @throws when the id is already open, when no credentials service is
 * reachable, or when trust, install, composition or record persistence fails.
 */
async provisionFromLogin(_request: RemoteHostLoginProvisionRequest): Promise<RemoteHostHandle>

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

<a id="ctxsshnative--sshnativeconnection"></a>

### `ctx.sshNative` — `SshNativeConnection`

Native SSH connection owner; one connection per service instance.

```ts cordis-catalog
/**
 * Dispose the connection and all running operations.
 */
async dispose(): Promise<void>

/**
 * Get file stat information.
 * @param path - absolute remote path.
 * @returns stat information or undefined if not found.
 */
async sftpStat(path: string): Promise<NativeSftpStat | undefined>

/**
 * Get file stat information without following symlinks.
 * @param path - absolute remote path.
 * @returns stat information or undefined if not found.
 */
async sftpLstat(path: string): Promise<NativeSftpStat | undefined>

/**
 * Read an entire file.
 * @param path - absolute remote path.
 * @returns the file contents.
 */
async sftpRead(path: string): Promise<Buffer>

/**
 * Read a byte range from a file.
 * @param path - absolute remote path.
 * @param offset - byte offset to start reading.
 * @param length - number of bytes to read.
 * @returns the file contents at the specified range.
 */
async sftpReadRange(path: string, offset: number, length: number): Promise<Buffer>

/**
 * Write a file.
 * @param path - absolute remote path.
 * @param data - file contents.
 */
async sftpWrite(path: string, data: Buffer): Promise<void>

/**
 * Create a directory.
 * @param path - absolute remote path.
 * @param recursive - create parent directories.
 */
async sftpMkdir(path: string, recursive: boolean = false): Promise<void>

/**
 * List directory entries.
 * @param path - absolute remote path.
 * @returns directory entries.
 */
async sftpReaddir(path: string): Promise<NativeSftpEntry[]>

/**
 * Resolve a path to its canonical form.
 * @param path - remote path to resolve.
 * @returns the canonical absolute path.
 */
async sftpRealpath(path: string): Promise<string>

/**
 * Remove a file.
 * @param path - absolute remote path.
 */
async sftpUnlink(path: string): Promise<void>

/**
 * Spawn a command on the remote host.
 * @param command - the command to execute.
 * @param options - execution options.
 * @returns a handle to the running process.
 */
async exec(command: string, options: NativeExecOptions = {}): Promise<NativeExecHandle>

/**
 * Resolve an executable on the remote host.
 * @param command - command name to resolve.
 * @returns the absolute path, or undefined if not found.
 */
async resolveExecutable(command: string): Promise<string | undefined>

/**
 * Execute multiple SFTP operations in a batch.
 * @param operations - array of SFTP operations to execute.
 * @returns results for each operation.
 */
async sftpBatch(operations: NativeSftpBatchOperation[]): Promise<NativeSftpBatchResult[]>

/**
 * Create a streaming reader for a file.
 * @param path - absolute remote path.
 * @param options - read options (start offset, chunk size).
 * @returns a streaming reader.
 */
async sftpReadStream( path: string, options: { start?: number; chunkSize?: number } = {}, ): Promise<NativeSftpReadStream>

/**
 * Get the terminal environment on the remote host.
 * @returns shell path and arguments.
 */
async terminalEnvironment(): Promise<{ shellPath: string; shellArgs: string[] }>

/**
 * Validate the configuration without connecting.
 * @returns validation result with errors and warnings.
 */
async validateConfig(): Promise<ConfigValidationResult>

/**
 * List processes running on the remote host.
 * @param options - optional filter options.
 * @returns array of process information.
 */
async listProcesses(options: { user?: string; name?: string } = {}): Promise<NativeProcessInfo[]>

/**
 * Kill a process on the remote host.
 * @param pid - process ID to kill.
 * @param signal - signal to send (default: SIGTERM).
 */
async killProcess(pid: number, signal: NativeExecSignal = 'SIGTERM'): Promise<void>

/**
 * Get system information from the remote host.
 * @returns system information including hostname, OS, memory, disk, etc.
 */
async getSystemInfo(): Promise<NativeSystemInfo>
```

Source: [`packages/ssh/ssh-native/src/index.ts`](../../packages/ssh/ssh-native/src/index.ts)
<!-- END GENERATED cordis-surface -->

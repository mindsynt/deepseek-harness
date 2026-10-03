# SSH

[English](ssh.md) | 中文

[SSH 提供方家族](../../packages/ssh/README.zh.md) 通过部署方持有的 OpenSSH 连接提供一个远端文件系统／进程环境。Harness、模型传输及 Session 存储留在主机。该家族实现既有文件系统、子进程及沙箱 API，不引入 SSH 专用模型工具。

## 架构

SSH 提供方家族使用**原生 SSH**——不需要远端辅助进程。文件系统操作使用 SFTP 子系统，进程执行使用 SSH exec 通道。远端主机只需要一个 OpenSSH 服务器；远端机器无需 Node.js 运行时、tar 或 GNU coreutils。

## 执行坐标

文件系统身份、可执行文件查找、进程 cwd、沙箱工作区根目录及语言服务器文件 URL 都指向 SSH 主机。提供方在文件实际存在的位置规范化路径，保留文件系统对 `symlink/..` 的解释。策略解析器保留执行环境中的绝对路径写法，不尝试在 Harness 主机上解析远端路径。

`processPath()` 提供配套子进程提供方可用的路径。SSH 的 `processPathFromHostPath()` 仍不可用，因此 [`NodePtcRuntime`](../../packages/ptc-runtime/ptc-runtime-node/README.zh.md) 需要一个显式安装并经过摘要验证的远端引导程序。

## 传输与信任

文件系统操作通过独立 SSH 通道使用 SFTP 子系统。进程执行使用 SSH exec 通道，每条通道拥有自己的通道窗口。交互式终端通过 SSH exec 通道的 PTY 请求工作。

SSH 认证由主机上的 `ssh2` 库处理。host key 校验通过凭证服务使用 OpenSSH 标准的 `known_hosts` 机制。每条连接相互独立；一条连接失效会使该连接上的全部活动操作失效。

## 进程生命周期与取消

进程通过 SSH exec 通道启动。`done` 报告退出码、stdout 与 stderr。`wait()` 观察进程直到其退出。`write()` 向进程 stdin 发送数据。`resize()` 调整终端会话的 PTY 尺寸。

SSH 失效会使待处理操作失效。客户端如实报告未确认的结果，绝不通过重连重放可能已执行的操作。

## 组合范围

headless 通过已挂载的文件系统提供方记录和检查 Session cwd。因此远端 FS、Bash、终端、LSP 及 PTC 消费方可以共享这些坐标。假定可访问主机文件系统的 Web 工作区视图需要单独集成；仅替换提供方并不会使这些视图支持远端。

替代方案与验证责任见[决策记录](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md)。

## 连接 API

```ts type-equiv
/** Configuration for the native SSH connection service. */
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
  /** Maximum SFTP read size (default: 64MB). */
  maxSftpReadBytes?: number
  /** Maximum exec output size (default: 64MB). */
  maxExecOutputBytes?: number
  /** Auto-reconnect configuration. */
  reconnect?: {
    /** Enable automatic reconnection (default: false). */
    enabled?: boolean
    /** Maximum number of reconnection attempts (default: 3). */
    maxAttempts?: number
    /** Delay between reconnection attempts in milliseconds (default: 1000). */
    delayMs?: number
    /** Exponential backoff multiplier for reconnection delay (default: 2). */
    backoffMultiplier?: number
  }
  /** Enable SSH compression (default: false). */
  compression?: {
    /** Enable compression. */
    enabled: boolean
    /** Compression algorithm (default: 'zlib'). */
    algorithm?: 'zlib'
  }
  /** SSH proxy/jump host configuration. */
  proxy?: {
    /** Proxy host address. */
    host: string
    /** Proxy port (default: 22). */
    port?: number
    /** Proxy username. */
    username: string
    /** Proxy private key. */
    privateKey?: string
    /** Proxy password. */
    password?: string
  }
}
```

```ts public-api
/** Native SSH connection owner; one connection per service instance. */
declare class SshNativeConnection extends Service {
  static Config: typeof SshNativeConfigSchema;
  /** Resolves when the connection and SFTP subsystem are ready. */
  readonly ready: Promise<void>;
  constructor(ctx: Context, config: SshNativeConfig);
  /** Hold plugin readiness until the connection is established. */
  async [Service.init](): Promise<void>;
  /** The underlying ssh2 Client, available after readiness. */
  get clientConnection(): Client;
  /** The SFTP client, available after readiness. */
  get sftpClient(): SFTPWrapper;
  /** Whether the connection is currently established. */
  get isConnected(): boolean;
  /** Connection health status. */
  get healthStatus(): 'healthy' | 'degraded' | 'disconnected';
  /**
     * Dispose the connection and all running operations.
     */
  async dispose(): Promise<void>;
  /**
     * Get file stat information.
     * @param path - absolute remote path.
     * @returns stat information or undefined if not found.
     */
  async sftpStat(path: string): Promise<NativeSftpStat | undefined>;
  /**
     * Get file stat information without following symlinks.
     * @param path - absolute remote path.
     * @returns stat information or undefined if not found.
     */
  async sftpLstat(path: string): Promise<NativeSftpStat | undefined>;
  /**
     * Read an entire file.
     * @param path - absolute remote path.
     * @returns the file contents.
     */
  async sftpRead(path: string): Promise<Buffer>;
  /**
     * Read a byte range from a file.
     * @param path - absolute remote path.
     * @param offset - byte offset to start reading.
     * @param length - number of bytes to read.
     * @returns the file contents at the specified range.
     */
  async sftpReadRange(path: string, offset: number, length: number): Promise<Buffer>;
  /**
     * Write a file.
     * @param path - absolute remote path.
     * @param data - file contents.
     */
  async sftpWrite(path: string, data: Buffer): Promise<void>;
  /**
     * Create a directory.
     * @param path - absolute remote path.
     * @param recursive - create parent directories.
     */
  async sftpMkdir(path: string, recursive: boolean = false): Promise<void>;
  /**
     * List directory entries.
     * @param path - absolute remote path.
     * @returns directory entries.
     */
  async sftpReaddir(path: string): Promise<NativeSftpEntry[]>;
  /**
     * Resolve a path to its canonical form.
     * @param path - remote path to resolve.
     * @returns the canonical absolute path.
     */
  async sftpRealpath(path: string): Promise<string>;
  /**
     * Remove a file.
     * @param path - absolute remote path.
     */
  async sftpUnlink(path: string): Promise<void>;
  /**
     * Change file permissions.
     * @param path - absolute remote path.
     * @param mode - permission mode (e.g., 'u+rw', 'g+r').
     */
  async sftpChmod(path: string, mode: string): Promise<void>;
  /**
     * Change file ownership.
     * @param path - absolute remote path.
     * @param uid - user id.
     * @param gid - group id.
     */
  async sftpChown(path: string, uid: number, gid: number): Promise<void>;
  /**
     * Create a symbolic link.
     * @param target - target path.
     * @param linkpath - link path.
     */
  async sftpSymlink(target: string, linkpath: string): Promise<void>;
  /**
     * Rename or move a file.
     * @param oldPath - original path.
     * @param newPath - new path.
     */
  async sftpRename(oldPath: string, newPath: string): Promise<void>;
  /**
     * Read a symbolic link.
     * @param path - link path.
     * @returns the target path.
     */
  async sftpReadlink(path: string): Promise<string>;
  /**
     * Copy a file.
     * @param source - source path.
     * @param destination - destination path.
     */
  async sftpCopy(source: string, destination: string): Promise<void>;
  /**
     * Find files matching a pattern.
     * @param path - base path.
     * @param pattern - glob pattern.
     * @returns matching paths.
     */
  async sftpFind(path: string, pattern: string): Promise<string[]>;
  /**
     * Spawn a command on the remote host.
     * @param command - the command to execute.
     * @param options - execution options.
     * @returns a handle to the running process.
     */
  async exec(command: string, options: NativeExecOptions = {}): Promise<NativeExecHandle>;
  /**
     * Resolve an executable on the remote host.
     * @param command - command name to resolve.
     * @returns the absolute path, or undefined if not found.
     */
  async resolveExecutable(command: string): Promise<string | undefined>;
  /**
     * Execute multiple SFTP operations in a batch.
     * @param operations - array of SFTP operations to execute.
     * @returns results for each operation.
     */
  async sftpBatch(operations: NativeSftpBatchOperation[]): Promise<NativeSftpBatchResult[]>;
  /**
     * Create a streaming reader for a file.
     * @param path - absolute remote path.
     * @param options - read options (start offset, chunk size).
     * @returns a streaming reader.
     */
  async sftpReadStream(
      path: string,
      options: { start?: number; chunkSize?: number } = {},
    ): Promise<NativeSftpReadStream>;
  /**
     * Get the terminal environment on the remote host.
     * @returns shell path and arguments.
     */
  async terminalEnvironment(): Promise<{ shellPath: string; shellArgs: string[] }>;
  /**
     * Validate the configuration without connecting.
     * @returns validation result with errors and warnings.
     */
  async validateConfig(): Promise<ConfigValidationResult>;
  /**
     * List processes running on the remote host.
     * @param options - optional filter options.
     * @returns array of process information.
     */
  async listProcesses(options: { user?: string; name?: string } = {}): Promise<NativeProcessInfo[]>;
  /**
     * Kill a process on the remote host.
     * @param pid - process ID to kill.
     * @param signal - signal to send (default: SIGTERM).
     */
  async killProcess(pid: number, signal: NativeExecSignal = 'SIGTERM'): Promise<void>;
  /**
     * Get system information from the remote host.
     * @returns system information including hostname, OS, memory, disk, etc.
     */
  async getSystemInfo(): Promise<NativeSystemInfo>;
  /**
     * Get connection metrics.
     * @returns connection statistics.
     */
  get metrics(): ConnectionMetrics;
  /**
     * Create a persistent session for executing multiple commands with shared state.
     * @param options - session options (cwd, env, pty).
     * @returns a session handle.
     */
  async createSession(options: NativeSessionOptions = {}): Promise<NativeSessionHandle>;
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhostscontroller--hostscontroller"></a>

### `ctx.hostsController` — `HostsController`

Host service backing the generated `ctx.remote.hosts` namespace.

Reads and writes report through `RemoteError` codes: `hosts/unknown-host` when no stored login exists, `hosts/already-exists` when an id is taken, `hosts/add-failed` when adding failed and the message must say what happened to the partial state.

```ts cordis-catalog
/**
 * Read every registered host: its durable record plus whether this process
 * currently holds an open execution world for it.
 * @returns every persisted record in id order, each with its open state.
 */
@Remote('list') list(): RemoteHostsListValue

/**
 * Store entered login material, persist the host record, and open the
 * host's execution world.
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
 * The check always runs through a freshly materialized identity, which is
 * removed again when it finishes. A native execution world opens straight
 * from the stored login and keeps no generated configuration of its own, so
 * there is no identity to borrow: the check never closes the world it
 * checks, never writes a stored login, and never returns one.
 * @param request - identity of the host to check.
 * @returns the checked endpoint and the host keys its `known_hosts` records.
 * @throws RemoteError when no stored login exists.
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
 * @param spec - resolved connection coordinates of the host.
 * @returns the open handle.
 * @throws when the id is already open, or when the composition fails to provide a world.
 */
async open(spec: NativeRemoteHostSpec): Promise<RemoteHostHandle>

/**
 * Refused in the native SSH composition: it installs no helper artifact, so a
 * declared entry has nothing to install. Hosts open from their stored login
 * through {@link open}.
 * @param _request - host, remote root, workspace and artifact.
 * @returns Never; the call always rejects.
 * @throws always, naming the unsupported path and the one that replaces it.
 */
async provision(_request: RemoteHostProvisionRequest): Promise<RemoteHostHandle>

/**
 * Refused in the native SSH composition: helper installation is gone. Open the
 * realm with {@link open} after storing the login, and persist its record with
 * {@link save} so it survives a restart.
 * @param _request - identity, login material, remote root, workspace and artifact.
 * @returns Never; the call always rejects.
 * @throws always, naming the unsupported path and the one that replaces it.
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
 * Change file permissions.
 * @param path - absolute remote path.
 * @param mode - permission mode (e.g., 'u+rw', 'g+r').
 */
async sftpChmod(path: string, mode: string): Promise<void>

/**
 * Change file ownership.
 * @param path - absolute remote path.
 * @param uid - user id.
 * @param gid - group id.
 */
async sftpChown(path: string, uid: number, gid: number): Promise<void>

/**
 * Create a symbolic link.
 * @param target - target path.
 * @param linkpath - link path.
 */
async sftpSymlink(target: string, linkpath: string): Promise<void>

/**
 * Rename or move a file.
 * @param oldPath - original path.
 * @param newPath - new path.
 */
async sftpRename(oldPath: string, newPath: string): Promise<void>

/**
 * Read a symbolic link.
 * @param path - link path.
 * @returns the target path.
 */
async sftpReadlink(path: string): Promise<string>

/**
 * Copy a file.
 * @param source - source path.
 * @param destination - destination path.
 */
async sftpCopy(source: string, destination: string): Promise<void>

/**
 * Find files matching a pattern.
 * @param path - base path.
 * @param pattern - glob pattern.
 * @returns matching paths.
 */
async sftpFind(path: string, pattern: string): Promise<string[]>

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

/**
 * Create a persistent session for executing multiple commands with shared state.
 * @param options - session options (cwd, env, pty).
 * @returns a session handle.
 */
async createSession(options: NativeSessionOptions = {}): Promise<NativeSessionHandle>
```

Source: [`packages/ssh/ssh-native/src/index.ts`](../../packages/ssh/ssh-native/src/index.ts)
<!-- END GENERATED cordis-surface -->

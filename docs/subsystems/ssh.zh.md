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

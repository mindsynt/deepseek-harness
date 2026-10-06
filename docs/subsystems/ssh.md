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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

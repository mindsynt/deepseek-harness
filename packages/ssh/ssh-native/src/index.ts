/**
 * Native SSH connection service over ssh2.
 *
 * Provides SFTP and exec operations directly over SSH without a remote helper
 * daemon. The remote host needs only an OpenSSH server (no Node.js, no tar,
 * no coreutils beyond what OpenSSH requires).
 *
 * @module @deepseek-ai/dsh-ssh-native
 */

import { readFileSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Client, type SFTPWrapper } from 'ssh2'
import type {
  ConfigValidationResult,
  ConnectionMetrics,
  NativeExecHandle,
  NativeExecOptions,
  NativeExecSignal,
  NativeProcessInfo,
  NativeSftpBatchOperation,
  NativeSftpBatchResult,
  NativeSftpEntry,
  NativeSftpReadStream,
  NativeSftpStat,
  NativeSessionHandle,
  NativeSessionOptions,
  NativeSystemInfo,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sshNative: SshNativeConnection
  }
}

/** Default connection timeout in milliseconds. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
/** Default keepalive interval in milliseconds. */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000
/** Default keepalive count max. */
const DEFAULT_KEEPALIVE_COUNT_MAX = 3
/** Default maximum SFTP read bytes (64 MB). */
const DEFAULT_MAX_SFTP_READ_BYTES = 64 * 1024 * 1024
/** Default maximum exec output bytes (64 MB). */
const DEFAULT_MAX_EXEC_OUTPUT_BYTES = 64 * 1024 * 1024

/** Interface configuration for the native SSH connection service. */
export interface SshNativeConfig {
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
  /** Local identity file path. */
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

/** Runtime configuration schema for the native SSH connection service. */
export const SshNativeConfigSchema = schema.object({
  host: schema.string().required(),
  port: schema.number().default(22),
  username: schema.string().required(),
  privateKey: schema.string(),
  password: schema.string(),
  identityFile: schema.string(),
  knownHostsFile: schema.string(),
  connectTimeout: schema.number().default(DEFAULT_CONNECT_TIMEOUT_MS),
  keepaliveInterval: schema.number().default(DEFAULT_KEEPALIVE_INTERVAL_MS),
  keepaliveCountMax: schema.number().default(DEFAULT_KEEPALIVE_COUNT_MAX),
  strictHostKeyChecking: schema.string().default('accept-new'),
  maxSftpReadBytes: schema.number().default(DEFAULT_MAX_SFTP_READ_BYTES),
  maxExecOutputBytes: schema.number().default(DEFAULT_MAX_EXEC_OUTPUT_BYTES),
})

/** Zod runtime validation schema. */
const runtimeConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(22),
  username: z.string().min(1),
  privateKey: z.string().optional(),
  password: z.string().optional(),
  identityFile: z.string().optional(),
  knownHostsFile: z.string().optional(),
  connectTimeout: z.number().int().positive().max(2_147_483_647).default(DEFAULT_CONNECT_TIMEOUT_MS),
  keepaliveInterval: z.number().int().positive().max(600_000).default(DEFAULT_KEEPALIVE_INTERVAL_MS),
  keepaliveCountMax: z.number().int().positive().max(100).default(DEFAULT_KEEPALIVE_COUNT_MAX),
  strictHostKeyChecking: z.enum(['yes', 'no', 'accept-new']).default('accept-new'),
  maxSftpReadBytes: z.number().int().positive().max(1024 * 1024 * 1024).default(DEFAULT_MAX_SFTP_READ_BYTES),
  maxExecOutputBytes: z.number().int().positive().max(1024 * 1024 * 1024).default(DEFAULT_MAX_EXEC_OUTPUT_BYTES),
  reconnect: z.object({
    enabled: z.boolean().optional(),
    maxAttempts: z.number().int().positive().default(3),
    delayMs: z.number().int().positive().default(1000),
    backoffMultiplier: z.number().positive().default(2),
  }).optional(),
  compression: z.object({
    enabled: z.boolean().default(false),
    algorithm: z.enum(['zlib']).default('zlib'),
  }).optional(),
  proxy: z.object({
    host: z.string().min(1),
    port: z.number().int().positive().default(22),
    username: z.string().min(1),
    privateKey: z.string().optional(),
    password: z.string().optional(),
  }).optional(),
})

/** Native SSH connection owner; one connection per service instance. */
export class SshNativeConnection extends Service {
  static Config: typeof SshNativeConfigSchema = SshNativeConfigSchema

  /** Resolves when the connection and SFTP subsystem are ready. */
  readonly ready: Promise<void>
  private client: Client | undefined
  private sftp: SFTPWrapper | undefined
  private disposed = false
  private connected = false
  private connectedTimestamp = 0
  private reconnectAttempts = 0
  private readonly execHandles = new Set<NativeExecHandle>()
  private readonly config: z.infer<typeof runtimeConfigSchema>
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, config: SshNativeConfig) {
    super(ctx, 'sshNative')
    this.config = runtimeConfigSchema.parse(config)
    this.ready = this.connect()
    void this.ready.catch(() => { /* connection failure; operations will reject */ })
    ctx.effect(() => () => this.dispose())
  }

  /** Hold plugin readiness until the connection is established. */
  async [Service.init](): Promise<void> {
    await this.ready
  }

  /** The underlying ssh2 Client, available after readiness. */
  get clientConnection(): Client {
    if (this.client === undefined) throw new Error('ssh-native: connection is not established')
    return this.client
  }

  /** The SFTP client, available after readiness. */
  get sftpClient(): SFTPWrapper {
    if (this.sftp === undefined) throw new Error('ssh-native: SFTP subsystem is not available')
    return this.sftp
  }

  /** Whether the connection is currently established. */
  get isConnected(): boolean {
    return this.connected && this.disposed === false
  }

  /** Connection health status. */
  get healthStatus(): 'healthy' | 'degraded' | 'disconnected' {
    if (this.disposed || !this.connected) return 'disconnected'
    return 'healthy'
  }

  /**
   * Establish the SSH connection and SFTP subsystem.
   * @returns a promise that resolves when ready.
   */
  private async connect(): Promise<void> {
    if (this.disposed) return
    const client = new Client()
    this.client = client

    const connectPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`ssh-native: connection to ${this.config.host}:${this.config.port} timed out`))
        client.end()
      }, this.config.connectTimeout)
      timeout.unref()

      client.on('ready', () => {
        clearTimeout(timeout)
        this.connected = true
        this.connectedTimestamp = Date.now()
        resolve()
      })

      client.on('error', (error: Error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })

    const connectConfig: Record<string, unknown> = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      readyTimeout: this.config.connectTimeout,
      keepaliveInterval: this.config.keepaliveInterval,
      keepaliveCountMax: this.config.keepaliveCountMax,
      strictHostKeyChecking: this.config.strictHostKeyChecking,
    }

    if (this.config.privateKey !== undefined) {
      connectConfig.privateKey = this.config.privateKey
    } else if (this.config.password !== undefined) {
      connectConfig.password = this.config.password
    }

    if (this.config.identityFile !== undefined) {
      connectConfig.privateKey = readFileSync(this.config.identityFile)
    }

    client.connect(connectConfig)
    await connectPromise

    // Open the SFTP subsystem.
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, sftpClient) => {
        if (error) reject(error)
        else resolve(sftpClient)
      })
    })

    this.sftp = sftp

    // Handle connection loss.
    client.on('close', () => {
      if (this.disposed) return
      if (this.config.reconnect?.enabled === true && this.reconnectAttempts < (this.config.reconnect.maxAttempts ?? 3)) {
        this.reconnect()
      } else {
        void this.dispose()
      }
    })
  }

  /**
   * Reconnect the SSH connection after a disconnection.
   */
  private async reconnect(): Promise<void> {
    const maxAttempts = this.config.reconnect?.maxAttempts ?? 3
    const delayMs = this.config.reconnect?.delayMs ?? 1000
    const backoffMultiplier = this.config.reconnect?.backoffMultiplier ?? 2

    while (this.reconnectAttempts < maxAttempts && !this.disposed) {
      const delay = delayMs * Math.pow(backoffMultiplier, this.reconnectAttempts)
      await new Promise(resolve => setTimeout(resolve, delay))

      if (this.disposed) return

      this.reconnectAttempts++

      try {
        await this.connect()
        this.reconnectAttempts = 0
        return
      } catch {
        // Continue retrying
      }
    }

    // All reconnection attempts failed, dispose.
    void this.dispose()
  }

  /**
   * Dispose the connection and all running operations.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.connected = false
    this.lifetime.abort(new Error('ssh-native: connection disposed'))

    // Terminate all exec handles.
    for (const handle of this.execHandles) {
      await handle.terminate().catch(() => { /* already terminated */ })
    }
    this.execHandles.clear()

    // Close SFTP.
    if (this.sftp !== undefined) {
      try {
        this.sftp.end()
      } catch {
        // already closed
      }
      this.sftp = undefined
    }

    // End the client.
    if (this.client !== undefined) {
      try {
        this.client.end()
      } catch {
        // already ended
      }
      this.client = undefined
    }
  }

  /**
   * Get file stat information.
   * @param path - absolute remote path.
   * @returns stat information or undefined if not found.
   */
  async sftpStat(path: string): Promise<NativeSftpStat | undefined> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    return await new Promise((resolve, reject) => {
      this.sftpClient.stat(path, (error, stats) => {
        if (error) {
          if (isNotFound(error)) resolve(undefined)
          else reject(error)
          return
        }
        resolve(toNativeSftpStat(stats))
      })
    })
  }

  /**
   * Get file stat information without following symlinks.
   * @param path - absolute remote path.
   * @returns stat information or undefined if not found.
   */
  async sftpLstat(path: string): Promise<NativeSftpStat | undefined> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    return await new Promise((resolve, reject) => {
      this.sftpClient.lstat(path, (error, stats) => {
        if (error) {
          if (isNotFound(error)) resolve(undefined)
          else reject(error)
          return
        }
        resolve(toNativeSftpStat(stats))
      })
    })
  }

  /**
   * Read an entire file.
   * @param path - absolute remote path.
   * @returns the file contents.
   */
  async sftpRead(path: string): Promise<Buffer> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    const stat = await this.sftpStat(path)
    if (stat === undefined) throw new Error(`ssh-native: file not found: ${path}`)
    if (stat.size > this.config.maxSftpReadBytes) {
      throw new Error(`ssh-native: file too large: ${stat.size} bytes exceeds ${this.config.maxSftpReadBytes}`)
    }
    return await new Promise<Buffer>((resolve, reject) => {
      this.sftpClient.readFile(path, (error, data) => {
        if (error) reject(error)
        else resolve(data)
      })
    })
  }

  /**
   * Read a byte range from a file.
   * @param path - absolute remote path.
   * @param offset - byte offset to start reading.
   * @param length - number of bytes to read.
   * @returns the file contents at the specified range.
   */
  async sftpReadRange(path: string, offset: number, length: number): Promise<Buffer> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    return await new Promise<Buffer>((resolve, reject) => {
      const stream = this.sftpClient.createReadStream(path, {
        start: offset,
        end: offset + length - 1,
      })
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', (error: Error) => reject(error))
    })
  }

  /**
   * Write a file.
   * @param path - absolute remote path.
   * @param data - file contents.
   */
  async sftpWrite(path: string, data: Buffer): Promise<void> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    await new Promise<void>((resolve, reject) => {
      this.sftpClient.writeFile(path, data, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * Create a directory.
   * @param path - absolute remote path.
   * @param recursive - create parent directories.
   */
  async sftpMkdir(path: string, recursive: boolean = false): Promise<void> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    if (recursive) {
      // ssh2 doesn't have mkdir -p, so we create parent directories manually.
      const parts = path.split('/')
      for (let i = 2; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        try {
          await new Promise<void>((resolve, reject) => {
            this.sftpClient.mkdir(dir, (error) => {
              if (error) reject(error)
              else resolve()
            })
          })
        } catch (error) {
          if (!isExists(error)) throw error
        }
      }
    } else {
      await new Promise<void>((resolve, reject) => {
        this.sftpClient.mkdir(path, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }

  /**
   * List directory entries.
   * @param path - absolute remote path.
   * @returns directory entries.
   */
  async sftpReaddir(path: string): Promise<NativeSftpEntry[]> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    return await new Promise((resolve, reject) => {
      this.sftpClient.readdir(path, (error, list) => {
        if (error) reject(error)
        else resolve(list.map(entry => ({
          name: entry.filename,
          attrs: toNativeSftpStat(entry.attrs),
        })))
      })
    })
  }

  /**
   * Resolve a path to its canonical form.
   * @param path - remote path to resolve.
   * @returns the canonical absolute path.
   */
  async sftpRealpath(path: string): Promise<string> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    return await new Promise((resolve, reject) => {
      this.sftpClient.realpath(path, (error, absPath) => {
        if (error) reject(error)
        else resolve(absPath)
      })
    })
  }

  /**
   * Remove a file.
   * @param path - absolute remote path.
   */
  async sftpUnlink(path: string): Promise<void> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    await new Promise<void>((resolve, reject) => {
      this.sftpClient.unlink(path, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * Change file permissions.
   * @param path - absolute remote path.
   * @param mode - permission mode (e.g., 'u+rw', 'g+r').
   */
  async sftpChmod(path: string, mode: string): Promise<void> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    await new Promise<void>((resolve, reject) => {
      this.sftpClient.chmod(path, mode, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * Change file ownership.
   * @param path - absolute remote path.
   * @param uid - user id.
   * @param gid - group id.
   */
  async sftpChown(path: string, uid: number, gid: number): Promise<void> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    await new Promise<void>((resolve, reject) => {
      this.sftpClient.chown(path, uid, gid, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * Create a symbolic link.
   * @param target - target path.
   * @param linkpath - link path.
   */
  async sftpSymlink(target: string, linkpath: string): Promise<void> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    await new Promise<void>((resolve, reject) => {
      this.sftpClient.symlink(target, linkpath, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * Rename or move a file.
   * @param oldPath - original path.
   * @param newPath - new path.
   */
  async sftpRename(oldPath: string, newPath: string): Promise<void> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    await new Promise<void>((resolve, reject) => {
      this.sftpClient.rename(oldPath, newPath, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * Read a symbolic link.
   * @param path - link path.
   * @returns the target path.
   */
  async sftpReadlink(path: string): Promise<string> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    return await new Promise((resolve, reject) => {
      this.sftpClient.readlink(path, (error, target) => {
        if (error) reject(error)
        else resolve(target)
      })
    })
  }

  /**
   * Copy a file.
   * @param source - source path.
   * @param destination - destination path.
   */
  async sftpCopy(source: string, destination: string): Promise<void> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    const data = await this.sftpRead(source)
    await this.sftpWrite(destination, data)
  }

  /**
   * Find files matching a pattern.
   * @param path - base path.
   * @param pattern - glob pattern.
   * @returns matching paths.
   */
  async sftpFind(path: string, pattern: string): Promise<string[]> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    const handle = await this.exec(`find ${shellQuote(path)} -name ${shellQuote(pattern)} 2>/dev/null`)
    const { code, stdout } = await handle.wait()
    if (code !== 0) {
      return []
    }
    return stdout.toString('utf8').trim().split('\n').filter(p => p.length > 0)
  }

  /**
   * Spawn a command on the remote host.
   * @param command - the command to execute.
   * @param options - execution options.
   * @returns a handle to the running process.
   */
  async exec(command: string, options: NativeExecOptions = {}): Promise<NativeExecHandle> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')

    const maxOutput = options.maxOutputBytes ?? this.config.maxExecOutputBytes

    // ssh2 doesn't support cwd directly; prepend cd if specified.
    const fullCommand = options.cwd !== undefined ? `cd ${shellQuote(options.cwd)} && ${command}` : command

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let timedOut = false

    const resultPromise = new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      this.clientConnection.exec(fullCommand, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.pty === undefined ? {} : { pty: options.pty }),
      }, (error, execStream) => {
        if (error) {
          reject(error)
          return
        }

        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0

        // Set up timeout if specified.
        if (options.timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            execStream.end()
            resolve({
              code: -1,
              stdout: Buffer.concat(stdoutChunks),
              stderr: Buffer.concat([...stderrChunks, Buffer.from(`\nProcess timed out after ${options.timeoutMs}ms\n`)]),
            })
          }, options.timeoutMs)
          timeoutHandle.unref()
        }

        execStream.on('data', (data: Buffer) => {
          if (stdoutBytes + data.length <= maxOutput) {
            stdoutChunks.push(data)
            stdoutBytes += data.length
          }
        })

        execStream.stderr.on('data', (data: Buffer) => {
          if (stderrBytes + data.length <= maxOutput) {
            stderrChunks.push(data)
            stderrBytes += data.length
          }
        })

        execStream.on('close', (code: number | undefined) => {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle)
          }
          if (!timedOut) {
            resolve({
              code: code ?? 0,
              stdout: Buffer.concat(stdoutChunks),
              stderr: Buffer.concat(stderrChunks),
            })
          }
        })

        execStream.on('error', (error: Error) => {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle)
          }
          if (!timedOut) {
            reject(error)
          }
        })

        // Store the stream reference for write/resize/terminate/signal operations.
        streamRef = execStream
      })
    })

    // Use a variable to capture the stream reference for the handle methods.
    let streamRef: {
      write(data: string, callback?: (error?: Error | null) => void): void
      end(): void
      setWindow?(cols: number, rows: number, width: number, height: number): void
      sendSignal?(signal: string): void
    } | undefined

    const handle: NativeExecHandle = {
      done: resultPromise,
      wait: async () => {
        return await resultPromise
      },
      terminate: async () => {
        if (streamRef !== undefined) {
          streamRef.end()
        }
      },
      write: async (data: string) => {
        const stream = streamRef
        if (stream === undefined) return false
        return new Promise((resolve) => {
          stream.write(data, (error) => {
            resolve(error === undefined || error === null)
          })
        })
      },
      resize: async (cols: number, rows: number) => {
        if (streamRef !== undefined && typeof streamRef.setWindow === 'function') {
          streamRef.setWindow(cols, rows, 0, 0)
        }
      },
      signal: async (signal: NativeExecSignal) => {
        if (streamRef !== undefined && typeof streamRef.sendSignal === 'function') {
          streamRef.sendSignal(signal)
        }
      },
    }

    this.execHandles.add(handle)
    resultPromise.finally(() => {
      this.execHandles.delete(handle)
    })

    return handle
  }

  /**
   * Resolve an executable on the remote host.
   * @param command - command name to resolve.
   * @returns the absolute path, or undefined if not found.
   */
  async resolveExecutable(command: string): Promise<string | undefined> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    try {
      const handle = await this.exec(`command -v ${shellQuote(command)}`)
      const { code, stdout } = await handle.wait()
      if (code === 0 && stdout.length > 0) {
        return stdout.toString('utf8').trim()
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * Execute multiple SFTP operations in a batch.
   * @param operations - array of SFTP operations to execute.
   * @returns results for each operation.
   */
  async sftpBatch(operations: NativeSftpBatchOperation[]): Promise<NativeSftpBatchResult[]> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')

    const results: NativeSftpBatchResult[] = []

    for (const op of operations) {
      try {
        switch (op.type) {
          case 'stat': {
            const stat = await this.sftpStat(op.path)
            results.push({ success: true, data: stat })
            break
          }
          case 'lstat': {
            const stat = await this.sftpLstat(op.path)
            results.push({ success: true, data: stat })
            break
          }
          case 'read': {
            if (op.offset !== undefined && op.length !== undefined) {
              const data = await this.sftpReadRange(op.path, op.offset, op.length)
              results.push({ success: true, data })
            } else {
              const data = await this.sftpRead(op.path)
              results.push({ success: true, data })
            }
            break
          }
          case 'write': {
            if (op.data === undefined) throw new Error('write operation requires data')
            await this.sftpWrite(op.path, op.data)
            results.push({ success: true })
            break
          }
          case 'mkdir': {
            await this.sftpMkdir(op.path)
            results.push({ success: true })
            break
          }
          case 'readdir': {
            const entries = await this.sftpReaddir(op.path)
            results.push({ success: true, data: entries })
            break
          }
          case 'realpath': {
            const path = await this.sftpRealpath(op.path)
            results.push({ success: true, data: path })
            break
          }
          case 'unlink': {
            await this.sftpUnlink(op.path)
            results.push({ success: true })
            break
          }
        }
      } catch (error) {
        results.push({ success: false, error: error instanceof Error ? error.message : String(error) })
      }
    }

    return results
  }

  /**
   * Create a streaming reader for a file.
   * @param path - absolute remote path.
   * @param options - read options (start offset, chunk size).
   * @returns a streaming reader.
   */
  async sftpReadStream(
    path: string,
    options: { start?: number; chunkSize?: number } = {},
  ): Promise<NativeSftpReadStream> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')

    const stat = await this.sftpStat(path)
    if (stat === undefined) throw new Error(`ssh-native: file not found: ${path}`)

    const chunkSize = options.chunkSize ?? 64 * 1024 // 64KB default
    const start = options.start ?? 0
    let offset = start
    let done = false
    let stream: import('stream').Readable | undefined

    const readNext = async (): Promise<Buffer | null> => {
      if (done || offset >= stat.size) {
        done = true
        return null
      }

      const end = Math.min(offset + chunkSize - 1, stat.size - 1)
      try {
        const data = await this.sftpReadRange(path, offset, end - offset + 1)
        offset += data.length
        return data
      } catch {
        done = true
        return null
      }
    }

    return {
      read: readNext,
      isDone: () => done,
      close: async () => {
        done = true
        if (stream !== undefined) {
          stream.destroy()
        }
      },
    }
  }

  /**
   * Get the terminal environment on the remote host.
   * @returns shell path and arguments.
   */
  async terminalEnvironment(): Promise<{ shellPath: string; shellArgs: string[] }> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')
    try {
      const handle = await this.exec('echo "$SHELL"')
      const { code, stdout } = await handle.wait()
      if (code === 0 && stdout.length > 0) {
        const shellPath = stdout.toString('utf8').trim()
        return { shellPath, shellArgs: ['-l', '-i'] }
      }
    } catch {
      // Fall through to defaults.
    }
    return { shellPath: '/bin/bash', shellArgs: ['-l', '-i'] }
  }

  /**
   * Validate the configuration without connecting.
   * @returns validation result with errors and warnings.
   */
  async validateConfig(): Promise<ConfigValidationResult> {
    const errors: string[] = []
    const warnings: string[] = []

    if (!this.config.host || this.config.host.trim() === '') {
      errors.push('host is required')
    }

    if (!this.config.username || this.config.username.trim() === '') {
      errors.push('username is required')
    }

    if (this.config.privateKey && this.config.password) {
      errors.push('privateKey and password are mutually exclusive')
    }

    if (!this.config.privateKey && !this.config.password && !this.config.identityFile) {
      warnings.push('no authentication method specified; will attempt agent or default keys')
    }

    if (this.config.port !== undefined && (this.config.port < 1 || this.config.port > 65535)) {
      errors.push('port must be between 1 and 65535')
    }

    if (this.config.connectTimeout !== undefined && this.config.connectTimeout < 1000) {
      warnings.push('connectTimeout is very short; connection may time out')
    }

    if (this.config.keepaliveInterval !== undefined && this.config.keepaliveInterval < 1000) {
      warnings.push('keepaliveInterval is very short; may cause excessive network traffic')
    }

    if (this.config.strictHostKeyChecking === 'no') {
      warnings.push('strictHostKeyChecking is disabled; vulnerable to MITM attacks')
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * List processes running on the remote host.
   * @param options - optional filter options.
   * @returns array of process information.
   */
  async listProcesses(options: { user?: string; name?: string } = {}): Promise<NativeProcessInfo[]> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')

    let cmd = 'ps -eo pid,comm,args,%cpu,rss,user,state --no-headers'
    if (options.user) {
      cmd += ` | grep "^.*${shellQuote(options.user)}"`
    }
    if (options.name) {
      cmd += ` | grep "${shellQuote(options.name)}"`
    }

    const handle = await this.exec(cmd)
    const { code, stdout } = await handle.wait()
    if (code !== 0) {
      return []
    }

    const lines = stdout.toString('utf8').trim().split('\n')
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/)
      return {
        pid: parseInt(parts[0] ?? '0', 10),
        name: parts[1] ?? '',
        command: parts.slice(2, -4).join(' '),
        cpu: parseFloat(parts[parts.length - 4] ?? '0') || 0,
        memory: (parseInt(parts[parts.length - 3] ?? '0', 10) || 0) * 1024,
        user: parts[parts.length - 2] ?? '',
        state: (parts[parts.length - 1] ?? '') === 'R' ? 'running'
          : (parts[parts.length - 1] ?? '') === 'S' ? 'sleeping'
            : (parts[parts.length - 1] ?? '') === 'T' ? 'stopped'
              : (parts[parts.length - 1] ?? '') === 'Z' ? 'zombie'
                : 'sleeping',
      }
    })
  }

  /**
   * Kill a process on the remote host.
   * @param pid - process ID to kill.
   * @param signal - signal to send (default: SIGTERM).
   */
  async killProcess(pid: number, signal: NativeExecSignal = 'SIGTERM'): Promise<void> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')

    const handle = await this.exec(`kill -${signal.replace('SIG', '')} ${pid}`)
    const { code } = await handle.wait()
    if (code !== 0) {
      throw new Error(`ssh-native: failed to kill process ${pid}`)
    }
  }

  /**
   * Get system information from the remote host.
   * @returns system information including hostname, OS, memory, disk, etc.
   */
  async getSystemInfo(): Promise<NativeSystemInfo> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')

    const hostnameResult = await this.exec('hostname')
    const osResult = await this.exec('uname -s -r')
    const uptimeResult = await this.exec('cat /proc/uptime')
    const loadavgResult = await this.exec('cat /proc/loadavg')
    const memResult = await this.exec('cat /proc/meminfo')
    const dfResult = await this.exec('df -B1')

    const [hostname, osKernel, uptime, loadavg, meminfo, df] = await Promise.all([
      hostnameResult.wait(),
      osResult.wait(),
      uptimeResult.wait(),
      loadavgResult.wait(),
      memResult.wait(),
      dfResult.wait(),
    ])

    const memlines = meminfo.stdout.toString('utf8').split('\n')
    const memTotal = memlines.find(l => l.startsWith('MemTotal:'))?.match(/(\d+)/)?.[1] ?? '0'
    const memFree = memlines.find(l => l.startsWith('MemFree:'))?.match(/(\d+)/)?.[1] ?? '0'
    const memAvailable = memlines.find(l => l.startsWith('MemAvailable:'))?.match(/(\d+)/)?.[1] ?? memFree

    const dfLines = df.stdout.toString('utf8').trim().split('\n').slice(1)
    const disk = dfLines.map((line) => {
      const parts = line.trim().split(/\s+/)
      return {
        mount: parts[5] ?? '/',
        total: parseInt(parts[1] ?? '0', 10),
        used: parseInt(parts[2] ?? '0', 10),
        free: parseInt(parts[3] ?? '0', 10),
      }
    })

    return {
      hostname: hostname.stdout.toString('utf8').trim(),
      os: osKernel.stdout.toString('utf8').trim().split(' ')[0] ?? 'unknown',
      kernel: osKernel.stdout.toString('utf8').trim().split(' ')[1] ?? 'unknown',
      uptime: parseFloat(uptime.stdout.toString('utf8').trim().split(' ')[0] ?? '0'),
      loadavg: loadavg.stdout.toString('utf8').trim().split(' ').slice(0, 3).map(n => parseFloat(n)),
      memory: {
        total: parseInt(memTotal, 10) * 1024,
        free: parseInt(memFree, 10) * 1024,
        available: parseInt(memAvailable, 10) * 1024,
      },
      disk,
    }
  }

  /**
   * Get connection metrics.
   * @returns connection statistics.
   */
  get metrics(): ConnectionMetrics {
    const client = this.client
    if (client === undefined) {
      return {
        connectionTime: 0,
        requestsSent: 0,
        requestsReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        avgLatency: 0,
      }
    }

    // ssh2 doesn't expose detailed metrics directly, return available info
    return {
      connectionTime: this.connected ? Date.now() - this.connectedTimestamp : 0,
      requestsSent: 0,
      requestsReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      avgLatency: 0,
    }
  }

  /**
   * Create a persistent session for executing multiple commands with shared state.
   * @param options - session options (cwd, env, pty).
   * @returns a session handle.
   */
  async createSession(options: NativeSessionOptions = {}): Promise<NativeSessionHandle> {
    if (this.disposed) throw new Error('ssh-native: connection is disposed')

    let isOpen = true

    const handle: NativeSessionHandle = {
      isOpen,
      async exec(command: string, execOptions?: NativeExecOptions) {
        if (!isOpen) {
          throw new Error('ssh-native: session is closed')
        }
        const mergedOptions: NativeExecOptions = {}
        if (options.cwd !== undefined) mergedOptions.cwd = options.cwd
        if (options.env !== undefined) mergedOptions.env = options.env
        if (options.pty !== undefined) mergedOptions.pty = options.pty
        if (execOptions !== undefined) {
          if (execOptions.cwd !== undefined) mergedOptions.cwd = execOptions.cwd
          if (execOptions.env !== undefined) mergedOptions.env = execOptions.env
          if (execOptions.pty !== undefined) mergedOptions.pty = execOptions.pty
          if (execOptions.maxOutputBytes !== undefined) mergedOptions.maxOutputBytes = execOptions.maxOutputBytes
          if (execOptions.timeoutMs !== undefined) mergedOptions.timeoutMs = execOptions.timeoutMs
        }
        return await this.exec(command, mergedOptions)
      },
      async close() {
        isOpen = false
      },
    }

    return handle
  }

}

/** Convert an ssh2 stat object to a NativeSftpStat. */
function toNativeSftpStat(attrs: { size: number; mode: number; uid: number; gid: number; mtime: number; atime: number }): NativeSftpStat {
  return {
    size: attrs.size,
    mode: attrs.mode,
    uid: attrs.uid,
    gid: attrs.gid,
    mtime: attrs.mtime * 1000,
    atime: attrs.atime * 1000,
    isDirectory: () => (attrs.mode & 0o170000) === 0o040000,
    isFile: () => (attrs.mode & 0o170000) === 0o100000,
    isSymbolicLink: () => (attrs.mode & 0o170000) === 0o120000,
  }
}

/** Check if an error indicates a file not found. */
function isNotFound(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes('ENOENT') || error.message.includes('No such file')
  }
  return false
}

/** Check if an error indicates an existing path. */
function isExists(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes('EEXIST')
  }
  return false
}

/** Shell-quote a string for safe inclusion in a shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export default SshNativeConnection

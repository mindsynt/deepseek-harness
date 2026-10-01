/**
 * Types for the native SSH connection service.
 *
 * @module @deepseek-ai/dsh-ssh-native/types
 */

/** Branded id of one native SSH connection. */
export type NativeSshConnectionId = string & { __brand: 'native-ssh-connection-id' }

/** Stat information for a remote file or directory. */
export interface NativeSftpStat {
  /** File size in bytes. */
  size: number
  /** File mode bits. */
  mode: number
  /** Owner uid. */
  uid: number
  /** Group gid. */
  gid: number
  /** Last modification time in milliseconds since epoch. */
  mtime: number
  /** Last access time in milliseconds since epoch. */
  atime: number
  /** Whether this is a directory. */
  isDirectory: () => boolean
  /** Whether this is a regular file. */
  isFile: () => boolean
  /** Whether this is a symbolic link. */
  isSymbolicLink: () => boolean
}

/** Directory entry from a readdir operation. */
export interface NativeSftpEntry {
  /** Entry name (not the full path). */
  name: string
  /** Stat information for this entry. */
  attrs: NativeSftpStat
}

/** Result of a realpath operation. */
export interface NativeSftpRealpath {
  /** The resolved absolute path. */
  path: string
}

/** Batch SFTP operation. */
export interface NativeSftpBatchOperation {
  /** Operation type. */
  type: 'stat' | 'lstat' | 'read' | 'write' | 'mkdir' | 'readdir' | 'realpath' | 'unlink'
  /** Target path. */
  path: string
  /** Data for write operations. */
  data?: Buffer
  /** Offset for read operations. */
  offset?: number
  /** Length for read operations. */
  length?: number
}

/** Result of a batch SFTP operation. */
export interface NativeSftpBatchResult {
  /** Whether the operation succeeded. */
  success: boolean
  /** Operation result data. */
  data?: unknown
  /** Error message if the operation failed. */
  error?: string
}

/** Streaming file reader. */
export interface NativeSftpReadStream {
  /** Read the next chunk of data. */
  read(): Promise<Buffer | null>
  /** Check if the stream is done. */
  isDone(): boolean
  /** Close the stream. */
  close(): Promise<void>
}

/** Configuration for the native SSH connection service. */
export interface Config {
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

/** Configuration validation result. */
export interface ConfigValidationResult {
  /** Whether the configuration is valid. */
  valid: boolean
  /** Error messages for invalid fields. */
  errors: string[]
  /** Warning messages for potentially problematic fields. */
  warnings: string[]
}

/** Process information from the remote host. */
export interface NativeProcessInfo {
  /** Process ID. */
  pid: number
  /** Process name. */
  name: string
  /** Full command line. */
  command: string
  /** CPU usage percentage. */
  cpu: number
  /** Memory usage in bytes. */
  memory: number
  /** User who owns the process. */
  user: string
  /** Process state. */
  state: 'running' | 'sleeping' | 'stopped' | 'zombie'
}

/** Remote system information. */
export interface NativeSystemInfo {
  /** Hostname. */
  hostname: string
  /** Operating system name. */
  os: string
  /** Kernel version. */
  kernel: string
  /** Uptime in seconds. */
  uptime: number
  /** Load average (1min, 5min, 15min). */
  loadavg: number[]
  /** Memory information in bytes. */
  memory: {
    total: number
    free: number
    available: number
  }
  /** Disk partition information. */
  disk: Array<{
    /** Mount point. */
    mount: string
    /** Total space in bytes. */
    total: number
    /** Used space in bytes. */
    used: number
    /** Free space in bytes. */
    free: number
  }>
}

/** Connection metrics. */
export interface ConnectionMetrics {
  /** Connection time in milliseconds. */
  connectionTime: number
  /** Number of requests sent. */
  requestsSent: number
  /** Number of requests received. */
  requestsReceived: number
  /** Bytes sent. */
  bytesSent: number
  /** Bytes received. */
  bytesReceived: number
  /** Average latency in milliseconds. */
  avgLatency: number
}

/** File permission mode. */
export type NativeFileMode = 'r' | 'rw' | 'rwx' | 'u+r' | 'u+rw' | 'g+r' | 'g+rw' | 'o+r' | 'o+rw'

/** Session options for persistent exec sessions. */
export interface NativeSessionOptions {
  /** Working directory. */
  cwd?: string
  /** Environment variables. */
  env?: Record<string, string>
  /** Request a PTY. */
  pty?: boolean | {
    cols?: number
    rows?: number
    term?: string
  }
}

/** Handle to a persistent session. */
export interface NativeSessionHandle {
  /** Execute a command in this session. */
  exec(command: string, options?: NativeExecOptions): Promise<NativeExecHandle>
  /** Close the session. */
  close(): Promise<void>
  /** Whether the session is still open. */
  isOpen: boolean
}

/** Options for an exec spawn. */
export interface NativeExecOptions {
  /** Working directory on the remote host. */
  cwd?: string
  /** Environment variables to set. */
  env?: Record<string, string>
  /** Request a PTY. */
  pty?: boolean | {
    /** Terminal columns. */
    cols?: number
    /** Terminal rows. */
    rows?: number
    /** Terminal type. */
    term?: string
  }
  /** Maximum output bytes before truncation. */
  maxOutputBytes?: number
  /** Timeout in milliseconds. The process will be terminated if it exceeds this duration. */
  timeoutMs?: number
}

/** Signal that can be sent to a process. */
export type NativeExecSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP'

/** A handle to a running exec process. */
export interface NativeExecHandle {
  /** Promise that resolves when the process exits. */
  done: Promise<{ code: number; stdout: Buffer; stderr: Buffer }>
  /** Wait for the process to exit. */
  wait(signal?: AbortSignal): Promise<{ code: number; stdout: Buffer; stderr: Buffer }>
  /** Terminate the process. */
  terminate(): Promise<void>
  /** Write data to the process's stdin. Returns true if the data was accepted. */
  write(data: string): Promise<boolean>
  /** Resize the PTY if one was requested. */
  resize(cols: number, rows: number): Promise<void>
  /** Send a signal to the process. */
  signal(signal: NativeExecSignal): Promise<void>
}

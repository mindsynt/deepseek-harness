/**
 * Type surface of the SSH host-credentials store: one host's entered login
 * material, the controlled OpenSSH identity generated for it, and the service
 * that owns both. Types only — the implementation lives in `./index.ts`.
 *
 * @module @deepseek-ai/dsh-host-credentials/types
 */

/** One host's entered login material. */
export interface RemoteHostLogin {
  /** SSH host name or address. */
  readonly host: string
  /** TCP port, 1 through 65535. */
  readonly port: number
  /** Login user. */
  readonly user: string
  /** Armored private key text; omission leaves authentication to the environment's agent and default keys. */
  readonly privateKey?: string
}

/** One DSH-controlled OpenSSH identity on disk. */
export interface ControlledSshIdentity {
  /** OpenSSH alias every command for this host addresses. */
  readonly alias: string
  /** Absolute path of the generated OpenSSH configuration file. */
  readonly configPath: string
  /** Absolute directory owning every generated file. */
  readonly directory: string
  /** Absolute path of the DSH-controlled `known_hosts` file. */
  readonly knownHostsPath: string
  /** Remove the directory and every generated file; idempotent. */
  dispose(): Promise<void>
}

/** One real SSH endpoint whose host key is being trusted. */
export interface HostKeyEndpoint {
  /** SSH host name or address. */
  readonly host: string
  /** TCP port, 1 through 65535. */
  readonly port: number
}

/** Reads a host's public keys from the network. */
export interface HostKeyScanner {
  /**
   * @param endpoint - host and port to scan.
   * @returns one known_hosts line per key the host publishes.
   */
  scan(endpoint: HostKeyEndpoint): Promise<readonly string[]>
}

/** Entered login material, its controlled identity, and its durable record. */
export interface SshHostCredentials {
  /**
   * Write one host's controlled configuration and identity.
   * @param login - host, port, user and optional private key.
   * @returns the identity whose alias addresses that host.
   */
  materialize(login: RemoteHostLogin): Promise<ControlledSshIdentity>
  /** Store one host's login material so later sessions reuse it without prompting. */
  store(id: string, login: RemoteHostLogin): Promise<void>
  /** The stored login material, or undefined while none is stored. */
  load(id: string): Promise<RemoteHostLogin | undefined>
  /** Remove stored material and any materialized files for that id. */
  forget(id: string): Promise<void>
  /** Append one confirmed host-key line to a materialized identity's `known_hosts`. */
  pinHostKey(identity: ControlledSshIdentity, line: string): Promise<void>
  /**
   * Trust a host's published keys for the first time.
   * @param identity - materialized identity receiving the keys.
   * @param endpoint - real host and port whose keys are scanned.
   */
  trustFirstUse(identity: ControlledSshIdentity, endpoint: HostKeyEndpoint): Promise<void>
}

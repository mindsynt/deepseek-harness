/**
 * Browser-safe request, result, and state-stream vocabulary for the `hosts`
 * Remote namespace this package owns. Types only — the implementation lives in
 * `./index.ts`.
 *
 * Entered login material is declared here rather than imported from the
 * credentials store: `@deepseek-ai/dsh-host-credentials` publishes no
 * client-safe `./types` subpath, so a browser compilation face could not
 * resolve a declaration taken from it.
 *
 * @module @deepseek-ai/dsh-hosts-controller/types
 */

/** One persisted remote host projected for browser consumers. */
export interface RemoteHostRecordView {
  /** Registry identity. */
  readonly id: string
  /** Caller-facing label. */
  readonly label: string
  /** OpenSSH alias the materialized identity addresses; the login itself stays in the credential store. */
  readonly host: string
  /** Absolute remote directory holding the digest-named install directory. */
  readonly root: string
  /** Absolute remote default workspace. */
  readonly workspace: string
  /** Absolute local path of the artifact manifest this host installs from. */
  readonly manifest: string
  /** Lowercase SHA-256 of the helper entry last installed for this host. */
  readonly helperHash: string
}

/** One registered host: its durable record and whether its execution world is open here. */
export interface RemoteHostView {
  readonly record: RemoteHostRecordView
  /** Whether this process currently holds an open execution world for that host. */
  readonly open: boolean
}

/** Every registered host, in id order. */
export interface RemoteHostsListValue {
  readonly items: readonly RemoteHostView[]
}

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

/** One host the browser asks to add and open. */
export interface RemoteHostAddRequest {
  /** Registry identity of the new host; a non-empty token, never a path. */
  readonly id: string
  /** Caller-facing label. */
  readonly label: string
  /** Absolute remote directory receiving the digest-named install directory. */
  readonly root: string
  /** Absolute remote default workspace. */
  readonly workspace: string
  /** Absolute local path of the artifact manifest this host installs from. */
  readonly manifest: string
  /** Entered login material, stored before the helper is installed. */
  readonly login: RemoteHostLogin
}

/** The host one successful add registered and opened. */
export interface RemoteHostAddValue {
  readonly host: RemoteHostView
}

/** One registered host the browser asks to remove. */
export interface RemoteHostRemoveRequest {
  readonly id: string
}

/** Receipt after one host's record and stored login material are removed. */
export interface RemoteHostRemoveValue {
  readonly removed: true
}

/** One registered host whose connection the browser asks to test. */
export interface RemoteHostTestRequest {
  readonly id: string
}

/** What one successful connection check reached. */
export interface RemoteHostTestValue {
  /** SSH host name or address the stored login addresses. */
  readonly host: string
  /** TCP port the stored login addresses. */
  readonly port: number
  /**
   * Every host-key line the DSH-controlled `known_hosts` records for that
   * endpoint after the check. A freshly materialized identity records exactly
   * the keys the endpoint publishes now; an identity an open world already
   * uses also carries the keys trusted for it earlier.
   */
  readonly hostKeys: readonly string[]
}

/** Complete reconnect baseline for the host list. */
export interface RemoteHostsBaseline {
  readonly items: readonly RemoteHostView[]
}

/** One ordered host change after a generation's baseline. */
export type RemoteHostsFollowIncrement =
  | { readonly type: 'upsert'; readonly host: RemoteHostView }
  | { readonly type: 'remove'; readonly hostId: string }

/** Host-list state stream; every generation starts with exactly one baseline. */
export type RemoteHostsFollowFrame =
  | { readonly type: 'baseline'; readonly value: RemoteHostsBaseline }
  | RemoteHostsFollowIncrement

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No stored login material exists for that id. */
    'hosts/unknown-host': { readonly id: string }
    /** A record or an open execution world already uses that id. */
    'hosts/already-exists': { readonly id: string }
    /** Adding the host failed; the message reports what happened to the partial state. */
    'hosts/add-failed': { readonly id: string }
    /** The open host has no DSH-generated login identity a connection check could address. */
    'hosts/no-login-identity': { readonly id: string }
  }
}

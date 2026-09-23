/**
 * Vocabulary for the remote-host registry (`ctx.remoteHosts`): the opaque host id,
 * the connection and helper coordinates one host is opened with, the execution
 * services its isolated realm resolves, and the handle and registry contracts.
 * @module @deepseek-ai/dsh-ssh-host-registry/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { RemoteHostLogin } from '@deepseek-ai/dsh-host-credentials'
import type { RemoteHelperArtifact } from '@deepseek-ai/dsh-helper-installer'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SshConnection } from '@deepseek-ai/dsh-ssh'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { RemoteHostRecord } from './spec.ts'

export type { RemoteHostLogin } from '@deepseek-ai/dsh-host-credentials'
export type { RemoteHelperArtifact } from '@deepseek-ai/dsh-helper-installer'
export type { RemoteHostRecord } from './spec.ts'

/** Branded id of one registered remote host. */
export type RemoteHostId = Branded<'RemoteHostId'>

/** Resolved connection and helper coordinates of one SSH host. */
export interface RemoteHostSpec {
  readonly id: RemoteHostId
  /** Caller-facing label; no defaulting. */
  readonly label: string
  readonly host: string
  /**
   * Absolute local OpenSSH client configuration file passed as `ssh -F`, for a
   * host alias that exists only in a DSH-generated configuration.
   */
  readonly sshConfigFile?: string
  readonly node: string
  readonly helper: string
  readonly helperHash: string
  readonly workspace: string
  readonly bootstrapPath?: string
  readonly bootstrapHash?: string
  readonly requestTimeoutMs?: number
  readonly maxFrameBytes?: number
  readonly maxPending?: number
  readonly leaseMs?: number
}

/** One host to provision before its execution realm can open. */
export interface RemoteHostProvisionRequest {
  /** Registry identity of the opened realm. */
  readonly id: RemoteHostId
  /** Caller-facing label; no defaulting. */
  readonly label: string
  /** OpenSSH host alias the helper is installed over. */
  readonly host: string
  /** Absolute remote directory receiving the digest-named install directory. */
  readonly root: string
  /** Absolute remote default workspace recorded in the opened realm. */
  readonly workspace: string
  /** Artifact the installer places on the host. */
  readonly artifact: RemoteHelperArtifact
}

/** One host to provision from entered login material. */
export interface RemoteHostLoginProvisionRequest {
  /** Registry identity of the opened realm. */
  readonly id: RemoteHostId
  /** Caller-facing label; no defaulting. */
  readonly label: string
  /** Entered login material; stored by the credentials service, never by this registry. */
  readonly login: RemoteHostLogin
  /** Absolute remote directory receiving the digest-named install directory. */
  readonly root: string
  /** Absolute remote default workspace. */
  readonly workspace: string
  /** Artifact the installer places on the host. */
  readonly artifact: RemoteHelperArtifact
  /**
   * Absolute local path of the artifact manifest this host installs from.
   * Omission persists no host record, so a host provisioned without it is
   * absent from `records()` and from startup recovery.
   */
  readonly manifest?: string
}

/** Execution services resolved inside one host's isolated realm. */
export interface RemoteHostWorld {
  readonly ssh: SshConnection
  readonly fs: FileSystem
  readonly subprocess: SubprocessRuntime
  readonly sandbox: SandboxProvider
}

/** One open host realm. */
export interface RemoteHostHandle {
  readonly spec: RemoteHostSpec
  readonly world: RemoteHostWorld
  /** Settles when the realm has been disposed. */
  readonly closed: Promise<void>
  /** Dispose the realm and release its SSH connection; idempotent. */
  close(): Promise<void>
}

/** Registry of open remote-host execution realms and their persisted records. */
export interface RemoteHostRegistry {
  /** Open one host realm; a duplicate id fails loud. */
  open(spec: RemoteHostSpec): Promise<RemoteHostHandle>
  /**
   * Install the helper on a host, then open its realm from the returned coordinates.
   * @param request - host, remote root, workspace and artifact.
   * @returns the opened handle.
   */
  provision(request: RemoteHostProvisionRequest): Promise<RemoteHostHandle>
  /**
   * Materialize entered login material, trust its host key, install the helper
   * through that identity, then open the realm it addresses. A request
   * carrying `manifest` also persists the host record.
   * @param request - identity, login material, remote root, workspace and artifact.
   * @returns the opened handle, which owns the materialized identity until it closes.
   */
  provisionFromLogin(request: RemoteHostLoginProvisionRequest): Promise<RemoteHostHandle>
  /** The open handle for an id, or undefined. */
  get(id: RemoteHostId): RemoteHostHandle | undefined
  /** Every open handle. */
  list(): readonly RemoteHostHandle[]
  /** Close one host realm; unknown ids are a no-op. */
  close(id: RemoteHostId): Promise<void>
  /** Every persisted host record, in id order. */
  records(): readonly RemoteHostRecord[]
  /**
   * Persist one host record, replacing any record with the same id.
   * @param record - the record to write.
   */
  save(record: RemoteHostRecord): Promise<void>
  /**
   * Close one host, remove its persisted record, and forget its stored login material.
   * @param id - the host to remove.
   */
  forget(id: RemoteHostId): Promise<void>
}

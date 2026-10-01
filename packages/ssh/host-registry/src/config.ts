/**
 * Config-driven host declaration: validates the plugin `Config`, reads each
 * declared host's artifact manifest from disk, and provisions every host
 * through the registry exactly once at activation.
 * @module @deepseek-ai/dsh-ssh-host-registry/config
 */

import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SshHostCredentials } from '@deepseek-ai/dsh-host-credentials'
import type { NativeRemoteHostSpec } from './composition-native.ts'
import type { Config } from './index.ts'
import type {
  RemoteHostId,
  RemoteHostProvisionRequest,
  RemoteHostRegistry,
} from './types.ts'

/** OpenSSH host alias a configured entry may name. */
const HOST_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/

/** One validated host declaration with its resolved local manifest path. */
export interface DeclaredRemoteHost {
  /** Registry identity, branded for {@link RemoteHostRegistry.provision}. */
  readonly id: RemoteHostId
  /** Caller-facing label; `label` when configured, else the id. */
  readonly label: string
  /** OpenSSH host alias the helper is installed over. */
  readonly host: string
  /** Absolute remote directory receiving the digest-named install directory. */
  readonly root: string
  /** Absolute remote default workspace recorded in the opened realm. */
  readonly workspace: string
  /** Absolute local path of the artifact manifest this host installs from. */
  readonly manifest: string
}

/**
 * Validate the plugin config and resolve every entry's local manifest path.
 *
 * Every rejection names the offending field and the value that failed, so a
 * misconfigured profile fails at load rather than dropping a host.
 * @param config - the plugin config.
 * @returns one resolved declaration per configured host, in declaration order.
 * @throws when a field is malformed, two entries share an id, or an entry has no manifest.
 */
export function declaredHosts(config: Config): readonly DeclaredRemoteHost[] {
  const entries = config.hosts ?? []
  const pluginManifest = absolutePath(config.manifest, 'manifest')
  const seen = new Map<string, number>()
  return entries.map((entry, index) => {
    const at = `hosts[${index}]`
    const id = token(entry.id, `${at}.id`)
    const prior = seen.get(id)
    if (prior !== undefined) throw new Error(`${at}.id '${id}' duplicates hosts[${prior}].id`)
    seen.set(id, index)
    const manifest = absolutePath(entry.manifest, `${at}.manifest`) ?? pluginManifest
    if (manifest === undefined) {
      throw new Error(`${at}.id '${id}' has no manifest and config.manifest is unset; every configured host needs an artifact manifest`)
    }
    return {
      id: brandString<RemoteHostId>(id),
      label: entry.label ?? id,
      host: hostAlias(entry.host, `${at}.host`),
      root: requiredPath(entry.root, `${at}.root`),
      workspace: requiredPath(entry.workspace, `${at}.workspace`),
      manifest,
    }
  })
}

/**
 * Read one host's artifact manifest and the archive it names.
 * @param host - the validated declaration to read.
 * @returns the archive bytes with the manifest's entry path and digest.
 * @throws when either file is unreadable, the manifest is not JSON, or its fields are malformed.
 * @deprecated Helper-based provisioning is no longer supported.
 */
export async function readHelperArtifact(_host: DeclaredRemoteHost): Promise<never> {
  throw new Error('helper-based provisioning is no longer supported; use native SSH composition')
}

/**
 * Install and open every declared host, in declaration order.
 *
 * A failure stops the remaining hosts: activation is one configuration, and a
 * partially applied one must not look successful.
 * @param registry - the mounted registry each host is provisioned through.
 * @param hosts - validated declarations in declaration order.
 * @returns a promise settling once every declared host is open.
 * @throws when a manifest or archive cannot be read, or when provisioning a host
 * fails; the message names both the host id and its manifest path.
 */
export async function provisionDeclaredHosts(
  registry: RemoteHostRegistry,
  hosts: readonly DeclaredRemoteHost[],
): Promise<void> {
  for (const host of hosts) {
    const request: RemoteHostProvisionRequest = {
      id: host.id,
      label: host.label,
      host: host.host,
      root: host.root,
      workspace: host.workspace,
    }
    try {
      await registry.provision(request)
    } catch (error) {
      throw new Error(`remote host '${host.id}' could not be provisioned from manifest ${host.manifest}: ${reason(error)}`, { cause: error })
    }
  }
}

/**
 * Restore every persisted host the config does not declare, in id order.
 *
 * Each record needs its stored login material: the registry never kept the
 * login, so a record without it cannot be reopened and fails activation with
 * the id and the action that resolves it. Records the config declares are
 * skipped — those hosts are already provisioned from their configured
 * manifests, so restoring them would install twice.
 * @param registry - the mounted registry each host is restored through.
 * @param credentials - the login store the records' material is read from.
 * @param hosts - the validated config declarations, whose ids are not restored.
 * @returns a promise settling once every undeclared persisted host is open.
 * @throws when a record has no stored login material, or when its manifest or
 * archive cannot be read, or when provisioning it fails; the message names the
 * host id and its manifest path.
 */
export async function restorePersistedHosts(
  registry: RemoteHostRegistry,
  credentials: SshHostCredentials,
  hosts: readonly DeclaredRemoteHost[],
): Promise<void> {
  const declared = new Set<string>(hosts.map(host => host.id))
  for (const record of registry.records()) {
    if (declared.has(record.id)) continue
    const id = brandString<RemoteHostId>(record.id)
    // The registry persisted no login material, so a record without stored
    // material is unrecoverable: name the id and both ways out.
    const login = await credentials.load(record.id)
    if (login === undefined) {
      throw new Error(
        `remote host '${record.id}' has a persisted record but no stored login material; store login material or remove the record`,
      )
    }
    try {
      const spec: NativeRemoteHostSpec = {
        id,
        label: record.label,
        host: record.host,
        port: record.port,
        user: record.user,
        ...(login.privateKey !== undefined ? { privateKey: login.privateKey } : {}),
      }
      await registry.open(spec)
    } catch (error) {
      throw new Error(`remote host '${record.id}' could not be restored: ${reason(error)}`, { cause: error })
    }
  }
}

/**
 * Require a non-empty registry token that names no path.
 * @param value - the configured value.
 * @param field - the field path named in the error.
 * @returns the value unchanged.
 * @throws when the value is empty or carries a path separator.
 */
function token(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty token, got ${JSON.stringify(value)}`)
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`${field} '${value}' must not contain a path separator`)
  }
  return value
}

/**
 * Require an OpenSSH host alias.
 * @param value - the configured value.
 * @param field - the field path named in the error.
 * @returns the value unchanged.
 * @throws when the value does not match `^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$`.
 */
function hostAlias(value: string, field: string): string {
  if (typeof value !== 'string' || !HOST_ALIAS.test(value)) {
    throw new Error(`${field} '${value}' must match ${HOST_ALIAS.source}`)
  }
  return value
}

/**
 * Require an absolute local or remote path.
 * @param value - the configured value, absent when the field was omitted.
 * @param field - the field path named in the error.
 * @returns the value unchanged, or undefined when the field was omitted.
 * @throws when a present value is not absolute.
 */
function absolutePath(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${field} '${value}' must be an absolute path starting with '/'`)
  }
  return value
}

/**
 * Require a present absolute path.
 * @param value - the configured value.
 * @param field - the field path named in the error.
 * @returns the value unchanged.
 * @throws when the field was omitted, or a present value is not absolute.
 */
function requiredPath(value: string | undefined, field: string): string {
  const path = absolutePath(value, field)
  if (path === undefined) throw new Error(`${field} is required; every host needs an absolute path`)
  return path
}

/**
 * Describe a caught value for an error message.
 * @param error - the caught value.
 * @returns the error message, or the string form of a non-error.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

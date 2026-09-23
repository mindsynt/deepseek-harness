/**
 * Host-record persistence: the registry keeps one schema-validated record per
 * login-provisioned host in the `ssh_hosts` domain, restores undeclared
 * records at activation, and forgets a host's record together with its stored
 * login. Every case mounts the real storage stack over a shared in-memory
 * medium, so reopening the registry after disposal is a genuine restart.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ControlledSshIdentity,
  RemoteHostLogin,
  SshHostCredentials,
} from '@deepseek-ai/dsh-host-credentials'
import type {
  HelperInstallRequest,
  HelperInstallation,
  SshHelperInstaller,
} from '@deepseek-ai/dsh-helper-installer'
import { afterEach, describe, expect, it } from 'vitest'
import { declaredHosts, provisionDeclaredHosts, restorePersistedHosts } from '../src/config.ts'
import { RemoteHostRegistryService, remoteHostDomainSpec } from '../src/index.ts'
import type {
  Config,
  RemoteHostComposition,
  RemoteHostId,
  RemoteHostLoginProvisionRequest,
  RemoteHostRecord,
} from '../src/index.ts'
import { mountStorage } from './helpers/storage.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

/** Temporary directories created by one test, removed after it. */
const directories: string[] = []
/** Contexts mounted by one test, disposed after it. */
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Create one temporary directory removed after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-host-records-'))
  directories.push(dir)
  return dir
}

/**
 * Write one artifact manifest and, when bytes are given, the archive it names.
 * @param dir - directory receiving both files.
 * @param name - manifest file name.
 * @param manifest - manifest fields, overridable per field.
 * @param bytes - archive bytes, or undefined to leave the named archive absent.
 * @returns the absolute manifest path.
 */
async function writeArtifact(
  dir: string,
  name: string,
  manifest: { entry?: string; digest?: string; archive?: string },
  bytes?: readonly number[],
): Promise<string> {
  const path = join(dir, name)
  const archive = manifest.archive ?? `${name}.tar.gz`
  await writeFile(path, JSON.stringify({
    entry: manifest.entry ?? 'helper.js',
    digest: manifest.digest ?? 'a'.repeat(64),
    archive,
  }))
  if (bytes !== undefined) await writeFile(join(dir, archive), Uint8Array.from(bytes))
  return path
}

/** Coordinates a fake install returns; every value differs from the request's. */
const INSTALLED: HelperInstallation = {
  node: '/usr/bin/node22',
  helper: '/installed/helper.js',
  helperHash: 'c'.repeat(64),
  workspace: '/installed-workspace',
}

/** Entered login material every login-provisioning case uses. */
const LOGIN: RemoteHostLogin = {
  host: 'example.com',
  port: 2222,
  user: 'deploy',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----',
}

/** Build one persisted record with the given id and manifest and fixed coordinates. */
function record(id: string, manifest: string, overrides: Partial<RemoteHostRecord> = {}): RemoteHostRecord {
  return {
    id,
    label: `label-${id}`,
    host: `host-${id}`,
    root: `/opt/dsh-${id}`,
    workspace: `/workspace-${id}`,
    manifest,
    helperHash: 'a'.repeat(64),
    ...overrides,
  }
}

/** Build one login provisioning request, optionally persisting a record. */
function loginRequest(id: string, manifest?: string): RemoteHostLoginProvisionRequest {
  return {
    id: brandString<RemoteHostId>(id),
    label: `label-${id}`,
    login: LOGIN,
    root: `/opt/dsh-${id}`,
    workspace: `/workspace-${id}`,
    artifact: { archive: new Uint8Array([1, 2, 3]), entry: 'helper.js', digest: 'b'.repeat(64) },
    ...(manifest === undefined ? {} : { manifest }),
  }
}

/** Seed a medium as a previous process left it: stamped, with these records. */
function seededPool(records: readonly RemoteHostRecord[]): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set(remoteHostDomainSpec.name, remoteHostDomainSpec.version)
  pool.media.set(remoteHostDomainSpec.name, {
    tables: new Map([['hosts', new Map(records.map(item => [item.id, item]))]]),
    global: null,
  })
  return pool
}

/** Composition mounting one host-private stub service per execution role. */
function stubComposition(disposals: string[]): RemoteHostComposition {
  return async (realm, host) => {
    class StubSsh extends Service {
      constructor(ctx: Context) {
        super(ctx, 'ssh')
        ctx.effect(() => () => { disposals.push(host.id) })
      }
    }
    class StubFs extends Service {
      constructor(ctx: Context) { super(ctx, 'fs') }
    }
    class StubSubprocess extends Service {
      constructor(ctx: Context) { super(ctx, 'subprocess') }
    }
    class StubSandbox extends Service {
      constructor(ctx: Context) { super(ctx, 'sandbox') }
    }
    await realm.plugin(StubSsh)
    await realm.plugin(StubFs)
    await realm.plugin(StubSubprocess)
    await realm.plugin(StubSandbox)
    const ssh = realm.get('ssh')
    const fs = realm.get('fs')
    const subprocess = realm.get('subprocess')
    const sandbox = realm.get('sandbox')
    if (ssh === undefined || fs === undefined || subprocess === undefined || sandbox === undefined) {
      throw new Error('stub composition did not provide every execution service')
    }
    return { ssh, fs, subprocess, sandbox }
  }
}

/**
 * Mount the storage stack, a root filesystem stub and the registry, and dispose
 * the context after the test.
 * @param options - shared medium, fakes and composition the registry must use.
 * @returns the context, the shared pool, the registry and realm disposals.
 */
async function harness(options: {
  readonly pool?: MemoryMediaPool
  readonly installer?: SshHelperInstaller
  readonly credentials?: SshHostCredentials
  readonly composition?: RemoteHostComposition
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const { pool } = await mountStorage(ctx, options.pool)
  class RootFs extends Service {
    constructor(root: Context) { super(root, 'fs') }
  }
  await ctx.plugin(RootFs)
  if (options.installer !== undefined) ctx.provide('sshHelperInstaller', options.installer as never)
  if (options.credentials !== undefined) ctx.provide('sshHostCredentials', options.credentials as never)
  const disposals: string[] = []
  await ctx.plugin(RemoteHostRegistryService, options.composition ?? stubComposition(disposals))
  return { ctx, pool, registry: ctx.remoteHosts, disposals }
}

/**
 * Installer recording every request, returning fixed coordinates.
 * @returns the installer and the requests it received in order.
 */
function fakeInstaller() {
  const requests: HelperInstallRequest[] = []
  const installer: SshHelperInstaller = {
    install: async (request) => {
      requests.push(request)
      return INSTALLED
    },
  }
  return { installer, requests }
}

/**
 * Credentials service recording every call and returning one fixed identity
 * and one configured stored login.
 * @param options - login material `load` returns, absent for none.
 * @returns the service, its identity, recorded calls and the removal count.
 */
function fakeCredentials(options: { readonly login?: RemoteHostLogin } = {}) {
  const calls: string[] = []
  const materialized: RemoteHostLogin[] = []
  const forgotten: string[] = []
  let removals = 0
  const identity: ControlledSshIdentity = {
    alias: 'dsh-0123456789abcdef',
    configPath: '/state/dsh-0123456789abcdef/config',
    directory: '/state/dsh-0123456789abcdef',
    knownHostsPath: '/state/dsh-0123456789abcdef/known_hosts',
    dispose: async () => {
      removals += 1
      calls.push('dispose')
    },
  }
  const credentials: SshHostCredentials = {
    materialize: async (login) => {
      calls.push('materialize')
      materialized.push(login)
      return identity
    },
    store: async () => { calls.push('store') },
    load: async (id) => {
      calls.push(`load:${id}`)
      return options.login
    },
    forget: async (id) => {
      calls.push(`forget:${id}`)
      forgotten.push(id)
    },
    pinHostKey: async () => { calls.push('pinHostKey') },
    trustFirstUse: async () => { calls.push('trustFirstUse') },
  }
  return { credentials, identity, calls, materialized, forgotten, removals: () => removals }
}

describe('remote host records', () => {
  it('saves records synchronously in id order and replaces the record for an id', async () => {
    const { registry } = await harness()
    await registry.save(record('charlie', '/tmp/charlie.json'))
    await registry.save(record('alpha', '/tmp/alpha.json'))
    await registry.save(record('bravo', '/tmp/bravo.json'))
    expect(registry.records().map(item => item.id)).toEqual(['alpha', 'bravo', 'charlie'])

    await registry.save(record('bravo', '/tmp/bravo.json', { label: 'relabeled' }))
    expect(registry.records().map(item => item.id)).toEqual(['alpha', 'bravo', 'charlie'])
    expect(registry.records()[1]).toEqual(record('bravo', '/tmp/bravo.json', { label: 'relabeled' }))
  })

  it('reads the records an earlier registry wrote, in id order', async () => {
    const first = await harness()
    await first.registry.save(record('bravo', '/tmp/bravo.json'))
    await first.registry.save(record('alpha', '/tmp/alpha.json'))
    const pool = first.pool
    await first.ctx.fiber.dispose()

    const second = await harness({ pool })
    expect(second.registry.records()).toEqual([
      record('alpha', '/tmp/alpha.json'),
      record('bravo', '/tmp/bravo.json'),
    ])
  })

  it('rejects an invalid stored record at open instead of dropping it', async () => {
    const rejectedFor = async (manifest: string) => {
      const pool = new MemoryMediaPool()
      pool.versions.set(remoteHostDomainSpec.name, remoteHostDomainSpec.version)
      pool.media.set(remoteHostDomainSpec.name, {
        tables: new Map([['hosts', new Map([['alpha', record('alpha', manifest)]])]]),
        global: null,
      })
      return harness({ pool }).then(() => undefined, (error: unknown) => error as Error & { code?: string })
    }

    for (const manifest of ['', 'manifests/alpha.json']) {
      const rejected = await rejectedFor(manifest)
      expect(rejected?.code).toBe('invalid-record')
      expect(rejected?.message).toContain(remoteHostDomainSpec.name)
      expect(rejected?.message).toContain('table')
      expect(rejected?.message).toContain('alpha')
    }
  })

  it('fails loud when the registry never opened its domain', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const registry = new RemoteHostRegistryService(ctx)
    expect(() => registry.records()).toThrow(/not open yet/)
    await expect(registry.save(record('alpha', '/tmp/alpha.json')))
      .rejects.toThrow('@deepseek-ai/dsh-storage-domain')
  })
})

describe('login provisioning and records', () => {
  it('persists the record a login provisioning writes', async () => {
    const dir = await tempDir()
    const manifest = await writeArtifact(dir, 'alpha.json', { entry: 'alpha.js', digest: '1'.repeat(64), archive: 'alpha.tar.gz' }, [1, 2, 3])
    const { installer } = fakeInstaller()
    const fake = fakeCredentials()
    const { registry } = await harness({ installer, credentials: fake.credentials })
    await registry.provisionFromLogin(loginRequest('alpha', manifest))

    expect(registry.records()).toEqual([{
      id: 'alpha',
      label: 'label-alpha',
      host: fake.identity.alias,
      root: '/opt/dsh-alpha',
      workspace: '/workspace-alpha',
      manifest,
      helperHash: INSTALLED.helperHash,
    }])
    // The login itself never reaches the record: the credentials store owns it.
    expect(JSON.stringify(registry.records())).not.toContain('PRIVATE KEY')
  })

  it('writes no record when the request carries no manifest', async () => {
    const { installer } = fakeInstaller()
    const fake = fakeCredentials()
    const { registry } = await harness({ installer, credentials: fake.credentials })
    await registry.provisionFromLogin(loginRequest('alpha'))
    expect(registry.records()).toEqual([])
  })

  it('closes the opened realm and removes the identity once when the record write fails', async () => {
    const dir = await tempDir()
    const manifest = await writeArtifact(dir, 'alpha.json', {}, [1])
    const { installer } = fakeInstaller()
    const fake = fakeCredentials()
    const pool = new MemoryMediaPool()
    const { registry } = await harness({ pool, installer, credentials: fake.credentials })
    pool.failNextWrites = 1

    await expect(registry.provisionFromLogin(loginRequest('alpha', manifest)))
      .rejects.toThrow(/injected write failure/)
    expect(registry.list()).toHaveLength(0)
    expect(fake.removals()).toBe(1)
    expect(registry.records()).toEqual([])
  })
})

describe('forgetting a host', () => {
  it('closes the realm, removes the record, and forgets the stored login idempotently', async () => {
    const dir = await tempDir()
    const manifest = await writeArtifact(dir, 'alpha.json', {}, [1])
    const { installer } = fakeInstaller()
    const fake = fakeCredentials()
    const { registry } = await harness({ installer, credentials: fake.credentials })
    const handle = await registry.provisionFromLogin(loginRequest('alpha', manifest))
    const id = handle.spec.id
    expect(registry.records()).toHaveLength(1)

    await registry.forget(id)
    expect(registry.get(id)).toBeUndefined()
    await expect(handle.closed).resolves.toBeUndefined()
    expect(registry.records()).toEqual([])
    expect(fake.removals()).toBe(1)
    expect(fake.forgotten).toEqual(['alpha'])

    await registry.forget(id)
    expect(fake.forgotten).toEqual(['alpha', 'alpha'])
    expect(registry.records()).toEqual([])
  })
})

describe('startup recovery', () => {
  it('restores an undeclared persisted host from its stored login and manifest', async () => {
    const dir = await tempDir()
    const manifest = await writeArtifact(dir, 'alpha.json', { entry: 'alpha.js', digest: '1'.repeat(64), archive: 'alpha.tar.gz' }, [1, 2, 3])
    const pool = seededPool([record('alpha', manifest)])
    const { installer, requests } = fakeInstaller()
    const fake = fakeCredentials({ login: LOGIN })
    const { registry } = await harness({ pool, installer, credentials: fake.credentials })

    await restorePersistedHosts(registry, fake.credentials, [])

    expect(fake.calls).toEqual(['load:alpha', 'materialize', 'trustFirstUse'])
    expect(fake.materialized).toEqual([LOGIN])
    expect(requests).toEqual([{
      host: fake.identity.alias,
      root: '/opt/dsh-alpha',
      workspace: '/workspace-alpha',
      artifact: { archive: Uint8Array.from([1, 2, 3]), entry: 'alpha.js', digest: '1'.repeat(64) },
      sshConfigFile: fake.identity.configPath,
    }])
    const handle = registry.get(brandString<RemoteHostId>('alpha'))
    expect(handle?.spec.host).toBe(fake.identity.alias)
    expect(handle?.spec.workspace).toBe(INSTALLED.workspace)
    // Recovery rewrites the record from the fresh installation.
    expect(registry.records()).toEqual([record('alpha', manifest, {
      host: fake.identity.alias,
      helperHash: INSTALLED.helperHash,
    })])
  })

  it('restores records in id order', async () => {
    const dir = await tempDir()
    const manifest = await writeArtifact(dir, 'shared.json', {}, [1])
    const pool = seededPool([
      record('bravo', manifest),
      record('alpha', manifest),
    ])
    const { installer, requests } = fakeInstaller()
    const fake = fakeCredentials({ login: LOGIN })
    const { registry } = await harness({ pool, installer, credentials: fake.credentials })

    await restorePersistedHosts(registry, fake.credentials, [])

    expect(fake.calls.filter(call => call.startsWith('load:'))).toEqual(['load:alpha', 'load:bravo'])
    expect(registry.list().map(handle => handle.spec.id)).toEqual(['alpha', 'bravo'])
    expect(requests).toHaveLength(2)
  })

  it('fails loud and provisions nothing when a persisted record has no stored login material', async () => {
    const dir = await tempDir()
    const manifest = await writeArtifact(dir, 'alpha.json', {}, [1])
    const pool = seededPool([record('alpha', manifest)])
    const { installer, requests } = fakeInstaller()
    const fake = fakeCredentials()
    const { registry } = await harness({ pool, installer, credentials: fake.credentials })

    const rejected = await restorePersistedHosts(registry, fake.credentials, [])
      .then(() => undefined, (error: unknown) => error as Error)
    expect(rejected?.message).toContain("'alpha'")
    expect(rejected?.message).toContain('store login material or remove the record')
    expect(requests).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })

  it('never restores a record whose id the config declares', async () => {
    const dir = await tempDir()
    const declaredManifest = await writeArtifact(dir, 'declared.json', {}, [1])
    const persistedManifest = await writeArtifact(dir, 'persisted.json', {}, [2])
    const config: Config = {
      hosts: [{ id: 'alpha', host: 'a.example', root: '/opt/dsh', workspace: '/work', manifest: declaredManifest }],
    }
    const declared = declaredHosts(config)
    const pool = seededPool([
      record('alpha', persistedManifest),
      record('bravo', persistedManifest),
    ])
    const { installer, requests } = fakeInstaller()
    const fake = fakeCredentials({ login: LOGIN })
    const { registry } = await harness({ pool, installer, credentials: fake.credentials })

    await provisionDeclaredHosts(registry, declared)
    await restorePersistedHosts(registry, fake.credentials, declared)

    // One install for the declared host, one for the undeclared record.
    expect(requests.map(request => request.host)).toEqual(['a.example', fake.identity.alias])
    expect(fake.calls).not.toContain('load:alpha')
    expect(fake.calls).toContain('load:bravo')
    // The declared id's record is left exactly as stored; only bravo's is
    // rewritten from its fresh installation.
    expect(registry.records()).toEqual([
      record('alpha', persistedManifest),
      record('bravo', persistedManifest, { host: fake.identity.alias, helperHash: INSTALLED.helperHash }),
    ])
  })

  it('stops at the first unrestorable record and names the host and its manifest', async () => {
    const dir = await tempDir()
    const manifest = await writeArtifact(dir, 'bravo.json', {}, [1])
    const missing = join(dir, 'missing.json')
    const pool = seededPool([
      record('alpha', missing),
      record('bravo', manifest),
    ])
    const { installer, requests } = fakeInstaller()
    const fake = fakeCredentials({ login: LOGIN })
    const { registry } = await harness({ pool, installer, credentials: fake.credentials })

    const rejected = await restorePersistedHosts(registry, fake.credentials, [])
      .then(() => undefined, (error: unknown) => error as Error)
    expect(rejected?.message).toContain("'alpha'")
    expect(rejected?.message).toContain(missing)
    expect(rejected?.message).toContain('could not be restored')
    expect(requests).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })
})

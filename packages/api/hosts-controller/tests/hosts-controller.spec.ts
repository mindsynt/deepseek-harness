/**
 * The hosts controller is a BFF over two already-tested services: the remote
 * host registry owns records, realms and provisioning, and the credentials
 * store owns login material and the controlled OpenSSH identity. These tests
 * drive the real registry, the real credentials store (over a temporary state
 * directory and a fixed host-key scanner) and a stub installer and composition,
 * so nothing here opens a network connection, spawns a process or writes to the
 * harness home.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { SshHostCredentialsService } from '@deepseek-ai/dsh-host-credentials'
import type { HostKeyEndpoint, HostKeyScanner, RemoteHostLogin } from '@deepseek-ai/dsh-host-credentials'
import type { HelperInstallRequest, HelperInstallation } from '@deepseek-ai/dsh-helper-installer'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { RemoteHostRegistryService, remoteHostDomainSpec } from '@deepseek-ai/dsh-ssh-host-registry'
import type { RemoteHostComposition, RemoteHostId, RemoteHostRecord, RemoteHostSpec } from '@deepseek-ai/dsh-ssh-host-registry'
import { RemoteError, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HostsController from '../src/index.ts'
import type { RemoteHostsFollowFrame, RemoteHostView } from '../src/types.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

/** Temporary directories this spec creates, removed after every test. */
const temporaryDirectories: string[] = []

/** Contexts this spec boots, disposed after every test. */
const contexts: Context[] = []

/** Every endpoint a test's scanner was asked about. */
const scanned: HostKeyEndpoint[] = []

/** Every install request the stub installer received, in order. */
const installRequests: HelperInstallRequest[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
  scanned.length = 0
  installRequests.length = 0
})

/** Minimal in-memory record store mounted as `ctx.credentials`. */
class FakeCredentials extends Service {
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  /** @param ctx - context that owns the service registration. */
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * @param key - the record to read.
   * @returns the stored record, or undefined.
   */
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  /**
   * @param key - the record to replace.
   * @param mutate - receives the current record and returns its replacement.
   * @returns the record after the write.
   */
  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next !== undefined) this.records.set(key, next)
    return next ?? current
  }

  /**
   * @param key - the record to remove.
   * @returns a promise settling once the record is gone.
   */
  deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

/** Installer stub returning fixed verified coordinates, or failing on request. */
class FakeInstaller extends Service {
  /**
   * @param ctx - context that owns the service registration.
   * @param config - `fail` makes every install reject the way an unreachable host does.
   */
  constructor(ctx: Context, private readonly config: { readonly fail?: boolean } = {}) {
    super(ctx, 'sshHelperInstaller')
  }

  /**
   * @param request - the caller's provisioning request.
   * @returns verified coordinates for the request's workspace.
   * @throws when this stub was configured to fail.
   */
  install(request: HelperInstallRequest): Promise<HelperInstallation> {
    installRequests.push(request)
    if (this.config.fail === true) return Promise.reject(new Error('ssh: connect to host: Connection refused'))
    return Promise.resolve({
      node: '/usr/bin/node22',
      helper: '/opt/dsh/helper/helper.js',
      helperHash: 'c'.repeat(64),
      workspace: request.workspace,
    })
  }
}

/**
 * Composition mounting one stub service per execution role, so a realm opens
 * with no SSH connection at all.
 * @returns the stub composition.
 * @throws when the realm did not provide every execution service.
 */
function stubComposition(): RemoteHostComposition {
  return async (realm) => {
    class StubSsh extends Service {
      constructor(ctx: Context) { super(ctx, 'ssh') }
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
 * Build a scanner answering every endpoint with fixed lines.
 * @param lines - lines the scanner publishes for every endpoint.
 * @returns the scanner.
 */
function fakeScanner(lines: readonly string[]): HostKeyScanner {
  return {
    scan: (endpoint) => {
      scanned.push(endpoint)
      return Promise.resolve(lines)
    },
  }
}

/** Mount the real storage hub, in-memory backend and domain facility on a context. */
async function mountStorage(ctx: Context): Promise<void> {
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
}

/** One booted controller and the real services behind it. */
interface Harness {
  readonly ctx: Context
  readonly controller: HostsController
  readonly registry: RemoteHostRegistryService
  readonly stateDir: string
}

/**
 * Boot one isolated controller over a fresh temporary state directory.
 * @param options - installer failure mode and the lines the host-key scanner publishes.
 * @returns the controller, the context and the real services it composes.
 */
async function boot(options: { readonly installerFails?: boolean; readonly hostKeys?: readonly string[] } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hosts-controller-'))
  temporaryDirectories.push(root)
  const stateDir = join(root, 'state')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FakeCredentials)
  new SshHostCredentialsService(ctx, { stateDir }, fakeScanner(options.hostKeys ?? ['example ssh-ed25519 AAAAkey']))
  await mountStorage(ctx)
  await ctx.plugin(FakeInstaller, { ...options.installerFails === true ? { fail: true } : {} })
  await ctx.plugin(RemoteHostRegistryService, stubComposition())
  await ctx.plugin(HostsController)
  return { ctx, controller: ctx.hostsController, registry: ctx.remoteHosts, stateDir }
}

/** Build one persisted host record with the given id and otherwise fixed coordinates. */
function record(id: string): RemoteHostRecord {
  return {
    id,
    label: `label-${id}`,
    host: 'dsh-0123456789abcdef',
    root: `/opt/dsh-${id}`,
    workspace: `/workspace-${id}`,
    manifest: `/artifacts/${id}/manifest.json`,
    helperHash: 'a'.repeat(64),
  }
}

/** The browser view of one record that is not open. */
function closed(entry: RemoteHostRecord): RemoteHostView {
  return { record: { ...entry }, open: false }
}

/** Build one open host spec with the given id, carrying no generated configuration. */
function configuredSpec(id: string): RemoteHostSpec {
  return {
    id: id as RemoteHostId,
    label: id,
    host: `alias-${id}`,
    node: '/usr/bin/node22',
    helper: '/opt/dsh/helper/helper.js',
    helperHash: 'a'.repeat(64),
    workspace: '/workspace',
  }
}

/**
 * Write one helper-artifact manifest and the archive beside it.
 * @param root - the harness's temporary root.
 * @returns the absolute manifest path.
 */
async function writeArtifact(root: string): Promise<string> {
  const directory = join(root, 'artifact')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'helper.tgz'), 'archive-bytes')
  const manifest = join(directory, 'manifest.json')
  await writeFile(manifest, JSON.stringify({ entry: 'helper.js', digest: 'b'.repeat(64), archive: 'helper.tgz' }))
  return manifest
}

/** One add request with a stored-login-shaped payload. */
function addRequest(manifest: string, overrides: { readonly id?: string; readonly login?: RemoteHostLogin } = {}): {
  id: string
  label: string
  root: string
  workspace: string
  manifest: string
  login: RemoteHostLogin
} {
  return {
    id: overrides.id ?? 'web',
    label: 'Web server',
    root: '/opt/dsh',
    workspace: '/srv/web',
    manifest,
    login: overrides.login ?? { host: 'example.com', port: 2222, user: 'dev' },
  }
}

/**
 * Pull one frame with a settled value, failing when the stream ended first.
 * @param iterator - the generation under test.
 * @returns the frame the stream produced.
 * @throws when the stream ended instead of producing a frame.
 */
async function nextFrame(iterator: AsyncIterator<RemoteHostsFollowFrame>): Promise<RemoteHostsFollowFrame> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('hosts stream ended before the expected frame')
  return next.value
}

describe('the hosts Remote namespace a host-management page calls', () => {
  it('publishes the hosts namespace from its own service key', async () => {
    const { controller } = await boot()
    expect(controller.typertRemote.serviceKey).toBe('hostsController')
    expect(controller.typertRemote.namespace).toBe('hosts')
    expect(remoteMethods(controller)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'add', invocation: { kind: 'direct' } },
      { method: 'remove', exportName: 'delete', invocation: { kind: 'direct' } },
      { method: 'testConnection', invocation: { kind: 'direct' } },
      { method: 'follow', mode: 'stream', invocation: { kind: 'direct' } },
    ])
  })

  it('lists persisted hosts in id order with their open state', async () => {
    const { controller, registry } = await boot()
    await registry.save(record('beta'))
    await registry.save(record('alpha'))
    await registry.open(configuredSpec('alpha'))
    expect(controller.list()).toEqual({
      items: [
        { record: { ...record('alpha') }, open: true },
        closed(record('beta')),
      ],
    })
  })

  it('lists nothing while no host is registered', async () => {
    const { controller } = await boot()
    expect(controller.list()).toEqual({ items: [] })
  })
})

describe('adding a host', () => {
  it('stores the login, installs from the manifest and opens the host', async () => {
    const harness = await boot()
    const manifest = await writeArtifact(temporaryDirectories[0] as string)
    const value = await harness.controller.add(addRequest(manifest))

    expect(value.host.open).toBe(true)
    expect(value.host.record).toMatchObject({
      id: 'web',
      label: 'Web server',
      root: '/opt/dsh',
      workspace: '/srv/web',
      manifest,
      helperHash: 'c'.repeat(64),
    })
    expect(value.host.record.host).toMatch(/^dsh-[0-9a-f]{16}$/u)
    expect(harness.registry.records()).toEqual([{ ...value.host.record }])
    await expect(harness.ctx.sshHostCredentials.load('web')).resolves.toEqual({
      host: 'example.com',
      port: 2222,
      user: 'dev',
    })
    expect(installRequests).toHaveLength(1)
    expect(scanned).toEqual([{ host: 'example.com', port: 2222 }])
  })

  it('refuses an id whose execution world is already open', async () => {
    const harness = await boot()
    await harness.registry.open(configuredSpec('web'))
    await expect(harness.controller.add(addRequest('/artifacts/web/manifest.json')))
      .rejects.toMatchObject({ code: 'hosts/already-exists', details: { id: 'web' } })
  })

  it('refuses an id a persisted record already uses', async () => {
    const harness = await boot()
    await harness.registry.save(record('web'))
    await expect(harness.controller.add(addRequest('/artifacts/web/manifest.json')))
      .rejects.toMatchObject({ code: 'hosts/already-exists', details: { id: 'web' } })
    expect(harness.registry.records()).toEqual([record('web')])
  })

  it('removes the stored login and the record when installation fails', async () => {
    const harness = await boot({ installerFails: true })
    const manifest = await writeArtifact(temporaryDirectories[0] as string)
    let failure: unknown
    try {
      await harness.controller.add(addRequest(manifest))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RemoteError)
    expect(failure).toMatchObject({ code: 'hosts/add-failed', details: { id: 'web' } })
    expect((failure as Error).message).toContain('Connection refused')
    expect((failure as Error).message).toContain('were removed')
    expect(harness.registry.records()).toEqual([])
    await expect(harness.ctx.sshHostCredentials.load('web')).resolves.toBeUndefined()
  })

  it('removes the stored login when the artifact manifest cannot be read', async () => {
    const harness = await boot()
    await expect(harness.controller.add(addRequest(join(temporaryDirectories[0] as string, 'missing.json'))))
      .rejects.toMatchObject({ code: 'hosts/add-failed' })
    await expect(harness.ctx.sshHostCredentials.load('web')).resolves.toBeUndefined()
  })

  it('removes a login the credential store refuses', async () => {
    const harness = await boot()
    const manifest = await writeArtifact(temporaryDirectories[0] as string)
    await expect(harness.controller.add(addRequest(manifest, { login: { host: 'example.com', port: 22, user: 'dev', privateKey: '' } })))
      .rejects.toMatchObject({ code: 'hosts/add-failed' })
    await expect(harness.ctx.sshHostCredentials.load('web')).resolves.toBeUndefined()
  })

  it('reports both failures when the removal after a failed add also fails', async () => {
    const harness = await boot({ installerFails: true })
    const manifest = await writeArtifact(temporaryDirectories[0] as string)
    // A bare string, the way some storage clients refuse.
    vi.spyOn(harness.registry, 'forget').mockRejectedValue('credential store offline')
    let failure: unknown
    try {
      await harness.controller.add(addRequest(manifest))
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'hosts/add-failed', details: { id: 'web' } })
    expect((failure as Error).message).toContain('also failed: credential store offline')
  })
})

describe('removing a host', () => {
  it('removes the execution world, the record and the stored login', async () => {
    const harness = await boot()
    const manifest = await writeArtifact(temporaryDirectories[0] as string)
    const added = await harness.controller.add(addRequest(manifest))
    expect(harness.registry.get('web' as RemoteHostId)).toBeDefined()

    await expect(harness.controller.remove({ id: 'web' })).resolves.toEqual({ removed: true })
    expect(harness.registry.records()).toEqual([])
    expect(harness.registry.get(added.host.record.id as RemoteHostId)).toBeUndefined()
    await expect(harness.ctx.sshHostCredentials.load('web')).resolves.toBeUndefined()
    await expect(harness.controller.remove({ id: 'web' })).resolves.toEqual({ removed: true })
  })
})

describe('checking a stored login', () => {
  it('trusts the keys a closed host publishes through a freshly materialized identity', async () => {
    const harness = await boot({ hostKeys: ['example ssh-ed25519 AAAAkey'] })
    await harness.ctx.sshHostCredentials.store('web', { host: 'dsh-0123456789abcdef', port: 22, user: 'dev' })
    await harness.registry.save(record('web'))

    const value = await harness.controller.testConnection({ id: 'web' })
    expect(value).toEqual({
      host: 'dsh-0123456789abcdef',
      port: 22,
      hostKeys: ['example ssh-ed25519 AAAAkey'],
    })
    expect(scanned).toEqual([{ host: 'dsh-0123456789abcdef', port: 22 }])
    expect(harness.registry.get('web' as RemoteHostId)).toBeUndefined()
    await expect(readdir(harness.stateDir)).resolves.toEqual([])
  })

  it('trusts the keys through the identity an open world already addresses', async () => {
    const harness = await boot({ hostKeys: ['example ssh-ed25519 AAAAkey'] })
    const manifest = await writeArtifact(temporaryDirectories[0] as string)
    const added = await harness.controller.add(addRequest(manifest, { login: { host: 'example.com', port: 22, user: 'dev' } }))
    // The add itself trusted the key while provisioning the helper.
    scanned.length = 0

    const value = await harness.controller.testConnection({ id: 'web' })
    expect(value).toEqual({
      host: 'example.com',
      port: 22,
      hostKeys: ['example ssh-ed25519 AAAAkey'],
    })
    expect(scanned).toEqual([{ host: 'example.com', port: 22 }])
    // The open world owns those files: the check must leave them in place.
    await expect(readdir(harness.stateDir)).resolves.toEqual([added.host.record.host])
  })

  it('reports an unknown host without stored login material', async () => {
    const harness = await boot()
    await expect(harness.controller.testConnection({ id: 'ghost' }))
      .rejects.toMatchObject({ code: 'hosts/unknown-host', details: { id: 'ghost' } })
  })

  it('refuses an open world that has no stored-login identity', async () => {
    const harness = await boot()
    await harness.ctx.sshHostCredentials.store('configured', { host: 'example.com', port: 22, user: 'dev' })
    await harness.registry.open(configuredSpec('configured'))
    await expect(harness.controller.testConnection({ id: 'configured' }))
      .rejects.toMatchObject({ code: 'hosts/no-login-identity', details: { id: 'configured' } })
  })
})

describe('following host-list changes', () => {
  it('streams a baseline, ordered increments and the end of the generation', async () => {
    const harness = await boot()
    await harness.registry.save(record('alpha'))
    const abort = new AbortController()
    const iterator = harness.controller.follow(abort.signal)[Symbol.asyncIterator]()

    expect(await nextFrame(iterator)).toEqual({
      type: 'baseline',
      value: { items: [closed(record('alpha'))] },
    })
    // Buffered while no read is waiting, so a change committed between two
    // reads is not lost.
    await harness.registry.save(record('beta'))
    expect(await nextFrame(iterator)).toEqual({ type: 'upsert', host: closed(record('beta')) })
    harness.ctx.emit('domain/changed', { domain: 'other', table: 'hosts', key: 'x', operation: 'deleted' })
    harness.ctx.emit('domain/changed', { domain: remoteHostDomainSpec.name, table: 'other', key: 'x', operation: 'deleted' })
    const pending = iterator.next()
    await harness.registry.forget('alpha' as RemoteHostId)
    expect(await pending).toEqual({ done: false, value: { type: 'remove', hostId: 'alpha' } })
    abort.abort()
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })

  it('announces a change to a host that is open', async () => {
    const harness = await boot()
    const abort = new AbortController()
    const iterator = harness.controller.follow(abort.signal)[Symbol.asyncIterator]()
    expect(await nextFrame(iterator)).toEqual({ type: 'baseline', value: { items: [] } })

    const pending = iterator.next()
    await harness.registry.open(configuredSpec('alpha'))
    await harness.registry.save(record('alpha'))
    expect(await pending).toEqual({
      done: false,
      value: { type: 'upsert', host: { record: { ...record('alpha') }, open: true } },
    })
    abort.abort()
    await iterator.next()
  })

  it('serves two generations from one registry', async () => {
    const harness = await boot()
    await harness.registry.save(record('alpha'))
    const first = new AbortController()
    const second = new AbortController()
    const firstIterator = harness.controller.follow(first.signal)[Symbol.asyncIterator]()
    const secondIterator = harness.controller.follow(second.signal)[Symbol.asyncIterator]()

    expect(await nextFrame(firstIterator)).toEqual({
      type: 'baseline',
      value: { items: [closed(record('alpha'))] },
    })
    expect(await nextFrame(secondIterator)).toEqual({
      type: 'baseline',
      value: { items: [closed(record('alpha'))] },
    })
    const firstPending = firstIterator.next()
    const secondPending = secondIterator.next()
    await harness.registry.save(record('beta'))
    expect(await firstPending).toEqual({ done: false, value: { type: 'upsert', host: closed(record('beta')) } })
    expect(await secondPending).toEqual({ done: false, value: { type: 'upsert', host: closed(record('beta')) } })
    first.abort()
    second.abort()
    await firstIterator.next()
    await secondIterator.next()
  })

  it('ends a generation when its caller aborts before the first read', async () => {
    const harness = await boot()
    const stream = harness.controller.follow(AbortSignal.abort())
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow()
  })

  it('ends a generation waiting on a disposed context', async () => {
    const harness = await boot()
    const abort = new AbortController()
    const iterator = harness.controller.follow(abort.signal)[Symbol.asyncIterator]()
    expect(await nextFrame(iterator)).toEqual({ type: 'baseline', value: { items: [] } })
    const pending = iterator.next()
    await harness.ctx.fiber.dispose()
    abort.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
  })
})

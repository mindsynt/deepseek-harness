/**
 * The hosts controller is a BFF over two already-tested services: the remote
 * host registry owns records and execution realms, and the credentials store
 * owns login material and the controlled OpenSSH identity. These tests drive
 * the real registry, the real credentials store over a temporary state
 * directory with a fixed host-key scanner, and a stub execution composition,
 * so nothing here opens a network connection, spawns a process, or writes to
 * the harness home.
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { SshHostCredentialsService } from '@deepseek-ai/dsh-host-credentials'
import type { HostKeyEndpoint, HostKeyScanner, RemoteHostLogin } from '@deepseek-ai/dsh-host-credentials'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { RemoteHostRegistryService } from '@deepseek-ai/dsh-ssh-host-registry'
import type {
  NativeRemoteHostSpec, NativeRemoteHostWorld, RemoteHostId, RemoteHostRecord, RemoteHostRegistry,
} from '@deepseek-ai/dsh-ssh-host-registry'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import HostsController from '../src/index.ts'
import type { RemoteHostsFollowFrame, RemoteHostView } from '../src/types.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

/** Temporary directories this spec creates, removed after every test. */
const temporaryDirectories: string[] = []

/** Contexts this spec boots, disposed after every test. */
const contexts: Context[] = []

/** Every endpoint a test's scanner was asked about. */
const scanned: HostKeyEndpoint[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
  scanned.length = 0
})

/** In-memory record store mounted as `ctx.credentials`. */
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

/** Composition mounting one stub service per execution role, so a realm opens without SSH. */
function stubComposition(): (realm: Context, spec: NativeRemoteHostSpec) => Promise<NativeRemoteHostWorld> {
  class StubSshNative extends Service {
    constructor(ctx: Context) {
      super(ctx, 'sshNative')
    }
  }
  class StubFs extends Service {
    constructor(ctx: Context) {
      super(ctx, 'fs')
    }
  }
  class StubSubprocess extends Service {
    constructor(ctx: Context) {
      super(ctx, 'subprocess')
    }
  }
  return async (realm) => {
    await realm.plugin(StubSshNative)
    await realm.plugin(StubFs)
    await realm.plugin(StubSubprocess)
    const sshNative = realm.get('sshNative')
    const fs = realm.get('fs')
    const subprocess = realm.get('subprocess')
    if (sshNative === undefined || fs === undefined || subprocess === undefined) {
      throw new Error('stub composition did not provide every execution service')
    }
    return { sshNative, fs, subprocess }
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
  readonly registry: RemoteHostRegistry
  readonly stateDir: string
}

/**
 * Boot one isolated controller over a fresh temporary state directory.
 * @param options - host-key lines and the id whose stored login the store cannot find.
 * @returns the controller, the context and the real services it composes.
 */
async function boot(options: { readonly hostKeys?: readonly string[]; readonly missing?: string } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hosts-controller-'))
  temporaryDirectories.push(root)
  const stateDir = join(root, 'state')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FakeCredentials)
  new SshHostCredentialsService(ctx, { stateDir }, fakeScanner(options.hostKeys ?? ['example ssh-ed25519 AAAAkey']))
  await mountStorage(ctx)
  await ctx.plugin(RemoteHostRegistryService, stubComposition())
  await ctx.plugin(HostsController)
  if (options.missing !== undefined) await ctx.sshHostCredentials.forget(options.missing)
  return { ctx, controller: ctx.hostsController, registry: ctx.remoteHosts, stateDir }
}

/** Build one persisted host record with the given id and otherwise fixed coordinates. */
function record(id: string): RemoteHostRecord {
  return {
    id,
    label: `label-${id}`,
    host: 'example.com',
    port: 2222,
    user: 'dev',
  }
}

/** The browser view of one record that is not open. */
function closed(entry: RemoteHostRecord): RemoteHostView {
  return { record: { ...entry }, open: false }
}

/** One entered login with the coordinates the tests read back. */
function login(overrides: Partial<RemoteHostLogin> = {}): RemoteHostLogin {
  return {
    host: overrides.host ?? 'example.com',
    port: overrides.port ?? 2222,
    user: overrides.user ?? 'dev',
    ...(overrides.privateKey !== undefined ? { privateKey: overrides.privateKey } : {}),
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
    await registry.open({
      id: brandString<RemoteHostId>('alpha'),
      label: 'label-alpha',
      host: 'example.com',
      port: 2222,
      user: 'dev',
    })
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
  it('stores the login, persists the record, and opens the host', async () => {
    const { ctx, controller, registry } = await boot()

    const value = await controller.add({ id: 'web', label: 'Web server', login: login() })

    expect(value.host.open).toBe(true)
    expect(value.host.record).toEqual({ id: 'web', label: 'Web server', host: 'example.com', port: 2222, user: 'dev' })
    // The record is durable before the call answers, so a later process and a
    // reconnecting browser list both see the host this add produced.
    expect(registry.records()).toEqual([{ ...value.host.record }])
    expect(ctx.remoteHosts.get(brandString<RemoteHostId>('web'))).toBeDefined()
    await expect(ctx.sshHostCredentials.load('web')).resolves.toEqual(login())
    expect(controller.list()).toEqual({ items: [{ record: { ...value.host.record }, open: true }] })
  })

  it('refuses an id a persisted record already holds', async () => {
    const { controller, registry } = await boot()
    await registry.save(record('web'))

    await expect(controller.add({ id: 'web', label: 'Again', login: login() })).rejects.toMatchObject({
      code: 'hosts/already-exists',
    })
    expect(registry.records()).toEqual([record('web')])
  })

  it('refuses an id an open realm already uses', async () => {
    const { ctx, controller, registry } = await boot()
    await registry.open({ id: brandString<RemoteHostId>('web'), label: 'Web', host: 'example.com', port: 2222, user: 'dev' })

    await expect(controller.add({ id: 'web', label: 'Again', login: login() })).rejects.toMatchObject({
      code: 'hosts/already-exists',
    })
    // The refusal comes before any write: no record went in, and the realm the
    // caller already held stayed open.
    expect(registry.records()).toEqual([])
    expect(ctx.remoteHosts.get(brandString<RemoteHostId>('web'))).toBeDefined()
  })

  it('removes the partial state and reports the outcome when the open fails', async () => {
    const { ctx, controller, registry } = await boot()
    vi.spyOn(registry, 'open').mockRejectedValueOnce(new Error('boom'))

    await expect(controller.add({ id: 'web', label: 'Web', login: login() })).rejects.toMatchObject({
      code: 'hosts/add-failed',
    })
    // The stored login and the record both come back with the failed realm.
    expect(registry.records()).toEqual([])
    await expect(ctx.sshHostCredentials.load('web')).resolves.toBeUndefined()
  })

  it('removes the stored login and the realm when persisting the record fails', async () => {
    const { ctx, controller, registry } = await boot()
    vi.spyOn(registry, 'save').mockRejectedValueOnce(new Error('disk full'))

    await expect(controller.add({ id: 'web', label: 'Web', login: login() })).rejects.toMatchObject({
      code: 'hosts/add-failed',
    })
    expect(registry.records()).toEqual([])
    expect(ctx.remoteHosts.get(brandString<RemoteHostId>('web'))).toBeUndefined()
    await expect(ctx.sshHostCredentials.load('web')).resolves.toBeUndefined()
  })
})

describe('connection checks', () => {
  it('checks a stored login through a discarded identity and returns the recorded keys', async () => {
    const { ctx, controller } = await boot({ hostKeys: ['example.com:2222 ssh-ed25519 AAAAkey'] })
    await controller.add({ id: 'web', label: 'Web', login: login() })

    const value = await controller.testConnection({ id: 'web' })

    expect(value).toEqual({ host: 'example.com', port: 2222, hostKeys: ['example.com:2222 ssh-ed25519 AAAAkey'] })
    // The check trusts the endpoint it reached, and nothing but that login
    // changed in the store.
    expect(scanned).toEqual([{ host: 'example.com', port: 2222 }])
    // The check wrote nothing to the store and closed nothing of the host's.
    await expect(ctx.sshHostCredentials.load('web')).resolves.toEqual(login())
    expect(ctx.remoteHosts.get(brandString<RemoteHostId>('web'))).toBeDefined()
  })

  it('refuses a host with no stored login material', async () => {
    const { controller } = await boot()

    await expect(controller.testConnection({ id: 'ghost' })).rejects.toMatchObject({
      code: 'hosts/unknown-host',
    })
  })
})

describe('removing a host', () => {
  it('closes the realm, deletes the record, and forgets the stored login', async () => {
    const { ctx, controller } = await boot()
    await controller.add({ id: 'web', label: 'Web', login: login() })

    await controller.remove({ id: 'web' })

    expect(ctx.remoteHosts.records()).toEqual([])
    expect(ctx.remoteHosts.get(brandString<RemoteHostId>('web'))).toBeUndefined()
    await expect(ctx.sshHostCredentials.load('web')).resolves.toBeUndefined()
    expect(controller.list()).toEqual({ items: [] })
    // A repeat removal resolves, so a client that retries is not punished.
    await expect(controller.remove({ id: 'web' })).resolves.toEqual({ removed: true })
  })
})

describe('the followed host list', () => {
  it('streams a baseline and an upsert for every durable add', async () => {
    const { ctx, controller, registry } = await boot()
    await registry.save(record('alpha'))
    const iterator = controller.follow(new AbortController().signal)[Symbol.asyncIterator]()

    expect(await nextFrame(iterator)).toEqual({
      type: 'baseline',
      value: { items: [closed(record('alpha'))] },
    })

    await controller.add({ id: 'bravo', label: 'Bravo', login: login({ host: 'bravo.example', port: 22, user: 'deploy' }) })
    const upsert = await nextFrame(iterator)
    expect(upsert).toEqual({
      type: 'upsert',
      host: {
        record: { id: 'bravo', label: 'Bravo', host: 'bravo.example', port: 22, user: 'deploy' },
        open: true,
      },
    })
    expect(ctx.remoteHosts.get(brandString<RemoteHostId>('bravo'))).toBeDefined()
  })

  it('emits a remove increment when the host leaves the registry', async () => {
    const { controller, registry } = await boot()
    await registry.save(record('alpha'))
    const iterator = controller.follow(new AbortController().signal)[Symbol.asyncIterator]()
    expect(await nextFrame(iterator)).toMatchObject({ type: 'baseline' })

    await controller.remove({ id: 'alpha' })
    expect(await nextFrame(iterator)).toEqual({ type: 'remove', hostId: 'alpha' })
  })
})

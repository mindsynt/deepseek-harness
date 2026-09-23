/**
 * The registry gives each host its own isolated service world, so two hosts
 * keep different values for `ssh`, `fs`, `subprocess` and `sandbox` while the
 * scope the registry is mounted on keeps its own. Provisioning delegates the
 * install to the mounted helper installer and opens the realm from its result.
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import type {
  ControlledSshIdentity,
  HostKeyEndpoint,
  RemoteHostLogin,
  SshHostCredentials,
} from '@deepseek-ai/dsh-host-credentials'
import type {
  HelperInstallRequest,
  HelperInstallation,
  SshHelperInstaller,
} from '@deepseek-ai/dsh-helper-installer'
import { describe, expect, it, onTestFinished } from 'vitest'
import { RemoteHostRegistryService } from '../src/index.ts'
import { mountStorage } from './helpers/storage.ts'
import type {
  RemoteHostComposition,
  RemoteHostId,
  RemoteHostLoginProvisionRequest,
  RemoteHostProvisionRequest,
  RemoteHostSpec,
} from '../src/index.ts'

/**
 * The service behind a context-traced proxy; every traced read returns a fresh proxy,
 * so only the original identifies a service.
 * @param value - a value read from a context, proxy or not.
 * @returns the underlying value the proxy wraps, or the value itself.
 */
function origin(value: unknown): unknown {
  return (value as Record<symbol, unknown>)[symbols.original]
}

/** Build one host spec with the given id and otherwise fixed coordinates. */
function hostSpec(id: string): RemoteHostSpec {
  return {
    id: brandString<RemoteHostId>(id),
    label: id,
    host: `host-${id}`,
    node: '/usr/bin/node',
    helper: '/opt/dsh/helper.js',
    helperHash: 'a'.repeat(64),
    workspace: '/workspace',
  }
}

/**
 * Composition mounting one host-private stub service per execution role.
 * @param disposals - collects the id of every host whose realm was released.
 * @returns the stub composition.
 */
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

/** Coordinates a fake install returns; every value differs from the request's. */
const INSTALLED: HelperInstallation = {
  node: '/usr/bin/node22',
  helper: '/installed/helper.js',
  helperHash: 'c'.repeat(64),
  workspace: '/installed-workspace',
}

/** Build one provisioning request with the given id and otherwise fixed coordinates. */
function provisionRequest(id: string): RemoteHostProvisionRequest {
  return {
    id: brandString<RemoteHostId>(id),
    label: `label-${id}`,
    host: `host-${id}`,
    root: `/opt/dsh-${id}`,
    workspace: `/workspace-${id}`,
    artifact: { archive: new Uint8Array([1, 2, 3]), entry: 'helper.js', digest: 'b'.repeat(64) },
  }
}

/** Entered login material every login-provisioning case uses. */
const LOGIN: RemoteHostLogin = {
  host: 'example.com',
  port: 2222,
  user: 'deploy',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----',
}

/** Build one login provisioning request with the given id and otherwise fixed coordinates. */
function loginRequest(id: string): RemoteHostLoginProvisionRequest {
  return {
    id: brandString<RemoteHostId>(id),
    label: `label-${id}`,
    login: LOGIN,
    root: `/opt/dsh-${id}`,
    workspace: `/workspace-${id}`,
    artifact: { archive: new Uint8Array([1, 2, 3]), entry: 'helper.js', digest: 'b'.repeat(64) },
  }
}

/**
 * Credentials service recording every call, returning one fixed identity, and
 * optionally failing host-key trust or identity removal.
 * @param options - failures to inject into trust and removal.
 * @returns the service, its identity, the recorded calls and the removal count.
 */
function fakeCredentials(options: { readonly trustFailure?: Error; readonly removalFailure?: Error } = {}) {
  const calls: string[] = []
  const materialized: RemoteHostLogin[] = []
  const trusted: { readonly identity: ControlledSshIdentity; readonly endpoint: HostKeyEndpoint }[] = []
  let removals = 0
  const identity: ControlledSshIdentity = {
    alias: 'dsh-0123456789abcdef',
    configPath: '/state/dsh-0123456789abcdef/config',
    directory: '/state/dsh-0123456789abcdef',
    knownHostsPath: '/state/dsh-0123456789abcdef/known_hosts',
    dispose: async () => {
      removals += 1
      calls.push('dispose')
      if (options.removalFailure !== undefined) throw options.removalFailure
    },
  }
  const credentials: SshHostCredentials = {
    materialize: async (login) => {
      calls.push('materialize')
      materialized.push(login)
      return identity
    },
    store: async () => { calls.push('store') },
    load: async () => { calls.push('load'); return undefined },
    forget: async () => { calls.push('forget') },
    pinHostKey: async () => { calls.push('pinHostKey') },
    trustFirstUse: async (subject, endpoint) => {
      calls.push('trustFirstUse')
      trusted.push({ identity: subject, endpoint })
      if (options.trustFailure !== undefined) throw options.trustFailure
    },
  }
  return { credentials, identity, calls, materialized, trusted, removals: () => removals }
}

/**
 * Installer recording every request, returning fixed coordinates or the given failure.
 * @param failure - error every `install` call throws instead of returning coordinates.
 * @returns the installer and the requests it received in order.
 */
function fakeInstaller(failure?: Error) {
  const requests: HelperInstallRequest[] = []
  const installer: SshHelperInstaller = {
    install: async (request) => {
      requests.push(request)
      if (failure !== undefined) throw failure
      return INSTALLED
    },
  }
  return { installer, requests }
}

/** Mount a root filesystem service plus the registry, and dispose both after the test. */
async function setup() {
  const ctx = new Context()
  await mountStorage(ctx)
  class RootFs extends Service {
    constructor(root: Context) { super(root, 'fs') }
  }
  const rootFiber = await ctx.plugin(RootFs)
  const disposals: string[] = []
  const registryFiber = await ctx.plugin(RemoteHostRegistryService, stubComposition(disposals))
  onTestFinished(async () => {
    await registryFiber.dispose()
    await rootFiber.dispose()
  })
  return { ctx, registry: ctx.remoteHosts, registryFiber, disposals }
}

/**
 * Build the registry with a directly injected installer and credentials, the
 * programmatic entry points `ctx.plugin` cannot reach, and dispose its context
 * after the test.
 * @param options - installer, credentials and composition the registry must use, if any.
 * @returns the context, the registry and the realm dispositions it recorded.
 */
async function setupInjected(options: {
  installer?: SshHelperInstaller
  credentials?: SshHostCredentials
  composition?: RemoteHostComposition
} = {}) {
  const ctx = new Context()
  await mountStorage(ctx)
  class RootFs extends Service {
    constructor(root: Context) { super(root, 'fs') }
  }
  await ctx.plugin(RootFs)
  const disposals: string[] = []
  const registry = new RemoteHostRegistryService(
    ctx,
    options.composition ?? stubComposition(disposals),
    options.installer,
    options.credentials,
  )
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, registry, disposals }
}

describe('remote host registry', () => {
  it('keeps an isolated service world per host without changing the root scope', async () => {
    const { ctx, registry } = await setup()
    const rootFs = origin(ctx.get('fs'))
    const first = await registry.open(hostSpec('alpha'))
    const second = await registry.open(hostSpec('beta'))
    expect(origin(first.world.ssh)).not.toBe(origin(second.world.ssh))
    expect(origin(first.world.fs)).not.toBe(origin(second.world.fs))
    expect(origin(first.world.subprocess)).not.toBe(origin(second.world.subprocess))
    expect(origin(first.world.sandbox)).not.toBe(origin(second.world.sandbox))
    expect(origin(first.world.fs)).not.toBe(rootFs)
    expect(origin(second.world.fs)).not.toBe(rootFs)
    expect(origin(ctx.get('fs'))).toBe(rootFs)
  })

  it('addresses open handles by id', async () => {
    const { registry } = await setup()
    const alpha = await registry.open(hostSpec('alpha'))
    const beta = await registry.open(hostSpec('beta'))
    expect(alpha.spec.id).toBe('alpha')
    expect(alpha.spec.host).toBe('host-alpha')
    expect(registry.get(alpha.spec.id)).toBe(alpha)
    expect(registry.get(beta.spec.id)).toBe(beta)
    expect(registry.get(brandString<RemoteHostId>('gamma'))).toBeUndefined()
    expect(registry.list()).toHaveLength(2)
    expect(registry.list()[0]).toBe(alpha)
    expect(registry.list()[1]).toBe(beta)
  })

  it('rejects a duplicate id and names it', async () => {
    const { registry } = await setup()
    await registry.open(hostSpec('alpha'))
    await expect(registry.open(hostSpec('alpha'))).rejects.toThrow('alpha')
  })

  it('admits one of two concurrent opens for the same id', async () => {
    const { registry } = await setup()
    const results = await Promise.allSettled([registry.open(hostSpec('alpha')), registry.open(hostSpec('alpha'))])
    const opened = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(opened).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const rejection = rejected[0] as PromiseRejectedResult
    expect((rejection.reason as Error).message).toContain('alpha')
    expect(registry.list()).toHaveLength(1)
  })

  it('releases the realm on close, once, however often close is called', async () => {
    const { registry, disposals } = await setup()
    const handle = await registry.open(hostSpec('alpha'))
    const id = handle.spec.id
    await Promise.all([registry.close(id), registry.close(id)])
    expect(disposals).toEqual(['alpha'])
    expect(registry.get(id)).toBeUndefined()
    await expect(handle.closed).resolves.toBeUndefined()
    await expect(registry.close(id)).resolves.toBeUndefined()
    expect(disposals).toEqual(['alpha'])
  })

  it('closes every open realm when the registry fiber is disposed', async () => {
    const { registry, registryFiber, disposals } = await setup()
    const alpha = await registry.open(hostSpec('alpha'))
    const beta = await registry.open(hostSpec('beta'))
    await registryFiber.dispose()
    expect([...disposals].sort()).toEqual(['alpha', 'beta'])
    await expect(alpha.closed).resolves.toBeUndefined()
    await expect(beta.closed).resolves.toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })

  it('provisions a host from the installer coordinates and the request identity', async () => {
    const { installer, requests } = fakeInstaller()
    const { ctx, registry } = await setupInjected({ installer })
    const request = provisionRequest('alpha')
    const handle = await registry.provision(request)
    expect(requests).toEqual([{
      host: request.host,
      root: request.root,
      workspace: request.workspace,
      artifact: request.artifact,
    }])
    expect(handle.spec).toEqual({
      id: request.id,
      label: request.label,
      host: request.host,
      node: INSTALLED.node,
      helper: INSTALLED.helper,
      helperHash: INSTALLED.helperHash,
      workspace: INSTALLED.workspace,
    })
    expect(origin(handle.world.fs)).not.toBe(origin(ctx.get('fs')))
    expect(handle.world.ssh).toBeDefined()
    expect(handle.world.subprocess).toBeDefined()
    expect(handle.world.sandbox).toBeDefined()
    expect(registry.get(request.id)).toBe(handle)
  })

  it('resolves a mounted installer through ctx.get without constructor injection', async () => {
    const { installer, requests } = fakeInstaller()
    const { ctx, registry } = await setupInjected({})
    ctx.provide('sshHelperInstaller', installer as never)
    const handle = await registry.provision(provisionRequest('alpha'))
    expect(requests).toHaveLength(1)
    expect(handle.spec.node).toBe(INSTALLED.node)
    expect(handle.spec.workspace).toBe(INSTALLED.workspace)
  })

  it('fails loud when no helper installer is reachable from its context', async () => {
    const { registry } = await setupInjected({})
    await expect(registry.provision(provisionRequest('alpha')))
      .rejects.toThrow('@deepseek-ai/dsh-helper-installer')
    expect(registry.list()).toHaveLength(0)
  })

  it('opens no realm and rethrows the installer error when the install fails', async () => {
    const failure = new Error('remote host install exploded')
    const { installer, requests } = fakeInstaller(failure)
    const { registry } = await setupInjected({ installer })
    await expect(registry.provision(provisionRequest('alpha'))).rejects.toBe(failure)
    expect(requests).toHaveLength(1)
    expect(registry.list()).toHaveLength(0)
  })

  it('rejects a duplicate provision before installing a second time', async () => {
    const { installer, requests } = fakeInstaller()
    const { registry } = await setupInjected({ installer })
    await registry.provision(provisionRequest('alpha'))
    await expect(registry.provision(provisionRequest('alpha'))).rejects.toThrow('remote host alpha is already open')
    expect(requests).toHaveLength(1)
    expect(registry.list()).toHaveLength(1)
  })
})

describe('remote host login provisioning', () => {
  it('materializes, trusts and installs through the identity, then opens its realm', async () => {
    const { installer, requests } = fakeInstaller()
    const fake = fakeCredentials()
    const { ctx, registry } = await setupInjected({ installer, credentials: fake.credentials })
    const request = loginRequest('alpha')
    const handle = await registry.provisionFromLogin(request)

    expect(fake.materialized).toEqual([request.login])
    expect(fake.trusted).toEqual([{
      identity: fake.identity,
      endpoint: { host: request.login.host, port: request.login.port },
    }])
    expect(requests).toEqual([{
      host: fake.identity.alias,
      root: request.root,
      workspace: request.workspace,
      artifact: request.artifact,
      sshConfigFile: fake.identity.configPath,
    }])
    expect(handle.spec).toEqual({
      id: request.id,
      label: request.label,
      host: fake.identity.alias,
      sshConfigFile: fake.identity.configPath,
      node: INSTALLED.node,
      helper: INSTALLED.helper,
      helperHash: INSTALLED.helperHash,
      workspace: INSTALLED.workspace,
    })
    expect(origin(handle.world.fs)).not.toBe(origin(ctx.get('fs')))
    expect(handle.world.ssh).toBeDefined()
    expect(handle.world.subprocess).toBeDefined()
    expect(handle.world.sandbox).toBeDefined()
    expect(registry.get(request.id)).toBe(handle)
    expect(fake.calls).toEqual(['materialize', 'trustFirstUse'])
  })

  it('never stores or loads the login material it is given', async () => {
    const { installer } = fakeInstaller()
    const fake = fakeCredentials()
    const { registry } = await setupInjected({ installer, credentials: fake.credentials })
    const handle = await registry.provisionFromLogin(loginRequest('alpha'))
    await handle.close()
    expect(fake.calls).toEqual(['materialize', 'trustFirstUse', 'dispose'])
  })

  it('owns the materialized identity and removes it once when the handle closes', async () => {
    const { installer } = fakeInstaller()
    const fake = fakeCredentials()
    const { registry } = await setupInjected({ installer, credentials: fake.credentials })
    const handle = await registry.provisionFromLogin(loginRequest('alpha'))
    await Promise.all([handle.close(), handle.close()])
    expect(fake.removals()).toBe(1)
    await expect(handle.closed).resolves.toBeUndefined()
    await expect(registry.close(handle.spec.id)).resolves.toBeUndefined()
    expect(fake.removals()).toBe(1)
    expect(registry.list()).toHaveLength(0)
  })

  it('removes the identity and opens no realm when host-key trust fails', async () => {
    const failure = new Error('ssh-keyscan example.com:2222 exited with code 1')
    const { installer, requests } = fakeInstaller()
    const fake = fakeCredentials({ trustFailure: failure })
    const { registry } = await setupInjected({ installer, credentials: fake.credentials })
    await expect(registry.provisionFromLogin(loginRequest('alpha'))).rejects.toBe(failure)
    expect(requests).toHaveLength(0)
    expect(fake.removals()).toBe(1)
    expect(registry.list()).toHaveLength(0)
  })

  it('removes the identity and opens no realm when the install fails', async () => {
    const failure = new Error('remote host install exploded')
    const { installer, requests } = fakeInstaller(failure)
    const fake = fakeCredentials()
    const { registry } = await setupInjected({ installer, credentials: fake.credentials })
    await expect(registry.provisionFromLogin(loginRequest('alpha'))).rejects.toBe(failure)
    expect(requests).toHaveLength(1)
    expect(fake.removals()).toBe(1)
    expect(registry.list()).toHaveLength(0)
    expect(registry.get(brandString<RemoteHostId>('alpha'))).toBeUndefined()
  })

  it('removes the identity and registers no handle when the composition fails', async () => {
    const failure = new Error('stub composition exploded')
    const { installer } = fakeInstaller()
    const fake = fakeCredentials()
    const { registry } = await setupInjected({
      installer,
      credentials: fake.credentials,
      composition: async () => { throw failure },
    })
    await expect(registry.provisionFromLogin(loginRequest('alpha'))).rejects.toBe(failure)
    expect(fake.removals()).toBe(1)
    expect(registry.list()).toHaveLength(0)
    expect(registry.get(brandString<RemoteHostId>('alpha'))).toBeUndefined()
  })

  it('reports a failed removal with the provisioning failure as its cause', async () => {
    const failure = new Error('remote host install exploded')
    const { installer } = fakeInstaller(failure)
    const fake = fakeCredentials({ removalFailure: new Error('identity directory is busy') })
    const { registry } = await setupInjected({ installer, credentials: fake.credentials })
    const rejected = await registry.provisionFromLogin(loginRequest('alpha')).catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toContain('identity directory is busy')
    expect((rejected as Error).cause).toBe(failure)
    expect(registry.list()).toHaveLength(0)
  })

  it('resolves mounted credentials through ctx.get without constructor injection', async () => {
    const { installer, requests } = fakeInstaller()
    const fake = fakeCredentials()
    const { ctx, registry } = await setupInjected({ installer })
    ctx.provide('sshHostCredentials', fake.credentials as never)
    const handle = await registry.provisionFromLogin(loginRequest('alpha'))
    expect(requests).toHaveLength(1)
    expect(requests[0]?.sshConfigFile).toBe(fake.identity.configPath)
    expect(handle.spec.host).toBe(fake.identity.alias)
  })

  it('fails loud when no credentials service is reachable from its context', async () => {
    const { installer } = fakeInstaller()
    const { registry } = await setupInjected({ installer })
    await expect(registry.provisionFromLogin(loginRequest('alpha')))
      .rejects.toThrow('@deepseek-ai/dsh-host-credentials')
    expect(registry.list()).toHaveLength(0)
  })
})

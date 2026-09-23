/**
 * The default host composition: a spec reduces to the SSH connection config
 * without inventing optional coordinates, a bare realm resolves exactly the
 * four execution services it provides, and `sshComposition` mounts the four
 * real providers into an isolated realm and resolves that realm's own
 * instances. The SSH client is exercised over a fake child process speaking
 * the helper protocol, so no real `ssh` runs.
 */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Context, symbols } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { SshConnection } from '@deepseek-ai/dsh-ssh'
import { SshRpcPeer } from '@deepseek-ai/dsh-ssh/protocol'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionConfig, resolveWorld } from '../src/composition.ts'
import { RemoteHostRegistryService } from '../src/index.ts'
import type { RemoteHostId, RemoteHostSpec, RemoteHostWorld } from '../src/index.ts'

/** Only `spawn` is replaced: the helper protocol runs over in-memory pipes. */
const transport = vi.hoisted(() => ({ spawn: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: transport.spawn as unknown as typeof actual.spawn }
})

/** Lowercase SHA-256 every fake helper reports. */
const HELPER_HASH = 'a'.repeat(64)
/** Lowercase SHA-256 of the preinstalled PTC bootstrap the fake helper reports. */
const BOOTSTRAP_HASH = 'b'.repeat(64)

/** Hello facts every fake helper answers with; `root` and `workspace` are canonicalized. */
const HELLO = {
  // Mirrors `@deepseek-ai/dsh-ssh`'s private `SSH_PROTOCOL_VERSION`.
  protocol: 2,
  hash: HELPER_HASH,
  platform: 'linux',
  nodeVersion: 'v24.19.0',
  node: '/canonical/node',
  root: '/tmp/remote-helper',
  workspace: '/canonical/workspace',
  bootstrapHash: BOOTSTRAP_HASH,
} as const

/** One host's complete coordinates, every optional field present. */
const FULL_SPEC: RemoteHostSpec = {
  id: brandString<RemoteHostId>('alpha'),
  label: 'Alpha',
  host: 'alpha.example',
  node: '/usr/bin/node',
  helper: '/opt/dsh/helper.js',
  helperHash: HELPER_HASH,
  workspace: '/workspace',
  sshConfigFile: '/etc/dsh/ssh_config',
  bootstrapPath: '/opt/dsh/process.js',
  bootstrapHash: BOOTSTRAP_HASH,
  requestTimeoutMs: 5000,
  maxFrameBytes: 65536,
  maxPending: 8,
  leaseMs: 30_000,
}

/**
 * The service behind a context-traced proxy; a plain provided value is its own origin.
 * @param value - a value read from a context, proxy or not.
 * @returns the underlying value the proxy wraps, or the value itself.
 */
function origin(value: unknown): unknown {
  return (value as Record<symbol, unknown>)[symbols.original] ?? value
}

/** One fake SSH child process with its helper-side protocol peer. */
interface FakeSsh {
  readonly child: Child
  readonly peer: SshRpcPeer
  readonly calls: { readonly method: string; readonly params: unknown }[]
}

/** The hello facts a helper with no configured bootstrap reports. */
const MINIMAL_HELLO = { ...HELLO, bootstrapHash: undefined }

/** In-memory SSH process: `kill` settles the child's `close` event. */
class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  closed = false
  kill(): boolean {
    if (!this.closed) {
      this.closed = true
      queueMicrotask(() => { this.emit('close', 0, null) })
    }
    return true
  }
}

/** Every fake child this file created, torn down after the test. */
const fakeSsh: FakeSsh[] = []
/** Every context this file mounted, disposed after the test. */
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const { child, peer } of fakeSsh.splice(0)) {
    peer.close()
    child.stderr.destroy()
    child.kill()
  }
  vi.restoreAllMocks()
  transport.spawn.mockReset()
})

/**
 * Spawn one fake helper answering the administrative handshake and disposal.
 * @param hello - hello facts the fake helper answers the handshake with.
 */
function spawnFakeSsh(hello: Record<string, unknown> = HELLO): void {
  transport.spawn.mockImplementationOnce(() => {
    const child = new Child()
    const calls: { method: string; params: unknown }[] = []
    const peer = new SshRpcPeer(child.stdin, child.stdout, 64 * 1024 * 1024, 128, async (method, params) => {
      calls.push({ method, params })
      if (method === 'hello') return hello
      if (method === 'close' || method === 'heartbeat') return null
      throw new Error(`unexpected helper request ${method}`)
    })
    fakeSsh.push({ child, peer, calls })
    return child
  })
}

/** Mount a registry whose default composition is the real `sshComposition`. */
function realRegistry(): RemoteHostRegistryService {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write', workspaceRoot: '/workspace' } as never)
  return new RemoteHostRegistryService(ctx)
}

describe('connectionConfig', () => {
  it('carries every optional coordinate the spec sets', () => {
    expect(connectionConfig(FULL_SPEC)).toEqual({
      host: 'alpha.example',
      node: '/usr/bin/node',
      helper: '/opt/dsh/helper.js',
      helperHash: HELPER_HASH,
      workspace: '/workspace',
      sshConfigFile: '/etc/dsh/ssh_config',
      bootstrapPath: '/opt/dsh/process.js',
      bootstrapHash: BOOTSTRAP_HASH,
      requestTimeoutMs: 5000,
      maxFrameBytes: 65536,
      maxPending: 8,
      leaseMs: 30_000,
    })
  })

  it('omits every optional key a minimal spec leaves unset', () => {
    const config = connectionConfig({
      id: brandString<RemoteHostId>('beta'),
      label: 'Beta',
      host: 'beta.example',
      node: '/usr/bin/node',
      helper: '/opt/dsh/helper.js',
      helperHash: HELPER_HASH,
      workspace: '/workspace',
    })
    expect(config).toEqual({
      host: 'beta.example',
      node: '/usr/bin/node',
      helper: '/opt/dsh/helper.js',
      helperHash: HELPER_HASH,
      workspace: '/workspace',
    })
    for (const key of ['sshConfigFile', 'bootstrapPath', 'bootstrapHash', 'requestTimeoutMs', 'maxFrameBytes', 'maxPending', 'leaseMs']) {
      expect(Object.hasOwn(config, key), key).toBe(false)
    }
  })
})

describe('resolveWorld', () => {
  it('returns exactly the four execution services a realm provides', () => {
    const ctx = new Context()
    const stubs = { ssh: { role: 'ssh' }, fs: { role: 'fs' }, subprocess: { role: 'subprocess' }, sandbox: { role: 'sandbox' } }
    for (const [name, stub] of Object.entries(stubs)) ctx.provide(name, stub as never)

    const world = resolveWorld(ctx)

    expect(Object.keys(world).sort()).toEqual(['fs', 'sandbox', 'ssh', 'subprocess'])
    expect(origin(world.ssh)).toBe(stubs.ssh)
    expect(origin(world.fs)).toBe(stubs.fs)
    expect(origin(world.subprocess)).toBe(stubs.subprocess)
    expect(origin(world.sandbox)).toBe(stubs.sandbox)
  })

  it.each(['ssh', 'fs', 'subprocess', 'sandbox'])('fails loud when the realm provides no %s', (missing) => {
    const ctx = new Context()
    for (const name of ['ssh', 'fs', 'subprocess', 'sandbox']) {
      if (name !== missing) ctx.provide(name, { role: name } as never)
    }
    expect(() => resolveWorld(ctx)).toThrow('remote host realm did not provide ssh, fs, subprocess and sandbox')
  })
})

describe('sshComposition', () => {
  it('mounts the four real providers into each host realm and resolves that realm own instances', async () => {
    spawnFakeSsh()
    spawnFakeSsh()
    const registry = realRegistry()

    const alpha = await registry.open(FULL_SPEC)
    const beta = await registry.open({ ...FULL_SPEC, id: brandString<RemoteHostId>('beta'), label: 'Beta' })

    for (const [host, handle] of [['alpha', alpha], ['beta', beta]] as const) {
      const world: RemoteHostWorld = handle.world
      expect(world.ssh, host).toBeDefined()
      expect(world.fs, host).toBeDefined()
      expect(world.subprocess, host).toBeDefined()
      expect(world.sandbox, host).toBeDefined()
    }
    // One realm per host: each realm mounts its own instance of every real provider.
    expect(origin(alpha.world.ssh)).toBeInstanceOf(SshConnection)
    expect(origin(alpha.world.fs)).toBeInstanceOf(SshFileSystem)
    expect(origin(alpha.world.subprocess)).toBeInstanceOf(SshSubprocessRuntime)
    expect(origin(alpha.world.sandbox)).toBeInstanceOf(SshSandboxProvider)
    expect(origin(alpha.world.ssh)).not.toBe(origin(beta.world.ssh))
    expect(origin(alpha.world.fs)).not.toBe(origin(beta.world.fs))
    expect(origin(alpha.world.subprocess)).not.toBe(origin(beta.world.subprocess))
    expect(origin(alpha.world.sandbox)).not.toBe(origin(beta.world.sandbox))
    // The fake helper received the deployment coordinates the composition built.
    expect(fakeSsh[0]?.calls[0]).toEqual({
      method: 'hello',
      params: {
        protocol: 2,
        workspace: '/workspace',
        leaseMs: 30_000,
        bootstrapPath: '/opt/dsh/process.js',
      },
    })
    // Two hosts, so two distinct SSH children, each with one `hello`.
    expect(transport.spawn).toHaveBeenCalledTimes(2)

    await Promise.all([alpha.close(), beta.close()])
    expect(registry.list()).toHaveLength(0)
  })

  it('mounts the four real providers for a minimal spec that omits every optional coordinate', async () => {
    spawnFakeSsh(MINIMAL_HELLO)
    const registry = realRegistry()
    const spec: RemoteHostSpec = {
      id: brandString<RemoteHostId>('gamma'),
      label: 'Gamma',
      host: 'gamma.example',
      node: '/usr/bin/node',
      helper: '/opt/dsh/helper.js',
      helperHash: HELPER_HASH,
      workspace: '/workspace',
    }

    const handle = await registry.open(spec)

    expect(handle.world.ssh).toBeDefined()
    expect(handle.world.fs).toBeDefined()
    expect(handle.world.subprocess).toBeDefined()
    expect(handle.world.sandbox).toBeDefined()
    expect(fakeSsh[0]?.calls[0]).toEqual({
      method: 'hello',
      params: { protocol: 2, workspace: '/workspace', leaseMs: 30_000 },
    })
  })
})

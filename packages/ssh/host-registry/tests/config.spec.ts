/**
 * Config-driven host declaration: one valid config provisions every declared
 * host from its artifact manifest, and every malformed config, manifest or
 * install fails loud instead of dropping a host.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  HelperInstallRequest,
  HelperInstallation,
  SshHelperInstaller,
} from '@deepseek-ai/dsh-helper-installer'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { declaredHosts, provisionDeclaredHosts } from '../src/config.ts'
import { apply, RemoteHostRegistryService } from '../src/index.ts'
import { mountStorage } from './helpers/storage.ts'
import type { Config, RemoteHostComposition, RemoteHostId, RemoteHostSpec } from '../src/index.ts'

/** Temporary directories created by one test, removed after it. */
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Create one temporary directory removed after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ssh-hosts-'))
  directories.push(dir)
  return dir
}

/**
 * Write one artifact manifest and, when the bytes are given and the manifest
 * names a plain file, that archive beside it.
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
  if (bytes !== undefined && !archive.includes('/') && !archive.includes('\\') && archive !== '.' && archive !== '..') {
    await writeFile(join(dir, archive), Uint8Array.from(bytes))
  }
  return path
}

/** Coordinates a fake install returns; every value differs from the request's. */
const INSTALLED: HelperInstallation = {
  node: '/usr/bin/node22',
  helper: '/installed/helper.js',
  helperHash: 'c'.repeat(64),
  workspace: '/installed-workspace',
}

/**
 * Composition mounting one host-private stub service per execution role.
 * @returns the stub composition.
 */
function stubComposition(): RemoteHostComposition {
  return async (realm, host) => {
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
      throw new Error(`stub composition did not provide every execution service for ${host.id}`)
    }
    return { ssh, fs, subprocess, sandbox }
  }
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

/**
 * Mount a root filesystem service plus a registry built with the injected fakes.
 * @param installer - installer the registry provisions through.
 * @returns the context and the registry.
 */
async function setupRegistry(installer: SshHelperInstaller) {
  const ctx = new Context()
  class RootFs extends Service {
    constructor(root: Context) { super(root, 'fs') }
  }
  await ctx.plugin(RootFs)
  const registry = new RemoteHostRegistryService(ctx, stubComposition(), installer)
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, registry }
}

/**
 * Validate a config and provision each declared host through the registry.
 * @param registry - registry the hosts provision through.
 * @param config - the declared hosts.
 * @returns a promise settling once every declared host is open.
 */
async function provision(registry: RemoteHostRegistryService, config: Config): Promise<void> {
  await provisionDeclaredHosts(registry, declaredHosts(config))
}

describe('configured remote hosts', () => {
  it('provisions every declared host from its manifest, using the plugin-level manifest when an entry omits one', async () => {
    const dir = await tempDir()
    const alphaManifest = await writeArtifact(dir, 'alpha.json', { entry: 'alpha.js', digest: '1'.repeat(64), archive: 'alpha.tar.gz' }, [1, 2, 3])
    const betaManifest = await writeArtifact(dir, 'beta.json', { entry: 'beta.js', digest: '2'.repeat(64), archive: 'beta.tar.gz' }, [4, 5])
    const { installer, requests } = fakeInstaller()
    const { registry } = await setupRegistry(installer)

    await provision(registry, {
      manifest: betaManifest,
      hosts: [
        { id: 'alpha', label: 'Alpha', host: 'alpha.example', root: '/opt/dsh', workspace: '/work', manifest: alphaManifest },
        { id: 'beta', host: 'beta.example', root: '/srv/dsh', workspace: '/srv/work' },
      ],
    })

    expect(requests).toEqual([
      {
        host: 'alpha.example',
        root: '/opt/dsh',
        workspace: '/work',
        artifact: { archive: Uint8Array.from([1, 2, 3]), entry: 'alpha.js', digest: '1'.repeat(64) },
      },
      {
        host: 'beta.example',
        root: '/srv/dsh',
        workspace: '/srv/work',
        artifact: { archive: Uint8Array.from([4, 5]), entry: 'beta.js', digest: '2'.repeat(64) },
      },
    ])
    const handles = registry.list()
    expect(handles.map(handle => handle.spec.id)).toEqual(['alpha', 'beta'])
    expect(handles[0]?.spec).toEqual({
      id: 'alpha',
      label: 'Alpha',
      host: 'alpha.example',
      node: INSTALLED.node,
      helper: INSTALLED.helper,
      helperHash: INSTALLED.helperHash,
      workspace: INSTALLED.workspace,
    })
    expect(handles[1]?.spec.label).toBe('beta')
    expect(registry.get(handles[1]!.spec.id)).toBe(handles[1])
  })

  it('opens no host and calls no install when the config declares none', async () => {
    const { installer, requests } = fakeInstaller()
    const ctx = new Context()
    await mountStorage(ctx)
    ctx.provide('sshHelperInstaller', installer as never)
    // `apply` reaches the credentials store for startup recovery; an empty
    // record table must leave that store untouched.
    const load = vi.fn(async () => undefined)
    ctx.provide('sshHostCredentials', { load } as never)
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await apply(ctx, { manifest: '/nonexistent/manifest.json' })
    expect(requests).toHaveLength(0)
    expect(load).not.toHaveBeenCalled()
    expect(ctx.remoteHosts.list()).toHaveLength(0)
    expect(ctx.remoteHosts.records()).toEqual([])
  })

  it('fails loud when no credentials service is reachable for startup recovery', async () => {
    const { installer, requests } = fakeInstaller()
    const ctx = new Context()
    await mountStorage(ctx)
    ctx.provide('sshHelperInstaller', installer as never)
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await expect(apply(ctx, { manifest: '/nonexistent/manifest.json' }))
      .rejects.toThrow('sshHostCredentials is unavailable for startup recovery')
    expect(requests).toHaveLength(0)
  })

  it('fails loud when the mounted registry service is unavailable', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    // Without `storageDomain` the registry fiber stays pending, so `remoteHosts`
    // is absent from the context instead of half-mounted.
    await expect(apply(ctx, {})).rejects.toThrow('the mounted service is unavailable')
  })

  it('rejects a host entry that omits a required path', () => {
    const entry = { id: 'alpha', host: 'a.example', workspace: '/work' }
    expect(() => declaredHosts({ manifest: '/manifests/default.json', hosts: [entry as never] }))
      .toThrow('hosts[0].root is required; every host needs an absolute path')
    const other = { id: 'alpha', host: 'a.example', root: '/opt' }
    expect(() => declaredHosts({ manifest: '/manifests/default.json', hosts: [other as never] }))
      .toThrow('hosts[0].workspace is required; every host needs an absolute path')
  })

  it('rejects a malformed config before any host opens, naming the field and value', async () => {
    const { installer, requests } = fakeInstaller()
    const { registry } = await setupRegistry(installer)
    const base = { manifest: '/manifests/default.json' }
    const invalid: [Config, string][] = [
      [{ ...base, hosts: [{ id: 'alpha', host: 'bad host', root: '/opt', workspace: '/work' }] }, 'hosts[0].host'],
      [{ ...base, hosts: [{ id: 'alpha', host: 'a.example', root: 'relative', workspace: '/work' }] }, 'hosts[0].root'],
      [{ ...base, hosts: [{ id: 'alpha', host: 'a.example', root: '/opt', workspace: 'work' }] }, 'hosts[0].workspace'],
      [{ ...base, hosts: [{ id: 'alpha', host: 'a.example', root: '/opt', workspace: '/work', manifest: 'manifests/a.json' }] }, 'hosts[0].manifest'],
      [{ hosts: [{ id: 'alpha', host: 'a.example', root: '/opt', workspace: '/work', manifest: 'manifests/a.json' }] }, 'manifest'],
      [{ ...base, hosts: [{ id: 'a/b', host: 'a.example', root: '/opt', workspace: '/work' }] }, 'hosts[0].id'],
      [{ ...base, hosts: [{ id: '', host: 'a.example', root: '/opt', workspace: '/work' }] }, 'hosts[0].id'],
      [
        {
          ...base,
          hosts: [
            { id: 'alpha', host: 'a.example', root: '/opt', workspace: '/work' },
            { id: 'alpha', host: 'b.example', root: '/opt', workspace: '/work' },
          ],
        },
        'hosts[1].id',
      ],
      [{ hosts: [{ id: 'alpha', host: 'a.example', root: '/opt', workspace: '/work' }] }, 'manifest'],
    ]
    for (const [config, expected] of invalid) {
      expect(() => declaredHosts(config), JSON.stringify(config)).toThrow(expected)
    }
    expect(requests).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })

  it('rejects a malformed artifact manifest, naming the manifest path and the field', async () => {
    const dir = await tempDir()
    const config: Config = { hosts: [{ id: 'alpha', host: 'a.example', root: '/opt', workspace: '/work' }] }
    const bad: [string, { entry?: string; digest?: string; archive?: string }, string][] = [
      ['digest.json', { digest: 'A'.repeat(64) }, "'digest'"],
      ['short.json', { digest: 'a'.repeat(63) }, "'digest'"],
      ['absolute.json', { archive: '/tmp/helper.tar.gz' }, "'archive'"],
      ['traversal.json', { archive: '../escape.tar.gz' }, "'archive'"],
      ['entry.json', { entry: '' }, "'entry'"],
    ]
    for (const [name, manifest, expected] of bad) {
      const path = await writeArtifact(dir, name, manifest, [1])
      const { installer, requests } = fakeInstaller()
      const { registry } = await setupRegistry(installer)
      const overridden: Config = { hosts: config.hosts ?? [], manifest: path }
      await expect(provision(registry, overridden), name).rejects.toThrow(expected)
      await expect(provision(registry, overridden), name).rejects.toThrow(path)
      expect(requests, name).toHaveLength(0)
      expect(registry.list(), name).toHaveLength(0)
    }
  })

  it('fails loud on a manifest that is not JSON or not a JSON object, naming the manifest path', async () => {
    const dir = await tempDir()
    const { installer, requests } = fakeInstaller()
    const { registry } = await setupRegistry(installer)
    const withManifest = (manifest: string): Config => ({
      hosts: [{ id: 'alpha', host: 'a.example', root: '/opt', workspace: '/work' }],
      manifest,
    })

    const broken = join(dir, 'broken.json')
    await writeFile(broken, 'not json at all')
    await expect(provision(registry, withManifest(broken))).rejects.toThrow(broken)
    await expect(provision(registry, withManifest(broken))).rejects.toThrow('is not valid JSON')

    // A syntactically valid JSON document that is not an object: a number, a
    // string, an array or `null` all fail the same named check.
    for (const [name, text] of [['number.json', '42'], ['string.json', '"x"'], ['array.json', '[]'], ['null.json', 'null']] as const) {
      const path = join(dir, name)
      await writeFile(path, text)
      await expect(provision(registry, withManifest(path)), name).rejects.toThrow(path)
      await expect(provision(registry, withManifest(path)), name).rejects.toThrow('must be a JSON object')
    }
    expect(requests).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })

  it('fails loud on a missing manifest file and a missing archive', async () => {
    const dir = await tempDir()
    const { installer, requests } = fakeInstaller()
    const { registry } = await setupRegistry(installer)
    const config: Config = { manifest: join(dir, 'absent.json'), hosts: [{ id: 'alpha', host: 'a.example', root: '/opt', workspace: '/work' }] }
    await expect(provision(registry, config)).rejects.toThrow('absent.json')

    const orphan = await writeArtifact(dir, 'orphan.json', { archive: 'missing.tar.gz' })
    const overridden: Config = { hosts: config.hosts ?? [], manifest: orphan }
    await expect(provision(registry, overridden)).rejects.toThrow('missing.tar.gz')
    expect(requests).toHaveLength(0)
    expect(registry.list()).toHaveLength(0)
  })

  it('stops at the first failed install, naming the host and its manifest, and opens nothing', async () => {
    const dir = await tempDir()
    const failure = new Error('remote install exploded')
    const alpha = await writeArtifact(dir, 'alpha.json', {}, [1])
    const beta = await writeArtifact(dir, 'beta.json', {}, [2])
    const { installer, requests } = fakeInstaller(failure)
    const { registry } = await setupRegistry(installer)
    const config: Config = {
      hosts: [
        { id: 'alpha', host: 'a.example', root: '/opt', workspace: '/work', manifest: alpha },
        { id: 'beta', host: 'b.example', root: '/opt', workspace: '/work', manifest: beta },
      ],
    }
    const error = await provision(registry, config).then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain("'alpha'")
    expect(error?.message).toContain(alpha)
    expect(requests).toHaveLength(1)
    expect(registry.list()).toHaveLength(0)
  })

  it('reports a provisioning failure that is not an Error by its string form', async () => {
    const dir = await tempDir()
    const manifest = await writeArtifact(dir, 'alpha.json', {}, [1])
    const { installer } = fakeInstaller('plain failure' as unknown as Error)
    const { registry } = await setupRegistry(installer)
    const rejected = await provision(registry, {
      hosts: [{ id: 'alpha', host: 'a.example', root: '/opt', workspace: '/work', manifest }],
    }).then(() => undefined, (error: unknown) => error as Error)
    expect(rejected?.message).toContain("'alpha'")
    expect(rejected?.message).toContain(manifest)
    expect(rejected?.message).toContain('plain failure')
    expect(registry.list()).toHaveLength(0)
  })

  it('brands each declared id as a remote host id', async () => {
    const dir = await tempDir()
    const manifest = await writeArtifact(dir, 'alpha.json', {}, [1])
    const declared = declaredHosts({ manifest, hosts: [{ id: 'alpha', host: 'a.example', root: '/opt', workspace: '/work' }] })
    const id: RemoteHostId = declared[0]!.id
    expect(id).toBe('alpha')
  })

  it('carries every declared field into the composition spec', async () => {
    const dir = await tempDir()
    const manifest = await writeArtifact(dir, 'alpha.json', {}, [1])
    const specs: RemoteHostSpec[] = []
    const installer: SshHelperInstaller = { install: async () => INSTALLED }
    const ctx = new Context()
    class RootFs extends Service {
      constructor(root: Context) { super(root, 'fs') }
    }
    await ctx.plugin(RootFs)
    const registry = new RemoteHostRegistryService(ctx, async (realm, host) => {
      specs.push(host)
      return stubComposition()(realm, host)
    }, installer)
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await provision(registry, { hosts: [{ id: 'alpha', host: 'a.example', root: '/opt/dsh', workspace: '/work', manifest }] })
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({
      id: 'alpha',
      label: 'alpha',
      host: 'a.example',
      node: INSTALLED.node,
      helper: INSTALLED.helper,
      helperHash: INSTALLED.helperHash,
      workspace: INSTALLED.workspace,
    })
  })
})

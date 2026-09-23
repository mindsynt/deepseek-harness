/**
 * Real-composition guard for the bundle's patch: a test-only `cordis.yml`
 * mounts the credentials provider and the storage stack the registry's
 * `storageDomain` injection needs, the bundle's own `cordis.patch.yml`
 * supplies the four bundle rows through the actual Loader + Include path, and
 * the registry and controller fibers must reach `ACTIVE` with no host opened.
 * Booting the same
 * tree without the `ssh-host-credentials` row must leave `remoteHosts`
 * unavailable, because a missing injection is a silent non-activation and that
 * is the failure this test exists to turn observable.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState, type Fiber } from '@deepseek-ai/cordis'
import Include, { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import * as LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import * as HelperInstaller from '@deepseek-ai/dsh-helper-installer'
import { SshHelperInstallerService } from '@deepseek-ai/dsh-helper-installer'
import * as HostCredentials from '@deepseek-ai/dsh-host-credentials'
import { SshHostCredentialsService } from '@deepseek-ai/dsh-host-credentials'
import * as HostsControllerModule from '@deepseek-ai/dsh-hosts-controller'
import { HostsController } from '@deepseek-ai/dsh-hosts-controller'
import * as HostRegistry from '@deepseek-ai/dsh-ssh-host-registry'
import { RemoteHostRegistryService } from '@deepseek-ai/dsh-ssh-host-registry'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'

/** Child-process calls a hermetic composition must never make. */
const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: childProcess.spawn as unknown as typeof actual.spawn }
})

/** The four row ids the shipped patch inserts, in file order. */
const SHIPPED_ROWS = ['ssh-host-registry', 'ssh-helper-installer', 'ssh-host-credentials', 'ssh-hosts-controller'] as const

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  childProcess.spawn.mockClear()
})

/**
 * Read the shipped patch file as Loader patch layers.
 * @returns the parsed patch list of this bundle.
 * @throws when the file does not parse to a patch list.
 */
async function shippedPatch(): Promise<PatchOptions[]> {
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const parsed = yaml.load(text, { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('ssh-hosts patch must parse to a patch list')
  return parsed as PatchOptions[]
}

/**
 * Remove the named rows from every insert layer, modelling a deployment layer
 * that dropped one row from the bundle.
 * @param layers - the parsed patch list.
 * @param omit - row ids to drop.
 * @returns a detached patch list without those rows.
 */
function withoutRows(layers: readonly PatchOptions[], omit: readonly string[]): PatchOptions[] {
  return layers.map(layer => layer.insert === undefined
    ? layer
    : { ...layer, insert: layer.insert.filter(row => row.id === undefined || !omit.includes(row.id)) })
}

/**
 * Boot the shipped patch over a test-only root tree through the real Loader.
 * The tree mounts only the credentials provider, with its document kept inside
 * the temporary root and its watcher off; the four bundle rows come from the
 * bundle's own patch file.
 * @param omit - row ids removed from the shipped patch.
 * @returns the loaded root context, owned by this file's `afterEach`.
 */
async function loadShippedPatch(omit: readonly string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ssh-hosts-composition-'))
  vi.stubEnv('DSH_HOME', root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: storage',
    "  name: '@deepseek-ai/dsh-storage'",
    '- id: storage-json',
    "  name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storages'))}`,
    '- id: storage-domain',
    "  name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    watch: false',
    '',
  ].join('\n'))

  const patches = withoutRows(await shippedPatch(), omit)
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-helper-installer', HelperInstaller],
    ['@deepseek-ai/dsh-host-credentials', HostCredentials],
    ['@deepseek-ai/dsh-ssh-host-registry', HostRegistry],
    ['@deepseek-ai/dsh-hosts-controller', HostsControllerModule],
  ])
  // The custom importer bypasses Node resolution; the tree names exactly the
  // eight packages a profile installs beside this bundle: the storage stack the
  // registry's declared `storageDomain` injection needs and the four SSH rows.
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href, patches },
  })
  await ctx.loader.await()
  return ctx
}

/**
 * The fiber the Loader tracks for one entry id.
 * @param ctx - the loaded root context.
 * @param id - the Loader entry id.
 * @returns that entry's fiber.
 * @throws when the entry or its fiber is absent from the composition.
 */
function entryFiber(ctx: Context, id: string): Fiber {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
  if (entry === undefined) throw new Error(`Loader entry '${id}' is missing from the composition`)
  if (entry.fiber === undefined) throw new Error(`Loader entry '${id}' has no fiber`)
  return entry.fiber
}

describe('dsh-ssh-hosts real Loader composition', () => {
  it('activates the registry from the shipped patch once both injected services are mounted', async () => {
    const rows = (await shippedPatch()).flatMap(layer => layer.insert ?? [])
    // Guard against a vacuous composition: the file this test boots must be
    // the shipped four-row insert.
    expect(rows.map(row => row.id)).toEqual([...SHIPPED_ROWS])
    const installSpy = vi.spyOn(SshHelperInstallerService.prototype, 'install')

    const ctx = await loadShippedPatch()

    expect(ctx.get('sshHelperInstaller')).toBeInstanceOf(SshHelperInstallerService)
    expect(ctx.get('sshHostCredentials')).toBeInstanceOf(SshHostCredentialsService)
    expect(entryFiber(ctx, 'ssh-helper-installer').state).toBe(FiberState.ACTIVE)
    expect(entryFiber(ctx, 'ssh-host-credentials').state).toBe(FiberState.ACTIVE)
    // `loader.await()` settles every row with `allSettled`, so a row whose
    // plugin throws reports neither a rejection nor a log line here; awaiting
    // the fiber keeps the activation error in the assertion message.
    const registry = entryFiber(ctx, 'ssh-host-registry')
    const activation = await registry.await().then(() => 'settled', (error: unknown) => String(error))
    expect(registry.state, `ssh-host-registry activation: ${activation}`).toBe(FiberState.ACTIVE)
    expect(ctx.get('remoteHosts')).toBeInstanceOf(RemoteHostRegistryService)
    // `hosts: []` opens nothing: the registry is active but empty, no helper
    // install ran, and no `ssh` process was spawned.
    expect(ctx.get('remoteHosts')!.list()).toEqual([])
    const controller = entryFiber(ctx, 'ssh-hosts-controller')
    const controllerActivation = await controller.await().then(() => 'settled', (error: unknown) => String(error))
    expect(controller.state, `ssh-hosts-controller activation: ${controllerActivation}`).toBe(FiberState.ACTIVE)
    expect(ctx.get('hostsController')).toBeInstanceOf(HostsController)
    expect(installSpy).not.toHaveBeenCalled()
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })

  it('leaves the registry fiber inactive, without a load error, when the credentials row is missing', async () => {
    const ctx = await loadShippedPatch(['ssh-host-credentials'])

    // The rows that remain are mounted and serving.
    expect(ctx.get('sshHelperInstaller')).toBeInstanceOf(SshHelperInstallerService)
    expect(ctx.get('sshHostCredentials')).toBeUndefined()
    // The unsatisfied injection is silent at the Loader: no throw, no
    // `remoteHosts`, and the registry fiber never reaches ACTIVE.
    expect(ctx.get('remoteHosts')).toBeUndefined()
    const registry = entryFiber(ctx, 'ssh-host-registry')
    expect(registry.state).toBe(FiberState.PENDING)
    expect(registry.state).not.toBe(FiberState.ACTIVE)
    expect(entryFiber(ctx, 'ssh-helper-installer').state).toBe(FiberState.ACTIVE)
    // The controller injects the same missing service, so it stays pending too.
    expect(entryFiber(ctx, 'ssh-hosts-controller').state).toBe(FiberState.PENDING)
    // `loader.await()` resolved and nothing is still pending, so a caller has
    // no later signal to observe either.
    expect(ctx.loader.getTasks()).toEqual([])
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
})

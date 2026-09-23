/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list that adds the SSH host rows
 * without touching the local execution providers.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

/** One Loader row read from the parsed patch list. */
interface PatchRow {
  readonly id?: string
  readonly name?: string
  readonly config?: Record<string, unknown>
}

/** One parsed patch layer. */
interface PatchLayer {
  readonly insert?: readonly PatchRow[]
  readonly id?: string
}

/** The manifest fields this bundle's test inspects. */
interface Manifest {
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly dsh?: { readonly bundle?: { readonly patch?: string } }
}

/** The bundle directory holding this test's fixtures. */
const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Read and parse this bundle's patch file.
 * @returns the parsed patch list.
 */
function parsedPatch(): PatchLayer[] {
  const parsed = yaml.load(
    readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError('ssh-hosts patch must parse to a patch list')
  return parsed as PatchLayer[]
}

/** Read this bundle's package manifest. */
function manifest(): Manifest {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest
}

describe('dsh-ssh-hosts module', () => {
  it('exposes no runtime API beyond the patch file', async () => {
    const module = await import('../src/index.ts')
    expect(Object.keys(module)).toEqual([])
  })
})

describe('dsh-ssh-hosts bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const pkg = manifest()
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const layers = parsedPatch()
    expect(layers).toHaveLength(1)
    const rows = layers.flatMap(layer => layer.insert ?? [])
    expect(rows).toHaveLength(4)
    expect(rows.map(row => row.id)).toEqual([
      'ssh-host-registry',
      'ssh-helper-installer',
      'ssh-host-credentials',
      'ssh-hosts-controller',
    ])
    expect(rows.map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-ssh-host-registry',
      '@deepseek-ai/dsh-helper-installer',
      '@deepseek-ai/dsh-host-credentials',
      '@deepseek-ai/dsh-hosts-controller',
    ])
    expect(rows[0]?.config).toEqual({
      manifest: { __jsExpr: 'process.env.DSH_SSH_HELPER_MANIFEST' },
      hosts: [],
    })
    // The credentials row relies on its derived `<DSH home>/ssh-hosts` default,
    // so it must stay config-free for a deployment that configures nothing.
    expect(rows[1]?.config).toBeUndefined()
    expect(rows[2]?.config).toBeUndefined()
    // The controller reads the registry and the credential store it injects, so
    // it carries no config of its own either.
    expect(rows[3]?.config).toBeUndefined()
  })

  it('layers no local filesystem, subprocess or sandbox row', () => {
    const layers = parsedPatch()
    // One insert layer only: nothing here targets an existing base row by id,
    // so the local execution providers stay exactly as dsh-base composed them.
    expect(layers.every(layer => layer.id === undefined)).toBe(true)
    const rows = layers.flatMap(layer => layer.insert ?? [])
    const local = rows.filter(row => /^(fs|subprocess|sandbox)(-|$)/.test(row.id ?? ''))
    expect(local).toEqual([])
    expect(rows.some(row => row.name === '@deepseek-ai/dsh-fs-local')).toBe(false)
    expect(rows.some(row => row.name === '@deepseek-ai/dsh-subprocess-local')).toBe(false)
    expect(rows.some(row => row.name === '@deepseek-ai/dsh-sandbox-local')).toBe(false)
  })

  it('depends on the patched packages and every provider the registry mounts', () => {
    const pkg = manifest()
    expect(pkg.dependencies).toMatchObject({
      '@deepseek-ai/dsh-ssh-host-registry': 'workspace:^',
      '@deepseek-ai/dsh-helper-installer': 'workspace:^',
      '@deepseek-ai/dsh-host-credentials': 'workspace:^',
      '@deepseek-ai/dsh-hosts-controller': 'workspace:^',
      '@deepseek-ai/dsh-ssh': 'workspace:^',
      '@deepseek-ai/dsh-fs-ssh': 'workspace:^',
      '@deepseek-ai/dsh-subprocess-ssh': 'workspace:^',
      '@deepseek-ai/dsh-sandbox-ssh': 'workspace:^',
    })
    expect(pkg.peerDependencies).toHaveProperty('@deepseek-ai/cordis', 'workspace:^')
    expect(pkg.devDependencies).toHaveProperty('@deepseek-ai/cordis', 'workspace:^')
  })
})

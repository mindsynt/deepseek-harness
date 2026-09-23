/**
 * Dependency-closure collection, deterministic archive packing, manifest
 * writing, and rejection of unsafe archives. Every fixture package is created
 * in an OS temporary directory and removed after each test; nothing reads the
 * repository tree or the network.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { collectHelperClosure, packHelperArtifact, readTarEntryNames, writeHelperArtifact } from '../src/index.ts'

const roots: string[] = []

/**
 * Create one temporary fixture root that the suite removes after each test.
 * @returns the absolute fixture root.
 */
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-helper-artifact-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * Write one fixture file, creating its parent directories.
 * @param root - fixture root.
 * @param path - fixture-relative path.
 * @param content - file contents.
 */
async function writeFixture(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

/**
 * List every file under a directory as `/`-separated relative paths.
 * @param root - directory to walk.
 * @param prefix - current relative prefix.
 * @returns sorted relative file paths.
 */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(root, path))
    else files.push(path)
  }
  return files.sort()
}

/**
 * Build the main fixture graph: an ESM app with a reachable relative file, a
 * bare dependency chain, an unreachable file, and a CommonJS package with data.
 * @returns the fixture root and its absolute entry file.
 */
async function mainFixture(): Promise<{ root: string; entryFile: string }> {
  const root = await temporaryRoot()
  const files = {
    'node_modules/@fixture/app/package.json': JSON.stringify({ name: '@fixture/app', type: 'module', exports: { '.': './lib/entry.js' } }),
    'node_modules/@fixture/app/lib/entry.js': "import { used } from './used.js'\nimport '@fixture/dep'\nimport '@fixture/commonjs-pkg'\nexport const entry = used\n",
    'node_modules/@fixture/app/lib/used.js': 'export const used = 1\n',
    'node_modules/@fixture/app/lib/unused.js': "import '@fixture/unused-dep'\nexport const unused = 2\n",
    'node_modules/@fixture/dep/package.json': JSON.stringify({ name: '@fixture/dep', type: 'module', exports: { '.': './index.js' } }),
    'node_modules/@fixture/dep/index.js': "import '@fixture/leaf'\nexport const dep = 1\n",
    'node_modules/@fixture/leaf/package.json': JSON.stringify({ name: '@fixture/leaf', type: 'module', exports: { '.': './index.js' } }),
    'node_modules/@fixture/leaf/index.js': 'export const leaf = 1\n',
    'node_modules/@fixture/unused-dep/package.json': JSON.stringify({ name: '@fixture/unused-dep', type: 'module', exports: { '.': './index.js' } }),
    'node_modules/@fixture/unused-dep/index.js': 'export const unusedDep = 1\n',
    'node_modules/@fixture/commonjs-pkg/package.json': JSON.stringify({ name: '@fixture/commonjs-pkg', type: 'commonjs', main: 'index.js' }),
    'node_modules/@fixture/commonjs-pkg/index.js': "module.exports = { data: require('./data.json'), extra: require('./extra.js') }\n",
    'node_modules/@fixture/commonjs-pkg/data.json': '{"value":1}\n',
    'node_modules/@fixture/commonjs-pkg/extra.js': 'module.exports = 2\n',
    'node_modules/@fixture/commonjs-pkg/index.js.map': '{}\n',
    'node_modules/@fixture/commonjs-pkg/types.d.ts': 'export declare const value: number\n',
    'node_modules/@fixture/commonjs-pkg/tests/skipped.js': 'module.exports = 3\n',
  }
  for (const [path, content] of Object.entries(files)) await writeFixture(root, path, content)
  return { root, entryFile: join(root, 'node_modules/@fixture/app/lib/entry.js') }
}

/**
 * Build one valid ustar header with a caller-chosen name and type flag.
 * @param name - entry name.
 * @param type - type flag character.
 * @returns the 512-byte header.
 */
function customHeader(name: string, type: string): Buffer {
  return syntheticHeader({ name, type })
}

/** One header field a case may override; every omitted field keeps its regular-file value. */
interface HeaderFields {
  readonly name?: string
  readonly type?: string
  readonly size?: string
  readonly magic?: string
  readonly checksum?: string
}

/**
 * Compute the octal checksum field of one header whose checksum bytes still read as spaces.
 * @param header - header bytes with `0x20` in the checksum field.
 * @returns the eight-byte checksum field.
 */
function checksumField(header: Buffer): string {
  let sum = 0
  for (const byte of header) sum += byte
  return `${sum.toString(8).padStart(6, '0')}\0 `
}

/**
 * Build one 512-byte ustar header so a case can vary exactly one field.
 * @param fields - field overrides; the checksum is computed unless one is supplied.
 * @returns the header bytes.
 */
function syntheticHeader(fields: HeaderFields = {}): Buffer {
  const header = Buffer.alloc(512)
  header.write(fields.name ?? 'entry.js', 0, 100, 'latin1')
  header.write('0000644\0', 100, 8, 'latin1')
  header.write('0000000\0', 108, 8, 'latin1')
  header.write('0000000\0', 116, 8, 'latin1')
  header.write(fields.size ?? '00000000000\0', 124, 12, 'latin1')
  header.write('00000000000\0', 136, 12, 'latin1')
  header.fill(0x20, 148, 156)
  header[156] = (fields.type ?? '0').charCodeAt(0)
  header.write(fields.magic ?? 'ustar', 257, 6, 'latin1')
  header.write('00', 263, 2, 'latin1')
  header.write(fields.checksum ?? checksumField(header), 148, 8, 'latin1')
  return header
}

/**
 * Write one package directory: its manifest and every listed file.
 * @param root - fixture root.
 * @param directory - fixture-relative package directory.
 * @param manifest - complete package manifest.
 * @param files - package-relative file paths and their contents.
 */
async function writePackage(
  root: string,
  directory: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<void> {
  await writeFixture(root, `${directory}/package.json`, JSON.stringify(manifest))
  for (const [path, content] of Object.entries(files)) await writeFixture(root, `${directory}/${path}`, content)
}

describe('collectHelperClosure', () => {
  it('collects reachable files, package manifests, and the CommonJS fallback tree', async () => {
    const { root, entryFile } = await mainFixture()
    const stagingDir = join(root, 'staging')

    const closure = await collectHelperClosure({ entryFile, stagingDir })

    expect(closure.entry).toBe('node_modules/@fixture/app/lib/entry.js')
    expect(closure.directory).toBe(stagingDir)
    const staged = await listFiles(stagingDir)
    expect(staged).toEqual([
      'node_modules/@fixture/app/lib/entry.js',
      'node_modules/@fixture/app/lib/used.js',
      'node_modules/@fixture/app/package.json',
      'node_modules/@fixture/commonjs-pkg/data.json',
      'node_modules/@fixture/commonjs-pkg/extra.js',
      'node_modules/@fixture/commonjs-pkg/index.js',
      'node_modules/@fixture/commonjs-pkg/package.json',
      'node_modules/@fixture/dep/index.js',
      'node_modules/@fixture/dep/package.json',
      'node_modules/@fixture/leaf/index.js',
      'node_modules/@fixture/leaf/package.json',
    ])
    expect(closure.files).toBe(staged.length)
  })

  it('omits unreachable ESM files and excludes CommonJS build and test residue', async () => {
    const { root, entryFile } = await mainFixture()
    const closure = await collectHelperClosure({ entryFile, stagingDir: join(root, 'staging') })
    const staged = await listFiles(closure.directory)

    expect(staged).not.toContain('node_modules/@fixture/app/lib/unused.js')
    expect(staged.some(path => path.includes('unused-dep'))).toBe(false)
    expect(staged).not.toContain('node_modules/@fixture/commonjs-pkg/index.js.map')
    expect(staged).not.toContain('node_modules/@fixture/commonjs-pkg/types.d.ts')
    expect(staged).not.toContain('node_modules/@fixture/commonjs-pkg/tests/skipped.js')
  })

  it('rejects a relative entry file, a missing entry, and an occupied staging directory', async () => {
    const { root, entryFile } = await mainFixture()

    await expect(collectHelperClosure({ entryFile: 'entry.js', stagingDir: join(root, 'a') }))
      .rejects.toThrow(/must be an absolute path/u)
    await expect(collectHelperClosure({ entryFile: join(root, 'missing.js'), stagingDir: join(root, 'b') }))
      .rejects.toThrow(/does not exist/u)

    const occupied = join(root, 'occupied')
    await writeFixture(root, 'occupied/leftover.js', 'export const leftover = 1\n')
    await expect(collectHelperClosure({ entryFile, stagingDir: occupied }))
      .rejects.toThrow(/is not empty/u)
  })

  it('rejects a relative import that leaves its package', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'node_modules/@fixture/app/package.json', JSON.stringify({ name: '@fixture/app', type: 'module', exports: { '.': './lib/entry.js' } }))
    await writeFixture(root, 'node_modules/@fixture/app/lib/entry.js', "import '../../dep/lib/reached.js'\n")
    await writeFixture(root, 'node_modules/@fixture/dep/package.json', JSON.stringify({ name: '@fixture/dep', type: 'module' }))
    await writeFixture(root, 'node_modules/@fixture/dep/lib/reached.js', 'export const reached = 1\n')

    await expect(collectHelperClosure({
      entryFile: join(root, 'node_modules/@fixture/app/lib/entry.js'),
      stagingDir: join(root, 'staging'),
    })).rejects.toThrow(/relative import .* leaves package/u)
  })

  it('fails loud when a bare import cannot be resolved', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'node_modules/@fixture/app/package.json', JSON.stringify({ name: '@fixture/app', type: 'module' }))
    await writeFixture(root, 'node_modules/@fixture/app/lib/entry.js', "import '@fixture/absent'\n")

    await expect(collectHelperClosure({
      entryFile: join(root, 'node_modules/@fixture/app/lib/entry.js'),
      stagingDir: join(root, 'staging'),
    })).rejects.toThrow(/cannot resolve "@fixture\/absent"/u)
  })

  it('collects both entries of a package whose import and require conditions differ', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'node_modules/@fixture/app/package.json', JSON.stringify({ name: '@fixture/app', type: 'module', exports: { '.': './entry.js' } }))
    await writeFixture(root, 'node_modules/@fixture/app/entry.js', "import '@fixture/dual'\n")
    await writeFixture(root, 'node_modules/@fixture/dual/package.json', JSON.stringify({ name: '@fixture/dual', type: 'module', exports: { '.': { import: './index.js', require: './index.cjs' } } }))
    await writeFixture(root, 'node_modules/@fixture/dual/index.js', 'export const dual = 1\n')
    await writeFixture(root, 'node_modules/@fixture/dual/index.cjs', 'module.exports = { dual: 1 }\n')

    const closure = await collectHelperClosure({
      entryFile: join(root, 'node_modules/@fixture/app/entry.js'),
      stagingDir: join(root, 'staging'),
    })

    expect(await listFiles(closure.directory)).toEqual([
      'node_modules/@fixture/app/entry.js',
      'node_modules/@fixture/app/package.json',
      'node_modules/@fixture/dual/index.cjs',
      'node_modules/@fixture/dual/index.js',
      'node_modules/@fixture/dual/package.json',
    ])
  })

  it('copies the nested package.json that overrides a module type', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'node_modules/@fixture/app/package.json', JSON.stringify({ name: '@fixture/app', type: 'module', exports: { '.': './entry.js' } }))
    await writeFixture(root, 'node_modules/@fixture/app/entry.js', "import './sub/legacy.cjs'\n")
    await writeFixture(root, 'node_modules/@fixture/app/sub/package.json', JSON.stringify({ type: 'commonjs' }))
    await writeFixture(root, 'node_modules/@fixture/app/sub/legacy.cjs', 'module.exports = 1\n')

    const closure = await collectHelperClosure({
      entryFile: join(root, 'node_modules/@fixture/app/entry.js'),
      stagingDir: join(root, 'staging'),
    })

    expect(await listFiles(closure.directory)).toEqual([
      'node_modules/@fixture/app/entry.js',
      'node_modules/@fixture/app/package.json',
      'node_modules/@fixture/app/sub/legacy.cjs',
      'node_modules/@fixture/app/sub/package.json',
    ])
  })

  it('skips an unresolvable optional dependency that its importer declares', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'package.json', JSON.stringify({
      name: '@fixture/opt',
      type: 'commonjs',
      optionalDependencies: { '@fixture/absent-optional': '^1.0.0' },
    }))
    await writeFixture(root, 'entry.js', "try {\n  require('@fixture/absent-optional')\n} catch (absent) {\n  module.exports = absent\n}\n")

    const closure = await collectHelperClosure({ entryFile: join(root, 'entry.js'), stagingDir: join(root, 'staging') })

    expect(await listFiles(closure.directory)).toEqual([
      'node_modules/@fixture/opt/entry.js',
      'node_modules/@fixture/opt/package.json',
    ])
  })
})

describe('packHelperArtifact', () => {
  it('hashes the entry bytes and lists sorted entry names', async () => {
    const { root, entryFile } = await mainFixture()
    const closure = await collectHelperClosure({ entryFile, stagingDir: join(root, 'staging') })
    const artifact = await packHelperArtifact(closure)

    const expectedDigest = createHash('sha256').update(await readFile(entryFile)).digest('hex')
    expect(artifact.digest).toBe(expectedDigest)
    expect(artifact.entry).toBe(closure.entry)
    const names = readTarEntryNames(artifact.archive)
    expect(names).toEqual(await listFiles(closure.directory))
  })

  it('produces byte-identical archives for the same closure', async () => {
    const { root, entryFile } = await mainFixture()
    const closure = await collectHelperClosure({ entryFile, stagingDir: join(root, 'staging') })

    const first = await packHelperArtifact(closure)
    const second = await packHelperArtifact(closure)

    expect(Buffer.from(first.archive).equals(Buffer.from(second.archive))).toBe(true)
    expect(first.digest).toBe(second.digest)
  })

  it('reads back a long entry stored through the ustar prefix field', async () => {
    const root = await temporaryRoot()
    const longDirectory = `${'nested/'.repeat(15)}package`
    await writeFixture(root, 'package.json', JSON.stringify({ name: '@fixture/long', type: 'module' }))
    await writeFixture(root, `${longDirectory}/entry.js`, 'export const entry = 1\n')
    const entryFile = join(root, longDirectory, 'entry.js')
    const closure = await collectHelperClosure({ entryFile, stagingDir: join(root, 'staging') })
    expect(closure.entry.length).toBeGreaterThan(100)

    const artifact = await packHelperArtifact(closure)
    expect(readTarEntryNames(artifact.archive)).toContain(closure.entry)
  })
})

describe('readTarEntryNames', () => {
  it('rejects an entry that escapes the archive root', () => {
    const archive = gzipSync(Buffer.concat([customHeader('../evil.js', '0'), Buffer.alloc(1024)]))
    expect(() => readTarEntryNames(archive)).toThrow(/unsafe/u)
  })

  it('rejects an unsupported entry type', () => {
    const archive = gzipSync(Buffer.concat([customHeader('entry.js', 'L'), Buffer.alloc(1024)]))
    expect(() => readTarEntryNames(archive)).toThrow(/unsupported tar entry type/u)
  })
})

describe('writeHelperArtifact', () => {
  it('writes the archive and manifest beside the caller-provided staging directory', async () => {
    const { root, entryFile } = await mainFixture()
    const outputDir = join(root, 'out')
    const stagingDir = join(root, 'staging')

    const written = await writeHelperArtifact({ entryFile, outputDir, stagingDir })

    expect(written.entry).toBe('node_modules/@fixture/app/lib/entry.js')
    expect(written.artifactPath).toBe(join(outputDir, `dsh-ssh-helper-${written.digest}.tar.gz`))
    expect(await readdir(stagingDir)).toContain('node_modules')
    const manifest: unknown = JSON.parse(await readFile(written.manifestPath, 'utf8'))
    expect(manifest).toEqual({
      entry: written.entry,
      digest: written.digest,
      archive: `dsh-ssh-helper-${written.digest}.tar.gz`,
      files: 11,
    })
    const artifact = await readFile(written.artifactPath)
    expect(readTarEntryNames(artifact)).toHaveLength(11)
  })

  it('creates and removes its own staging directory when none is given', async () => {
    const { root, entryFile } = await mainFixture()
    const outputDir = join(root, 'out')

    const written = await writeHelperArtifact({ entryFile, outputDir })

    expect((await readdir(outputDir)).sort()).toEqual([
      `dsh-ssh-helper-${written.digest}.tar.gz`,
      'manifest.json',
    ])
  })
})

describe('collectHelperClosure rejection paths', () => {
  it('rejects an entry path that is a directory rather than a regular file', async () => {
    const root = await temporaryRoot()
    await writePackage(root, 'node_modules/@fixture/app', { name: '@fixture/app', type: 'module' }, {})
    const directory = join(root, 'node_modules/@fixture/app/lib')
    await mkdir(directory, { recursive: true })

    await expect(collectHelperClosure({ entryFile: directory, stagingDir: join(root, 'staging') }))
      .rejects.toThrow(/is not a regular file/u)
  })

  it('rejects an entry with no owning package manifest', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'entry.js', 'export const entry = 1\n')

    await expect(collectHelperClosure({ entryFile: join(root, 'entry.js'), stagingDir: join(root, 'staging') }))
      .rejects.toThrow(/has no owning package\.json/u)
  })

  it('rejects a manifest that is not JSON, one without a usable name, and one with an unsafe name', async () => {
    const manifests = ['not json', JSON.stringify({ name: 42 }), JSON.stringify({ name: 'bad/name' })]
    for (const manifest of manifests) {
      const root = await temporaryRoot()
      await writePackage(root, 'node_modules/@fixture/app', { name: '@fixture/app', type: 'module' }, {})
      await writeFixture(root, 'node_modules/@fixture/app/package.json', manifest)
      await writeFixture(root, 'node_modules/@fixture/app/entry.js', 'export const entry = 1\n')

      await expect(collectHelperClosure({
        entryFile: join(root, 'node_modules/@fixture/app/entry.js'),
        stagingDir: join(root, 'staging'),
      })).rejects.toThrow(/helper closure/u)
    }
  })

  it('rejects a staging directory that is a regular file', async () => {
    const { root, entryFile } = await mainFixture()
    await writeFixture(root, 'staging-file', 'not a directory\n')

    await expect(collectHelperClosure({ entryFile, stagingDir: join(root, 'staging-file') }))
      .rejects.toThrow(/exists and is not a directory/u)
  })

  it('rejects a staging path below a regular file', async () => {
    const { root, entryFile } = await mainFixture()
    await writeFixture(root, 'blocker', 'not a directory\n')

    await expect(collectHelperClosure({ entryFile, stagingDir: join(root, 'blocker', 'staging') }))
      .rejects.toThrow(/ENOTDIR/u)
  })

  it('fails loud when an ancestor manifest cannot be inspected', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'node_modules/@fixture/app/entry.js', 'export const entry = 1\n')
    const manifestPath = join(root, 'node_modules/@fixture/app/package.json')
    await symlink(manifestPath, manifestPath)

    await expect(collectHelperClosure({
      entryFile: join(root, 'node_modules/@fixture/app/entry.js'),
      stagingDir: join(root, 'staging'),
    })).rejects.toThrow(/ELOOP/u)
  })

  it('rejects an import that resolves outside any owning package', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'node_modules/loose-pkg/index.js', 'module.exports = 1\n')
    await writePackage(root, 'node_modules/@fixture/app', { name: '@fixture/app', type: 'module' }, {
      'entry.js': "import 'loose-pkg'\n",
    })

    await expect(collectHelperClosure({
      entryFile: join(root, 'node_modules/@fixture/app/entry.js'),
      stagingDir: join(root, 'staging'),
    })).rejects.toThrow(/has no owning package\.json/u)
  })

  it('rejects an unresolvable import, including one that names no package', async () => {
    for (const specifier of ['./missing.js', '', '@fixture-absent/']) {
      const root = await temporaryRoot()
      await writePackage(root, 'node_modules/@fixture/app', { name: '@fixture/app', type: 'module' }, {
        'entry.js': `import ${JSON.stringify(specifier)}\n`,
      })

      await expect(collectHelperClosure({
        entryFile: join(root, 'node_modules/@fixture/app/entry.js'),
        stagingDir: join(root, 'staging'),
      })).rejects.toThrow(/cannot resolve/u)
    }
  })

  it('leaves Node builtins out of the closure', async () => {
    const root = await temporaryRoot()
    await writePackage(root, 'node_modules/@fixture/app', { name: '@fixture/app', type: 'module' }, {
      'entry.js': "import 'node:fs'\nexport const entry = 1\n",
    })

    const closure = await collectHelperClosure({
      entryFile: join(root, 'node_modules/@fixture/app/entry.js'),
      stagingDir: join(root, 'staging'),
    })

    expect(await listFiles(closure.directory)).toEqual([
      'node_modules/@fixture/app/entry.js',
      'node_modules/@fixture/app/package.json',
    ])
  })

  it('skips package-tree entries that are neither files nor directories', async () => {
    const root = await temporaryRoot()
    await writePackage(root, 'node_modules/@fixture/app', { name: '@fixture/app', type: 'commonjs' }, {
      'entry.js': 'module.exports = { data: require("./data.json") }\n',
      'data.json': '{}\n',
    })
    await symlink('missing-target', join(root, 'node_modules/@fixture/app/dangling'))

    const closure = await collectHelperClosure({
      entryFile: join(root, 'node_modules/@fixture/app/entry.js'),
      stagingDir: join(root, 'staging'),
    })

    expect(await listFiles(closure.directory)).toEqual([
      'node_modules/@fixture/app/data.json',
      'node_modules/@fixture/app/entry.js',
      'node_modules/@fixture/app/package.json',
    ])
  })
})

/** The leaf manifests the export-resolution fixture installs under its router package. */
const EXPORT_LEAVES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['string', { name: '@fixture/leaf-string', type: 'module', exports: './index.js' }],
  ['nonrecord', { name: '@fixture/leaf-nonrecord', type: 'module', exports: 42 }],
  ['cond', { name: '@fixture/leaf-cond', type: 'module', exports: { node: './index.js' } }],
  ['nomatch', { name: '@fixture/leaf-nomatch', type: 'module', exports: { './other': './o.js' } }],
  ['target-nonrecord', { name: '@fixture/leaf-target', type: 'module', exports: { './target-nonrecord': 42 } }],
  ['wild', {
    name: '@fixture/leaf-wild',
    type: 'module',
    exports: {
      './zzz*': './never/*.js',
      './w*zzz': './never-two/*.js',
      './wil*ild': './never-three/*.js',
      './w*': './better/*.js',
      './*': './lib/*.js',
    },
  }],
  ['wild-null', { name: '@fixture/leaf-wild-null', type: 'module', exports: { './*': 42 } }],
]

/**
 * Build the fixture that drives `exports` resolution: one router package whose
 * subpaths reach leaf packages with distinct `exports` values, plus direct
 * dependencies whose own `exports` is a string, an array or a condition map.
 * @returns the fixture root and the entry importing every case that resolves.
 */
async function exportFixture(): Promise<{ root: string; entryFile: string }> {
  const root = await temporaryRoot()
  const subpaths = Object.fromEntries(EXPORT_LEAVES.map(([leaf]) => [`./${leaf}`, `./${leaf}/index.js`]))
  await writePackage(root, 'node_modules/@fixture/router', {
    name: '@fixture/router',
    type: 'module',
    exports: subpaths,
  }, {})
  for (const [leaf, manifest] of EXPORT_LEAVES) {
    await writePackage(root, `node_modules/@fixture/router/${leaf}`, manifest, {
      'index.js': `export const ${leaf.replaceAll('-', '')} = 1\n`,
    })
  }
  await writeFixture(root, 'node_modules/@fixture/router/wild/better/ild.js', 'export const ild = 1\n')
  await writePackage(root, 'node_modules/plain-string', {
    name: 'plain-string', type: 'module', exports: './index.js',
  }, { 'index.js': 'export const plainString = 1\n' })
  await writePackage(root, 'node_modules/plain-array', {
    name: 'plain-array', type: 'module', exports: [42, './index.js'],
  }, { 'index.js': 'export const plainArray = 1\n' })
  await writePackage(root, 'node_modules/plain-array-empty', {
    name: 'plain-array-empty', type: 'module', exports: [42, { require: './index.cjs' }],
  }, { 'index.cjs': 'module.exports = 1\n' })
  await writePackage(root, 'node_modules/plain-cond-node', {
    name: 'plain-cond-node', type: 'module', exports: { node: './index.js' },
  }, { 'index.js': 'export const plainCondNode = 1\n' })
  await writePackage(root, 'node_modules/plain-cond', {
    name: 'plain-cond', type: 'module', exports: { require: './index.cjs' },
  }, { 'index.cjs': 'module.exports = 1\n' })
  // The resolved file's nearest manifest, not the specifier's, supplies the exports field.
  await writePackage(root, 'node_modules/plain-nested', {
    name: 'plain-nested', type: 'module', exports: { node: './inner/index.js' },
  }, {})
  await writePackage(root, 'node_modules/plain-nested/inner', {
    name: '@fixture/plain-inner', type: 'module', exports: { node: 42 },
  }, { 'index.js': 'export const plainInner = 1\n' })
  const specifiers = [
    'node:fs',
    'plain-string',
    'plain-array',
    'plain-array-empty',
    'plain-cond-node',
    'plain-cond',
    'plain-nested',
    ...EXPORT_LEAVES.map(([leaf]) => `@fixture/router/${leaf}`),
  ]
  await writePackage(root, 'node_modules/@fixture/app', { name: '@fixture/app', type: 'module' }, {
    'entry.js': `${specifiers.map(specifier => `import '${specifier}'`).join('\n')}\n`,
  })
  return { root, entryFile: join(root, 'node_modules/@fixture/app/entry.js') }
}

describe('import condition resolution', () => {
  it('collects every reachable half of a string, array and condition-map exports field', async () => {
    const { root, entryFile } = await exportFixture()

    const closure = await collectHelperClosure({ entryFile, stagingDir: join(root, 'staging') })
    const staged = await listFiles(closure.directory)

    expect(staged).toContain('node_modules/plain-string/index.js')
    expect(staged).toContain('node_modules/plain-array/index.js')
    expect(staged).toContain('node_modules/plain-array-empty/index.cjs')
    expect(staged).toContain('node_modules/plain-cond-node/index.js')
    expect(staged).toContain('node_modules/plain-cond/index.cjs')
    expect(staged).toContain('node_modules/@fixture/leaf-wild/better/ild.js')
    expect(staged).toContain('node_modules/@fixture/leaf-nomatch/index.js')
    expect(closure.files).toBe(staged.length)
  })
})

/**
 * Build one fixture package whose entry and chunks exercise every branch of the specifier scanner.
 * @returns the fixture root and its entry file.
 */
async function lexisFixture(): Promise<{ root: string; entryFile: string }> {
  const root = await temporaryRoot()
  await writePackage(root, 'node_modules/@fixture/lexis', { name: '@fixture/lexis', type: 'module' }, {
    'first.js': 'export const first = 1\n',
    'second.js': 'export const second = 1\n',
    'third.js': 'export const third = 1\n',
    'fourth.js': 'export const fourth = 1\n',
    'dynamic.js': 'export const dynamic = 1\n',
    'required.cjs': 'module.exports = 1\n',
    'trivia-eof.js': 'import   ',
    'comment-line-eof.js': 'import // no newline',
    'comment-block-eof.js': 'import /* no close',
    'quote-eof.js': "import 'no close",
    'top-line-comment-eof.js': '// no newline',
    'top-block-comment-eof.js': '/* no close',
    'string-eof.js': "const tail = 'no close",
    'entry.js': [
      "// import '@fixture/ghost-line'",
      "/* import '@fixture/ghost-block' */",
      "import './first.js'",
      'import',
      "  /* between the keyword and its literal */ './second.js'",
      'import // between the keyword and its literal',
      "  './third.js'",
      "const quoted = 'a string'",
      "const escaped = 'it\\'s escaped'",
      'const template = `a template`',
      "stream.require('@fixture/ghost-member')",
      "Buffer.from('./not-an-import.js')",
      "export { first } from './first.js'",
      "import('./dynamic.js')",
      "require('./required.cjs')",
      "import './comment-line-eof.js'",
      "import './comment-block-eof.js'",
      "import './trivia-eof.js'",
      "import './quote-eof.js'",
      "import './top-line-comment-eof.js'",
      "import './top-block-comment-eof.js'",
      "import './string-eof.js'",
      "import './fourth.js' // a trailing line comment with no newline",
    ].join('\n'),
  })
  return { root, entryFile: join(root, 'node_modules/@fixture/lexis/entry.js') }
}

describe('specifier scanning', () => {
  it('reads only literal import specifiers across comments, strings and member access', async () => {
    const { root, entryFile } = await lexisFixture()

    const closure = await collectHelperClosure({ entryFile, stagingDir: join(root, 'staging') })
    const staged = await listFiles(closure.directory)

    expect(staged).toContain('node_modules/@fixture/lexis/first.js')
    expect(staged).toContain('node_modules/@fixture/lexis/second.js')
    expect(staged).toContain('node_modules/@fixture/lexis/third.js')
    expect(staged).toContain('node_modules/@fixture/lexis/fourth.js')
    expect(staged).toContain('node_modules/@fixture/lexis/dynamic.js')
    expect(staged).toContain('node_modules/@fixture/lexis/required.cjs')
    expect(staged.some(path => path.includes('ghost') || path.includes('not-an-import'))).toBe(false)
  })
})

describe('closure limits', () => {
  it('rejects a copied file above the per-file byte limit', async () => {
    const root = await temporaryRoot()
    await writePackage(root, 'node_modules/@fixture/huge', { name: '@fixture/huge', type: 'module' }, {})
    const entryFile = join(root, 'node_modules/@fixture/huge/entry.js')
    await writeFile(entryFile, '')
    await truncate(entryFile, 64 * 1024 * 1024 + 1)

    await expect(collectHelperClosure({ entryFile, stagingDir: join(root, 'staging') }))
      .rejects.toThrow(/above the 67108864-byte per-file limit/u)
  })

  it('rejects a closure above the copied-file count limit', async () => {
    const root = await temporaryRoot()
    const directory = 'node_modules/@fixture/bulk'
    await writePackage(root, directory, { name: '@fixture/bulk', type: 'commonjs' }, {})
    const names = Array.from({ length: 20_001 }, (_unused, index) => `file-${String(index)}.txt`)
    for (let start = 0; start < names.length; start += 2_000) {
      await Promise.all(names.slice(start, start + 2_000).map(name => writeFile(join(root, directory, name), '')))
    }

    await expect(collectHelperClosure({
      entryFile: join(root, directory, 'file-0.txt'),
      stagingDir: join(root, 'staging'),
    })).rejects.toThrow(/exceeds the 20000-file limit/u)
  }, 120_000)
})

describe('packHelperArtifact rejection paths', () => {
  it('rejects an archive whose entry is absent from the staging directory', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'staging/node_modules/@fixture/app/other.js', 'export const other = 1\n')

    await expect(packHelperArtifact({
      directory: join(root, 'staging'),
      entry: 'node_modules/@fixture/app/entry.js',
      files: 1,
    })).rejects.toThrow(/is absent from/u)
  })

  it('ignores staging entries that are neither files nor directories', async () => {
    const root = await temporaryRoot()
    await writeFixture(root, 'staging/entry.js', 'export const entry = 1\n')
    await symlink('missing-target', join(root, 'staging/dangling'))

    const artifact = await packHelperArtifact({ directory: join(root, 'staging'), entry: 'entry.js', files: 1 })

    expect(readTarEntryNames(artifact.archive)).toEqual(['entry.js'])
  })

  it('rejects a staged path that no ustar split can represent', async () => {
    const root = await temporaryRoot()
    const longName = `${'x'.repeat(120)}.js`
    await writePackage(root, 'node_modules/@fixture/app', { name: '@fixture/app', type: 'module' }, {
      [longName]: 'export const long = 1\n',
      'entry.js': `import './${longName}'\n`,
    })

    const closure = await collectHelperClosure({
      entryFile: join(root, 'node_modules/@fixture/app/entry.js'),
      stagingDir: join(root, 'staging'),
    })

    await expect(packHelperArtifact(closure)).rejects.toThrow(/too long for a ustar header/u)
  })
})

describe('readTarEntryNames rejection paths', () => {
  /**
   * Read one synthetic archive built from a single header.
   * @param header - the 512-byte header to read.
   * @returns the rejected error from {@link readTarEntryNames}.
   */
  async function rejected(header: Buffer): Promise<unknown> {
    return readTarEntryNames(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])))
  }

  it('rejects a header whose checksum does not match its bytes', () => {
    const header = syntheticHeader({ name: 'entry.js', checksum: '000000\0 ' })
    let sum = 0
    for (let index = 0; index < header.length; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0)
    }
    expect(() => readTarEntryNames(gzipSync(Buffer.concat([header, Buffer.alloc(1024)]))))
      .toThrow(`carries checksum 0, expected ${String(sum)}`)
  })

  it('rejects a header that is not ustar', () => {
    const header = syntheticHeader({ magic: 'xxxxx' })
    expect(() => readTarEntryNames(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])))).toThrow(/is not ustar/u)
  })

  it('accepts a directory entry and reads its zero length', () => {
    const header = syntheticHeader({ name: 'lib', type: '5' })
    expect(readTarEntryNames(gzipSync(Buffer.concat([header, Buffer.alloc(1024)])))).toEqual(['lib'])
  })

  it('rejects an empty, an absolute, a control-character and an unsafe archive path', async () => {
    await expect(rejected(syntheticHeader({ name: '' }))).rejects.toThrow(/must not be empty/u)
    await expect(rejected(syntheticHeader({ name: '/evil.js' }))).rejects.toThrow(/must be relative/u)
    await expect(rejected(syntheticHeader({ name: 'a\u0001b.js' }))).rejects.toThrow(/control characters/u)
    await expect(rejected(syntheticHeader({ name: 'a//b.js' }))).rejects.toThrow(/unsafe ""/u)
    await expect(rejected(syntheticHeader({ name: 'a/./b.js' }))).rejects.toThrow(/unsafe "\."/u)
  })

  it('reads an empty octal field as zero and rejects a field that is not octal', async () => {
    const empty = readTarEntryNames(gzipSync(Buffer.concat([syntheticHeader({ size: '' }), Buffer.alloc(1024)])))
    expect(empty).toEqual(['entry.js'])
    await expect(rejected(syntheticHeader({ size: 'zzz' }))).rejects.toThrow(/is not a valid octal number/u)
  })
})

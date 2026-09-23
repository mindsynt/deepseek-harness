/**
 * Collect the dependency closure of the POSIX SSH helper and pack it into one
 * deterministic gzip tar.
 *
 * The helper runs under plain Node on a remote POSIX host, so it needs every
 * module it statically imports — workspace packages, its own relative chunks,
 * and third-party runtime packages — placed beside it. This package resolves
 * those imports from the built entry file, copies the owning packages into a
 * flat `node_modules` staging tree, and writes a ustar archive whose entry is
 * the remote helper path. Only `node:` builtins are used, so nothing here adds
 * a second copy of the harness runtime to the artifact.
 *
 * @module @deepseek-ai/dsh-helper-artifact
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { HelperArtifact, HelperClosure } from './types.ts'

export type { HelperArtifact, HelperClosure } from './types.ts'

/** Largest number of copied files one closure may hold. */
const MAX_CLOSURE_FILES = 20_000

/** Largest single copied file, in bytes. */
const MAX_FILE_BYTES = 64 * 1024 * 1024

/** Directory names never copied from a package tree. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'test', 'tests'])

/** File name suffixes never copied from a package tree. */
const SKIPPED_SUFFIXES = ['.map', '.ts']

/** File name suffixes whose import specifiers are resolved. */
const SCRIPT_SUFFIXES = ['.js', '.cjs', '.mjs']

/** Export conditions Node applies when it resolves an ESM import. */
const IMPORT_CONDITIONS = ['node', 'import', 'default'] as const

/** Bytes in one tar block. */
const TAR_BLOCK_BYTES = 512

/** One package discovered by walking the import graph. */
interface CollectedPackage {
  /** Absolute package root holding the nearest `package.json`. */
  readonly root: string
  /** Package name that becomes the staging directory under `node_modules`. */
  readonly name: string
  /** Whether only reachable files are copied instead of the whole directory. */
  readonly reachableOnly: boolean
}

/** One literal module specifier found in a source file. */
interface SpecifierMatch {
  readonly value: string
  /** Index just past the closing quote. */
  readonly end: number
}

/**
 * Collect the dependency closure reachable from one entry file.
 * @param options - absolute entry file and the empty staging directory to fill.
 * @returns the staging directory, the entry path relative to it, and the copied file count.
 * @throws when the entry file is missing or relative, the staging directory is occupied, an import
 *   cannot be resolved, a relative import leaves its package, or a size or file-count limit is exceeded.
 */
export async function collectHelperClosure(options: { entryFile: string; stagingDir: string }): Promise<HelperClosure> {
  const { entryFile, stagingDir } = options
  if (!isAbsolute(entryFile)) {
    throw new Error(`helper closure: entryFile must be an absolute path, received ${JSON.stringify(entryFile)}`)
  }
  let entryStat
  try {
    entryStat = await stat(entryFile)
  } catch (error) {
    throw new Error(`helper closure: entryFile ${entryFile} does not exist (${errorMessage(error)}); build the host libraries before collecting the helper closure`)
  }
  if (!entryStat.isFile()) {
    throw new Error(`helper closure: entryFile ${entryFile} is not a regular file`)
  }
  await prepareStagingDirectory(stagingDir)
  return new ClosureBuilder(stagingDir).collect(entryFile)
}

/**
 * Pack one collected closure into a deterministic gzip tar.
 *
 * Entries are sorted by path bytes, carry fixed metadata (mode `0644`, mtime 0,
 * uid/gid 0, empty uname/gname), and the archive is written in memory with no
 * temporary file, so two calls over identical input produce byte-identical output.
 * @param closure - staging directory, archive entry, and copied file count.
 * @returns the archive bytes, the entry path, and the entry file's lowercase SHA-256.
 * @throws when the entry is absent from the staging directory or an archive path is not representable.
 */
export async function packHelperArtifact(closure: HelperClosure): Promise<HelperArtifact> {
  const paths = await listStagingFiles(closure.directory)
  if (!paths.includes(closure.entry)) {
    throw new Error(`helper artifact: closure entry ${JSON.stringify(closure.entry)} is absent from ${closure.directory}`)
  }
  const blocks: Buffer[] = []
  let entryBytes: Buffer | undefined
  for (const path of paths) {
    const bytes = await readFile(join(closure.directory, ...path.split('/')))
    if (path === closure.entry) entryBytes = bytes
    const body = Buffer.alloc(alignToBlock(bytes.length))
    bytes.copy(body)
    blocks.push(tarHeader(path, bytes.length), body)
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2))
  const archive = gzipSync(Buffer.concat(blocks), { level: 9 })
  /* v8 ignore next -- the entry-presence guard above guarantees entryBytes was assigned */
  const digest = createHash('sha256').update(entryBytes ?? Buffer.alloc(0)).digest('hex')
  return { archive, entry: closure.entry, digest }
}

/**
 * Collect and pack one helper artifact into an output directory.
 *
 * The archive is written as `dsh-ssh-helper-<digest>.tar.gz` beside a
 * `manifest.json` recording the entry, digest, archive name, and file count.
 * @param options - absolute entry file, output directory, and optional staging directory; an omitted
 *   staging directory is created under the OS temporary directory and always removed.
 * @returns the absolute archive path, manifest path, entry path, and digest.
 * @throws when collection or packing fails, or the output files cannot be written.
 */
export async function writeHelperArtifact(options: {
  entryFile: string
  outputDir: string
  stagingDir?: string
}): Promise<{ artifactPath: string; manifestPath: string; entry: string; digest: string }> {
  const stagingDir = options.stagingDir ?? await mkdtemp(join(tmpdir(), 'dsh-ssh-helper-artifact-'))
  const temporary = options.stagingDir === undefined
  try {
    const closure = await collectHelperClosure({ entryFile: options.entryFile, stagingDir })
    const artifact = await packHelperArtifact(closure)
    await mkdir(options.outputDir, { recursive: true })
    const archiveName = `dsh-ssh-helper-${artifact.digest}.tar.gz`
    const artifactPath = join(options.outputDir, archiveName)
    const manifestPath = join(options.outputDir, 'manifest.json')
    await writeFile(artifactPath, artifact.archive)
    await writeFile(manifestPath, renderManifest(artifact, closure.files))
    return { artifactPath, manifestPath, entry: artifact.entry, digest: artifact.digest }
  } finally {
    if (temporary) await rm(stagingDir, { recursive: true, force: true })
  }
}

/**
 * Read the entry names of a gzip tar produced by {@link packHelperArtifact}.
 *
 * Test and self-check helper only: it validates each header checksum and entry
 * path, and rejects entry types other than regular files and directories.
 * @param archive - gzip-compressed tar bytes.
 * @returns every entry name in archive order.
 * @throws when the archive is not gzip, a header is malformed, or an entry type is unsupported.
 */
export function readTarEntryNames(archive: Uint8Array): string[] {
  const tar = gunzipSync(archive)
  const names: string[] = []
  let offset = 0
  while (offset + TAR_BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES)
    if (isZeroBlock(header)) break
    const stored = parseOctal(header, 148, 8)
    let sum = 0
    for (let index = 0; index < header.length; index += 1) {
      /* v8 ignore next -- index is bounded by the header length, so the read is always defined */
      sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0)
    }
    if (sum !== stored) {
      throw new Error(`helper artifact: tar header at byte ${String(offset)} carries checksum ${String(stored)}, expected ${String(sum)}`)
    }
    if (readCString(header, 257, 6).replace(/\0+$/u, '') !== 'ustar') {
      throw new Error(`helper artifact: tar header at byte ${String(offset)} is not ustar`)
    }
    /* v8 ignore next -- a tar block is 512 bytes, so byte 156 always exists */
    const type = header[156] ?? 0
    const name = readCString(header, 0, 100)
    const prefix = readCString(header, 345, 155)
    const path = prefix.length > 0 ? `${prefix}/${name}` : name
    validateArchivePath(path)
    if (type !== 0x30 && type !== 0 && type !== 0x35) {
      throw new Error(`helper artifact: unsupported tar entry type ${JSON.stringify(String.fromCharCode(type))} for ${path}`)
    }
    const size = type === 0x35 ? 0 : parseOctal(header, 124, 12)
    names.push(path)
    offset += TAR_BLOCK_BYTES + alignToBlock(size)
  }
  return names
}

/** Resolve one entry file's imports into a flat `node_modules` staging tree. */
class ClosureBuilder {
  private readonly stagingDir: string
  private readonly packages = new Map<string, Promise<CollectedPackage | undefined>>()
  private readonly copied = new Set<string>()
  private readonly expanded = new Set<string>()
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private files = 0

  /**
   * @param stagingDir - empty staging directory that receives the closure.
   */
  constructor(stagingDir: string) {
    this.stagingDir = stagingDir
  }

  /**
   * Walk the import graph from `entryFile` until it stops growing.
   * @param entryFile - absolute entry file to copy first.
   * @returns the staging directory, entry path, and copied file count.
   * @throws when the entry has no owning package, an import cannot be resolved, or a limit is exceeded.
   */
  async collect(entryFile: string): Promise<HelperClosure> {
    const entryPackage = await this.packageOf(entryFile)
    if (entryPackage === undefined) {
      throw new Error(`helper closure: entryFile ${entryFile} has no owning package.json`)
    }
    const entryStaged = this.stagingPath(entryPackage, entryFile)
    this.enqueue(entryFile)
    while (this.queue.length > 0) {
      await this.processFile(this.queue.shift() as string)
    }
    return {
      directory: this.stagingDir,
      entry: relative(this.stagingDir, entryStaged).split(sep).join('/'),
      files: this.files,
    }
  }

  /**
   * Copy one reachable file, expand its package when it is CommonJS, and follow its imports.
   * @param file - absolute source file.
   * @throws when the file cannot be copied or one of its imports cannot be resolved.
   */
  private async processFile(file: string): Promise<void> {
    await this.copySourceFile(file)
    const owner = await this.packageOf(file)
    /* v8 ignore next 2 -- copySourceFile above already threw when this file has no owning package */
    if (owner === undefined) {
      throw new Error(`helper closure: ${file} has no owning package.json`)
    }
    if (!owner.reachableOnly) await this.expandPackage(owner)
    if (!SCRIPT_SUFFIXES.some(suffix => file.endsWith(suffix))) return
    for (const specifier of scanSpecifiers(await readFile(file, 'utf8'))) {
      await this.follow(file, specifier)
    }
  }

  /**
   * Resolve one specifier against its importing file and queue the target.
   * @param importer - absolute file that carries the specifier.
   * @param specifier - literal module specifier.
   * @throws when the specifier cannot be resolved, or a relative specifier leaves the importing package.
   */
  private async follow(importer: string, specifier: string): Promise<void> {
    if (isBuiltin(specifier)) return
    let resolved: string
    try {
      resolved = createRequire(importer).resolve(specifier)
    } catch (error) {
      if (await this.isOptionalDependency(importer, specifier)) return
      throw new Error(`helper closure: cannot resolve ${JSON.stringify(specifier)} imported by ${importer} (${errorMessage(error)}); install the dependency or add its package to the build environment`)
    }
    const importTarget = await this.importConditionTarget(specifier, resolved)
    const importerPackage = await this.packageOf(importer)
    const targetPackage = await this.packageOf(resolved)
    if (targetPackage === undefined) {
      throw new Error(`helper closure: ${JSON.stringify(specifier)} imported by ${importer} resolves to ${resolved}, which has no owning package.json`)
    }
    if (isRelativeSpecifier(specifier) && targetPackage.root !== importerPackage?.root) {
      /* v8 ignore next -- follow() only runs for a file whose owning package was already resolved */
      const importerName = importerPackage?.name ?? '(none)'
      throw new Error(`helper closure: relative import ${JSON.stringify(specifier)} in ${importer} leaves package ${importerName} for package ${targetPackage.name}; relative imports must stay inside their own package`)
    }
    this.enqueue(resolved)
    if (importTarget !== undefined) this.enqueue(importTarget)
  }

  /**
   * Resolve the same bare specifier through the ESM `import` condition.
   *
   * `createRequire().resolve` applies the `require` condition, so a dual-mode
   * package such as zod yields only its CommonJS entry while the helper imports
   * the ESM one. The ESM entry is read from the package's own `exports` field so
   * both reachable halves enter the closure.
   * @param specifier - literal module specifier.
   * @param resolved - target already resolved under the `require` condition.
   * @returns the differing `import` target, or undefined when the package exposes none.
   * @throws when the owning manifest cannot be re-read.
   */
  private async importConditionTarget(specifier: string, resolved: string): Promise<string | undefined> {
    const packageName = packageNameOf(specifier)
    if (packageName === undefined) return undefined
    const owner = await this.packageOf(resolved)
    if (owner === undefined) return undefined
    const manifest = JSON.parse(await readFile(join(owner.root, 'package.json'), 'utf8')) as { exports?: unknown }
    if (manifest.exports === undefined) return undefined
    const subpath = specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`
    const target = resolveExportTarget(manifest.exports, subpath)
    if (target === undefined || !target.startsWith('./')) return undefined
    const importTarget = resolve(owner.root, target)
    return importTarget === resolved ? undefined : importTarget
  }

  /**
   * Whether one unresolvable specifier is an optional dependency of its importer.
   *
   * Platform packages such as koffi's `@koromix/koffi-linux-arm64` are declared
   * optional and loaded from `try` blocks; they are legitimately absent off their
   * own platform, while a missing required dependency stays fatal.
   * @param importer - absolute file that carries the specifier.
   * @param specifier - literal module specifier that failed to resolve.
   * @returns true when the importer declares the package as optional.
   * @throws when the owning manifest cannot be re-read.
   */
  private async isOptionalDependency(importer: string, specifier: string): Promise<boolean> {
    const packageName = packageNameOf(specifier)
    if (packageName === undefined) return false
    const owner = await this.packageOf(importer)
    /* v8 ignore next -- follow() only runs for a file whose owning package was already resolved */
    if (owner === undefined) return false
    const manifest = JSON.parse(await readFile(join(owner.root, 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, string> }
    return Object.hasOwn(manifest.optionalDependencies ?? {}, packageName)
  }

  /**
   * Copy every copyable file of a package that must be taken whole.
   * @param owner - package whose directory is copied in full.
   * @throws when a copied file exceeds a limit.
   */
  private async expandPackage(owner: CollectedPackage): Promise<void> {
    if (this.expanded.has(owner.root)) return
    this.expanded.add(owner.root)
    for (const file of await listPackageTree(owner.root)) {
      await this.copySourceFile(file)
      if (SCRIPT_SUFFIXES.some(suffix => file.endsWith(suffix))) this.enqueue(file)
    }
  }

  /**
   * Copy one source file and its owning package manifest into the staging tree.
   * @param file - absolute source file.
   * @throws when the file has no owning package, is not a regular file, or exceeds a size or file-count limit.
   */
  private async copySourceFile(file: string): Promise<void> {
    if (this.copied.has(file)) return
    const owner = await this.packageOf(file)
    /* v8 ignore next 2 -- every reachable caller already resolved this file's owning package */
    if (owner === undefined) {
      throw new Error(`helper closure: ${file} has no owning package.json`)
    }
    const target = this.stagingPath(owner, file)
    const info = await stat(file)
    /* v8 ignore next 2 -- the entry check and the package walk admit only regular files */
    if (!info.isFile()) {
      throw new Error(`helper closure: ${file} is not a regular file`)
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`helper closure: ${file} is ${String(info.size)} bytes, above the ${String(MAX_FILE_BYTES)}-byte per-file limit`)
    }
    if (this.files + 1 > MAX_CLOSURE_FILES) {
      throw new Error(`helper closure: the closure exceeds the ${String(MAX_CLOSURE_FILES)}-file limit; narrow the entry or raise MAX_CLOSURE_FILES deliberately`)
    }
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file, target)
    this.copied.add(file)
    this.files += 1
    // Node reads the nearest `package.json` to decide a file's module type, so
    // every manifest between the file and its package root travels with it.
    let directory = dirname(file)
    while (directory !== owner.root && directory.startsWith(owner.root)) {
      const nested = join(directory, 'package.json')
      if (!this.copied.has(nested) && await isFile(nested)) await this.copySourceFile(nested)
      directory = dirname(directory)
    }
    const manifest = join(owner.root, 'package.json')
    if (!this.copied.has(manifest)) await this.copySourceFile(manifest)
  }

  /**
   * Read the package that owns one file.
   * @param file - absolute file whose nearest ancestor `package.json` is sought.
   * @returns the owning package, or undefined when no ancestor declares one.
   * @throws when an ancestor manifest is unreadable or declares no name.
   */
  private packageOf(file: string): Promise<CollectedPackage | undefined> {
    const directory = dirname(file)
    const cached = this.packages.get(directory)
    if (cached !== undefined) return cached
    const pending = readOwningPackage(directory)
    this.packages.set(directory, pending)
    return pending
  }

  /**
   * Map one file inside its package to the staged absolute path.
   * @param owner - owning package.
   * @param file - absolute source file.
   * @returns the absolute staged path.
   * @throws when the package name is not a valid npm name or the file escapes its package root.
   */
  private stagingPath(owner: CollectedPackage, file: string): string {
    const inside = relative(owner.root, file)
    /* v8 ignore next 2 -- every caller passes a file that packageOf() resolved inside this root */
    if (inside.length === 0 || isAbsolute(inside) || inside.startsWith('..')) {
      throw new Error(`helper closure: ${file} is outside package ${owner.name} rooted at ${owner.root}`)
    }
    return join(this.stagingDir, 'node_modules', ...owner.name.split('/'), ...inside.split(sep))
  }

  /**
   * Append one file to the work queue once.
   * @param file - absolute source file.
   */
  private enqueue(file: string): void {
    if (this.queued.has(file)) return
    this.queued.add(file)
    this.queue.push(file)
  }
}

/**
 * Read the npm package that owns one directory.
 *
 * A `package.json` without a `name` is a subpath redirect inside its package
 * (zod's `v4/classic/package.json` is one), so the walk continues to the
 * nearest named manifest while keeping any `"type": "module"` it passed.
 * @param directory - absolute directory to start from.
 * @returns the owning package, or undefined when no ancestor declares one.
 * @throws when a manifest is unreadable, is not JSON, or declares an unusable name.
 */
async function readOwningPackage(directory: string): Promise<CollectedPackage | undefined> {
  let current = resolve(directory)
  let moduleTyped = false
  while (true) {
    const manifestPath = join(current, 'package.json')
    if (await isFile(manifestPath)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
      } catch (error) {
        throw new Error(`helper closure: ${manifestPath} is not readable JSON (${errorMessage(error)})`)
      }
      const manifest = parsed as { name?: unknown; type?: unknown }
      if (manifest.type === 'module') moduleTyped = true
      if (manifest.name !== undefined) {
        if (typeof manifest.name !== 'string' || !/^(?:@[^/]+\/)?[^/]+$/u.test(manifest.name)) {
          throw new Error(`helper closure: ${manifestPath} must declare an npm package name, received ${JSON.stringify(manifest.name)}`)
        }
        return {
          root: current,
          name: manifest.name,
          reachableOnly: moduleTyped || manifest.name.startsWith('@deepseek-ai/'),
        }
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Prepare an empty staging directory.
 * @param directory - staging directory to create or verify.
 * @throws when the path exists as a non-directory or already holds entries.
 */
async function prepareStagingDirectory(directory: string): Promise<void> {
  let info
  try {
    info = await stat(directory)
  } catch (error) {
    if (!isNotFound(error)) throw error
    await mkdir(directory, { recursive: true })
    return
  }
  if (!info.isDirectory()) {
    throw new Error(`helper closure: stagingDir ${directory} exists and is not a directory`)
  }
  const entries = await readdir(directory)
  if (entries.length > 0) {
    throw new Error(`helper closure: stagingDir ${directory} is not empty; remove it or pass a fresh directory so a stale closure cannot mix with the new one`)
  }
}

/**
 * List every file of a package directory, applying the whole-directory exclusions.
 * @param root - absolute package root.
 * @returns absolute file paths in deterministic order.
 */
async function listPackageTree(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => compareBytes(left.name, right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      if (SKIPPED_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) continue
      files.push(path)
    }
  }
  await walk(root)
  return files
}

/**
 * List every file under a staging directory as archive paths.
 * @param root - absolute staging directory.
 * @returns archive paths using `/`, sorted by path bytes.
 */
async function listStagingFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), path)
        continue
      }
      if (entry.isFile()) files.push(path.slice(1))
    }
  }
  await walk(root, '')
  files.sort(compareBytes)
  return files
}

/**
 * Find literal module specifiers in one script source.
 *
 * Comments and string bodies are skipped, so only `from "…"`, side-effect
 * `import "…"`, dynamic `import("…")`, and `require("…")` literals are returned;
 * template or computed specifiers are ignored.
 * @param source - JavaScript or TypeScript source text.
 * @returns literal specifiers in source order.
 */
function scanSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  let index = 0
  while (index < source.length) {
    /* v8 ignore next -- index is bounded by the source length, so the read is always defined */
    const character = source[index] ?? ''
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2)
      index = end < 0 ? source.length : end + 1
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      index = skipQuoted(source, index)
      continue
    }
    if (isWordStart(character) && !isWordCharacter(source[index - 1] ?? '')) {
      const word = readWord(source, index)
      if ((word === 'import' || word === 'require' || word === 'from') && !isMemberAccess(source, index)) {
        const match = readSpecifierLiteral(source, index + word.length, word !== 'from')
        if (match !== undefined) {
          specifiers.push(match.value)
          index = match.end
          continue
        }
      }
      index += word.length
      continue
    }
    index += 1
  }
  return specifiers
}

/**
 * Read a quoted specifier that follows one import-like keyword.
 * @param source - source text.
 * @param index - index just past the keyword.
 * @param allowCall - whether a `(` may separate the keyword from its literal (`import` and `require`
 *   only, because `Buffer.from('…')` is not an import).
 * @returns the literal and the index past its closing quote, or undefined when the keyword takes no literal here.
 */
function readSpecifierLiteral(source: string, index: number, allowCall: boolean): SpecifierMatch | undefined {
  let cursor = skipTrivia(source, index)
  if (allowCall && source[cursor] === '(') cursor = skipTrivia(source, cursor + 1)
  const quote = source[cursor]
  if (quote !== '"' && quote !== "'") return undefined
  const end = source.indexOf(quote, cursor + 1)
  if (end < 0) return undefined
  return { value: source.slice(cursor + 1, end), end: end + 1 }
}

/**
 * Whether one keyword is reached through a member access, as in `Buffer.from(…)` or `stream.require(…)`.
 * @param source - source text.
 * @param index - index of the keyword.
 * @returns true when the preceding non-whitespace character is `.`.
 */
function isMemberAccess(source: string, index: number): boolean {
  let cursor = index - 1
  /* v8 ignore next -- the loop stops at cursor 0, so the read is always defined */
  while (cursor >= 0 && /\s/u.test(source[cursor] ?? '')) cursor -= 1
  return source[cursor] === '.'
}

/**
 * Skip whitespace and comments.
 * @param source - source text.
 * @param index - starting index.
 * @returns the first index of non-trivia content.
 */
function skipTrivia(source: string, index: number): number {
  let cursor = index
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      cursor += 1
      continue
    }
    if (character === '/' && source[cursor + 1] === '/') {
      const end = source.indexOf('\n', cursor + 2)
      cursor = end < 0 ? source.length : end + 1
      continue
    }
    if (character === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2)
      cursor = end < 0 ? source.length : end + 2
      continue
    }
    return cursor
  }
  return cursor
}

/**
 * Skip one quoted string or template literal.
 * @param source - source text.
 * @param index - index of the opening quote.
 * @returns the index just past the closing quote, or the source length when unterminated.
 */
function skipQuoted(source: string, index: number): number {
  const quote = source[index]
  let cursor = index + 1
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === '\\') {
      cursor += 2
      continue
    }
    if (character === quote) return cursor + 1
    cursor += 1
  }
  return source.length
}

/**
 * Whether one character can start an identifier.
 * @param character - single character.
 * @returns true for ASCII letter, `_`, or `$`.
 */
function isWordStart(character: string): boolean {
  return /[A-Za-z_$]/u.test(character)
}

/**
 * Whether one character can continue an identifier.
 * @param character - single character.
 * @returns true for ASCII letter, digit, `_`, or `$`.
 */
function isWordCharacter(character: string): boolean {
  return /[A-Za-z0-9_$]/u.test(character)
}

/**
 * Read one identifier starting at an index.
 * @param source - source text.
 * @param index - starting index.
 * @returns the identifier text.
 */
function readWord(source: string, index: number): string {
  let cursor = index
  /* v8 ignore next -- the loop stays inside the source, so the read is always defined */
  while (cursor < source.length && isWordCharacter(source[cursor] ?? '')) cursor += 1
  return source.slice(index, cursor)
}

/**
 * Whether one specifier is relative or absolute.
 * @param specifier - module specifier.
 * @returns true when it starts with `.` or `/`.
 */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/')
}

/**
 * Read the package name from one bare specifier.
 * @param specifier - module specifier.
 * @returns the package name, or undefined for a builtin, relative, absolute, or `#imports` specifier.
 */
function packageNameOf(specifier: string): string | undefined {
  if (isRelativeSpecifier(specifier) || specifier.startsWith('#') || specifier.includes(':')) return undefined
  const parts = specifier.split('/')
  const first = parts[0]
  if (first === undefined || first.length === 0) return undefined
  if (!specifier.startsWith('@')) return first
  const second = parts[1]
  return second === undefined || second.length === 0 ? undefined : `${first}/${second}`
}

/**
 * Resolve one package subpath through an `exports` field under import conditions.
 * @param exports - the manifest's `exports` value.
 * @param subpath - `.` or one `./…` package subpath.
 * @returns the declared target, or undefined when these conditions expose none.
 */
function resolveExportTarget(exports: unknown, subpath: string): string | undefined {
  if (typeof exports === 'string' || Array.isArray(exports)) {
    return subpath === '.' ? conditionTarget(exports) : undefined
  }
  if (!isRecord(exports)) return undefined
  if (Object.keys(exports).some(key => key === '.' || key.startsWith('./'))) {
    return subpathMapTarget(exports, subpath)
  }
  return subpath === '.' ? conditionTarget(exports) : undefined
}

/**
 * Match one subpath against an `exports` subpath map, exact keys first.
 * @param record - subpath map.
 * @param subpath - requested subpath.
 * @returns the declared target with any `*` replaced, or undefined when no key matches.
 */
function subpathMapTarget(record: Record<string, unknown>, subpath: string): string | undefined {
  if (Object.hasOwn(record, subpath)) return conditionTarget(record[subpath])
  let bestKey: string | undefined
  let bestStar = ''
  for (const key of Object.keys(record)) {
    const starAt = key.indexOf('*')
    if (starAt < 0) continue
    const prefix = key.slice(0, starAt)
    const suffix = key.slice(starAt + 1)
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) continue
    if (bestKey === undefined || key.length > bestKey.length) {
      bestKey = key
      bestStar = subpath.slice(prefix.length, subpath.length - suffix.length)
    }
  }
  return bestKey === undefined ? undefined : conditionTarget(record[bestKey])?.replaceAll('*', bestStar)
}

/**
 * Pick the first matching condition target.
 * @param value - string, array, or conditions object from an `exports` field.
 * @returns the declared target, or undefined when no condition matches.
 */
function conditionTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = conditionTarget(entry)
      if (target !== undefined) return target
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const condition of IMPORT_CONDITIONS) {
    if (!Object.hasOwn(value, condition)) continue
    const target = conditionTarget(value[condition])
    if (target !== undefined) return target
  }
  return undefined
}

/**
 * Whether one value is a plain object.
 * @param value - value to test.
 * @returns true for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Render the artifact manifest.
 * @param artifact - packed artifact.
 * @param files - copied file count.
 * @returns the manifest JSON with two-space indentation and a trailing newline.
 */
function renderManifest(artifact: HelperArtifact, files: number): string {
  return `${JSON.stringify({ entry: artifact.entry, digest: artifact.digest, archive: `dsh-ssh-helper-${artifact.digest}.tar.gz`, files }, null, 2)}\n`
}

/**
 * Build one ustar header for a regular file.
 * @param path - archive path.
 * @param size - file byte length.
 * @returns the 512-byte header.
 * @throws when the path is unsafe or too long for a ustar header.
 */
function tarHeader(path: string, size: number): Buffer {
  validateArchivePath(path)
  const header = Buffer.alloc(TAR_BLOCK_BYTES)
  const { name, prefix } = splitTarPath(path)
  writeBytes(header, 0, 100, name)
  writeOctal(header, 100, 8, 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  writeBytes(header, 257, 6, 'ustar')
  writeBytes(header, 263, 2, '00')
  if (prefix !== undefined) writeBytes(header, 345, 155, prefix)
  let sum = 0
  for (const byte of header) sum += byte
  writeBytes(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return header
}

/**
 * Reject archive paths that would escape the extraction root or break the format.
 * @param path - archive path using `/`.
 * @throws when the path is empty, absolute, has an empty, `.` or `..` segment, or carries control characters.
 */
function validateArchivePath(path: string): void {
  if (path.length === 0) throw new Error('helper artifact: archive path must not be empty')
  if (path.startsWith('/')) throw new Error(`helper artifact: archive path ${JSON.stringify(path)} must be relative`)
  for (const character of path) {
    /* v8 ignore next -- iterating a string yields one non-empty code-point string, so codePointAt(0) is defined */
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`helper artifact: archive path ${JSON.stringify(path)} carries control characters`)
    }
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new Error(`helper artifact: archive path ${JSON.stringify(path)} has an unsafe ${JSON.stringify(segment)} segment`)
    }
  }
}

/**
 * Split one path across the ustar `name` and `prefix` fields.
 * @param path - archive path.
 * @returns the name and optional prefix field values.
 * @throws when no split fits both fields.
 */
function splitTarPath(path: string): { name: string; prefix: string | undefined } {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: undefined }
  const segments = path.split('/')
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join('/')
    const name = segments.slice(index).join('/')
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix }
    }
  }
  throw new Error(`helper artifact: archive path ${JSON.stringify(path)} is too long for a ustar header`)
}

/**
 * Write one octal field with its terminating NUL.
 * @param header - header bytes.
 * @param offset - field offset.
 * @param width - field width including the terminator.
 * @param value - non-negative integer.
 * @throws when the value does not fit the field.
 */
function writeOctal(header: Buffer, offset: number, width: number, value: number): void {
  const text = value.toString(8).padStart(width - 1, '0')
  /* v8 ignore next 2 -- callers pass a file size bounded by MAX_FILE_BYTES and fixed metadata values */
  if (text.length > width - 1) {
    throw new Error(`helper artifact: value ${String(value)} does not fit a ${String(width)}-byte octal field`)
  }
  writeBytes(header, offset, width - 1, text)
  header[offset + width - 1] = 0
}

/**
 * Write UTF-8 bytes into one fixed-width field.
 * @param header - header bytes.
 * @param offset - field offset.
 * @param width - field width.
 * @param value - text to write.
 * @throws when the encoded text is wider than the field.
 */
function writeBytes(header: Buffer, offset: number, width: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  /* v8 ignore next 2 -- splitTarPath bounds the name and prefix fields, and the rest are fixed literals */
  if (bytes.length > width) {
    throw new Error(`helper artifact: ${JSON.stringify(value)} is ${String(bytes.length)} bytes, wider than the ${String(width)}-byte tar field`)
  }
  bytes.copy(header, offset)
}

/**
 * Parse one octal header field.
 * @param header - header bytes.
 * @param offset - field offset.
 * @param width - field width.
 * @returns the parsed value, or 0 for an empty field.
 */
function parseOctal(header: Uint8Array, offset: number, width: number): number {
  let text = ''
  for (let index = offset; index < offset + width; index += 1) {
    /* v8 ignore next -- the field stays inside the header, so the read is always defined */
    const byte = header[index] ?? 0
    if (byte === 0 || byte === 0x20) break
    text += String.fromCharCode(byte)
  }
  if (text.length === 0) return 0
  const parsed = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`helper artifact: tar field ${JSON.stringify(text)} is not a valid octal number`)
  }
  return parsed
}

/**
 * Read one NUL-terminated header field.
 * @param header - header bytes.
 * @param offset - field offset.
 * @param width - field width.
 * @returns the decoded text before the first NUL.
 */
function readCString(header: Uint8Array, offset: number, width: number): string {
  let end = offset
  /* v8 ignore next -- the field stays inside the header, so the read is always defined */
  while (end < offset + width && (header[end] ?? 0) !== 0) end += 1
  return Buffer.from(header.subarray(offset, end)).toString('utf8')
}

/**
 * Round one byte length up to a tar block boundary.
 * @param size - byte length.
 * @returns the padded length.
 */
function alignToBlock(size: number): number {
  return Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
}

/**
 * Whether one block is entirely zero, which marks the end of a tar.
 * @param block - one tar block.
 * @returns true when every byte is zero.
 */
function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) return false
  }
  return true
}

/**
 * Compare two archive paths by their UTF-8 bytes.
 * @param left - first path.
 * @param right - second path.
 * @returns negative, zero, or positive as `left` sorts before, equal to, or after `right`.
 */
function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Whether one path exists as a regular file.
 * @param path - absolute path.
 * @returns true when the path is a regular file.
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/**
 * Whether one filesystem error means the path does not exist.
 * @param error - thrown value.
 * @returns true for an `ENOENT` filesystem error.
 */
function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Describe one thrown value for an actionable error message.
 * @param error - thrown value.
 * @returns the error message, or the stringified value.
 */
function errorMessage(error: unknown): string {
  /* v8 ignore next -- every caller forwards a Node fs or JSON.parse rejection, which is an Error */
  return error instanceof Error ? error.message : String(error)
}

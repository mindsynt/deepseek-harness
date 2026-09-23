/**
 * Build the uploadable POSIX SSH helper artifact.
 *
 * Collect the helper's dependency closure from a built entry file, prove the
 * closure loads without the repository `node_modules`, pack it into one
 * deterministic gzip tar, and write the archive and its manifest under the
 * output directory.
 *
 * @module scripts/build-ssh-helper-artifact
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { collectHelperClosure, packHelperArtifact } from '@deepseek-ai/dsh-helper-artifact'

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_ENTRY = 'packages/ssh/ssh/lib/helper.js'
const DEFAULT_OUT = 'dist/ssh-helper'

/** Exit code the helper reports when it is loaded without a remote transport. */
const EXPECTED_SELF_CHECK_CODE = 127

/** Stderr marker proving the helper module itself loaded and rejected the invocation. */
const EXPECTED_SELF_CHECK_STDERR = 'SSH helper accepts no command arguments'

/**
 * Decoy command argument for the load probe.
 *
 * The helper entry rejects a non-empty `process.argv` beyond the script path, so
 * `node <entry>` alone would read stdin and exit 0. Passing one argument makes a
 * loaded closure exit 127 with {@link EXPECTED_SELF_CHECK_STDERR}, while a broken
 * closure exits 1 with an unresolved-module error instead.
 */
const SELF_CHECK_ARGUMENT = '--load-probe'

/** Command-line help for the build script. */
const USAGE = `Usage: pnpm run build:ssh-helper-artifact [options]

Options:
  --entry <path>    Helper entry file, absolute or repository-relative (default: ${DEFAULT_ENTRY})
  --out <dir>       Output directory for the archive and manifest (default: ${DEFAULT_OUT})
  --staging <dir>   Staging directory to fill; a temporary directory is used and removed when omitted
  --help, -h        Print this help

Run \`pnpm run build:lib:host\` first so the helper entry exists.`

/**
 * Resolve one command-line path against the repository root.
 * @param value - absolute or repository-relative path.
 * @returns the absolute path.
 */
function repositoryPath(value: string): string {
  return isAbsolute(value) ? value : resolve(ROOT, value)
}

/**
 * Parse command-line options and print usage on a malformed invocation.
 * @returns the parsed option values, or undefined when parsing failed.
 */
function options(): { entry?: string; out?: string; staging?: string; help?: boolean } | undefined {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        entry: { type: 'string' },
        out: { type: 'string' },
        staging: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }).values
  } catch (error) {
    process.stderr.write(`build:ssh-helper-artifact: ${errorMessage(error)}\n${USAGE}\n`)
    process.exitCode = 1
    return undefined
  }
}

/**
 * Run the staged entry under plain Node from the staging directory.
 * @param entryPath - absolute staged entry file.
 * @param cwd - process working directory, set to the staging directory.
 * @returns the exit code and captured stderr.
 * @throws when the child process cannot be spawned.
 */
function runStagedEntry(entryPath: string, cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [entryPath, SELF_CHECK_ARGUMENT], { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', fail)
    child.once('close', (code) => {
      settle({ code, stderr })
    })
  })
}

/**
 * Prove a staged closure loads without the repository `node_modules`.
 * @param stagingDir - staging directory the closure was collected into.
 * @param entry - archive entry path inside the staging directory.
 * @throws when the entry does not exit 127 with the helper's no-arguments message.
 */
async function assertClosureLoads(stagingDir: string, entry: string): Promise<void> {
  const entryPath = join(stagingDir, ...entry.split('/'))
  const { code, stderr } = await runStagedEntry(entryPath, stagingDir)
  if (code === EXPECTED_SELF_CHECK_CODE && stderr.includes(EXPECTED_SELF_CHECK_STDERR)) return
  throw new Error(
    `the staged helper entry ${entryPath} did not load: expected exit code ${String(EXPECTED_SELF_CHECK_CODE)} with stderr containing ${JSON.stringify(EXPECTED_SELF_CHECK_STDERR)}, `
    + `received exit code ${String(code)} with stderr ${JSON.stringify(stderr.trim())}`,
  )
}

/**
 * Build one helper artifact and print its summary.
 * @throws when the entry is missing, collection or packing fails, or the self-check rejects the closure.
 */
async function main(): Promise<void> {
  const parsed = options()
  if (parsed === undefined) return
  if (parsed.help === true) {
    process.stdout.write(`${USAGE}\n`)
    return
  }

  const entryFile = repositoryPath(parsed.entry ?? DEFAULT_ENTRY)
  try {
    const info = await stat(entryFile)
    if (!info.isFile()) throw new Error('not a regular file')
  } catch (error) {
    throw new Error(`helper entry ${entryFile} is unavailable (${errorMessage(error)}); run \`pnpm run build:lib:host\` first`)
  }

  const outDir = repositoryPath(parsed.out ?? DEFAULT_OUT)
  const stagingDir = parsed.staging === undefined
    ? await mkdtemp(join(tmpdir(), 'dsh-ssh-helper-artifact-'))
    : repositoryPath(parsed.staging)
  const temporaryStaging = parsed.staging === undefined
  let keepStaging = false
  try {
    const closure = await collectHelperClosure({ entryFile, stagingDir })
    if (process.platform === 'win32') {
      console.log('build:ssh-helper-artifact: self-check skipped on Windows; the helper only supports POSIX remotes.')
    } else {
      await assertClosureLoads(stagingDir, closure.entry)
    }
    const artifact = await packHelperArtifact(closure)
    await mkdir(outDir, { recursive: true })
    const archiveName = `dsh-ssh-helper-${artifact.digest}.tar.gz`
    const artifactPath = join(outDir, archiveName)
    await writeFile(artifactPath, artifact.archive)
    await writeFile(
      join(outDir, 'manifest.json'),
      `${JSON.stringify({ entry: artifact.entry, digest: artifact.digest, archive: archiveName, files: closure.files }, null, 2)}\n`,
    )
    console.log(`build:ssh-helper-artifact: ${relative(ROOT, artifactPath)} entry=${artifact.entry} digest=${artifact.digest} files=${String(closure.files)}`)
  } catch (error) {
    keepStaging = true
    throw new Error(`${errorMessage(error)}\nbuild:ssh-helper-artifact: staging kept for inspection at ${stagingDir}`)
  } finally {
    if (temporaryStaging && !keepStaging) await rm(stagingDir, { recursive: true, force: true })
  }
}

/**
 * Describe one thrown value for an actionable message.
 * @param error - thrown value.
 * @returns the error message, or the stringified value.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

await main().catch((error: unknown) => {
  process.stderr.write(`build:ssh-helper-artifact: ${errorMessage(error)}\n`)
  process.exitCode = 1
})

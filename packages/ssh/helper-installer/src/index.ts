/**
 * Remote SSH helper provisioning: this plugin uploads a caller-supplied helper
 * archive through the local OpenSSH client, verifies the installed entry
 * digest on the host, and returns the coordinates an SSH connection needs.
 *
 * The installer predates any helper RPC, so it drives `ssh` directly.
 *
 * @module @deepseek-ai/dsh-helper-installer
 */

import { spawn } from 'node:child_process'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  HelperInstallation,
  HelperInstallRequest,
  RemoteCommandResult,
  RemoteCommandRunner,
  RemoteCommandRunOptions,
  SshHelperInstaller,
} from './types.ts'

export type {
  HelperInstallation,
  HelperInstallRequest,
  RemoteCommandResult,
  RemoteCommandRunner,
  RemoteCommandRunOptions,
  RemoteHelperArtifact,
  SshHelperInstaller,
} from './types.ts'

/** Stable plugin name of the SSH helper installer. */
export const name = 'ssh-helper-installer'

/** The installer drives the local OpenSSH client and needs no other service. */
export const inject: string[] = []

/** Node engine range the remote helper must run under; mirrors the repository engines field. */
export const SSH_HELPER_NODE_ENGINE = '^22.19 || >=24'

/** Default deadline for one remote command, in milliseconds; `installTimeoutMs` overrides it. */
const DEFAULT_INSTALL_TIMEOUT_MS = 30_000

/** Plugin config for the remote command deadline and the local OpenSSH client. */
export interface Config {
  /** Deadline for one remote command, in milliseconds; defaults to 30,000. */
  installTimeoutMs?: number
  /** Local OpenSSH client configuration file passed to `ssh -F` when an install request names none. */
  sshConfigFile?: string
}

/** Runtime configuration schema for the SSH helper installer. */
export const Config: z<Config> = z.object({
  installTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(DEFAULT_INSTALL_TIMEOUT_MS),
  sshConfigFile: z.string(),
})

/** OpenSSH host alias the installer accepts. */
const HOST_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/u

/** Lowercase SHA-256 digest the install path and verification compare against. */
const SHA256 = /^[0-9a-f]{64}$/u

/** Characters that would split or reinterpret one remote command word. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u

/** One validated install target; every path is safe to quote into a remote command. */
interface InstallTarget {
  readonly host: string
  readonly root: string
  readonly workspace: string
  readonly installDir: string
  readonly entryPath: string
}

declare module '@deepseek-ai/cordis' {
  interface Context { sshHelperInstaller: SshHelperInstallerService }
}

/**
 * Installer service: places one verified helper artifact on a host, or confirms
 * an identical install already there. Every remote command is single-line and
 * single-quotes each interpolated path.
 */
export class SshHelperInstallerService extends Service implements SshHelperInstaller {
  private readonly runner: RemoteCommandRunner

  /**
   * @param ctx - context that owns the service registration.
   * @param config - remote command deadline and optional local OpenSSH client configuration.
   * @param runner - remote command runner; defaults to the local OpenSSH client runner.
   */
  constructor(ctx: Context, config: Config = {}, runner: RemoteCommandRunner = createSshRunner(config)) {
    super(ctx, 'sshHelperInstaller')
    this.runner = runner
  }

  /**
   * Provision one host, or confirm an identical install already exists.
   * @param request - host, remote root, workspace, artifact and optional local SSH client configuration.
   * @returns verified coordinates for the SSH connection config.
   * @throws when the host cannot run the engine range, a remote command fails, or the installed entry digest differs from the artifact.
   */
  async install(request: HelperInstallRequest): Promise<HelperInstallation> {
    const target = resolveTarget(request)
    const { host, workspace, installDir, entryPath } = target
    const digest = request.artifact.digest

    const probe = await this.runner.run(host, 'command -v node', runOptions(request))
    const node = probe.stdout.trim()
    if (probe.code !== 0 || node.length === 0) {
      throw nodeRequirementError(host, 'install Node on that host, or put its absolute executable first on the remote PATH')
    }
    if (!node.startsWith('/')) {
      throw nodeRequirementError(host, `command -v node returned ${JSON.stringify(node)}, which is not an absolute path; put an absolute Node executable first on the remote PATH`)
    }

    const version = await this.runner.run(host, 'node --version', runOptions(request))
    const parsed = version.code === 0 ? parseNodeVersion(version.stdout.trim()) : undefined
    if (parsed === undefined || !satisfiesNodeEngine(parsed.major, parsed.minor)) {
      throw nodeRequirementError(host, `node --version reported ${JSON.stringify(snippet(version.stdout))}; install Node ${SSH_HELPER_NODE_ENGINE} on that host`)
    }

    const installed = `test -f ${quote(entryPath)} && sha256sum ${quote(entryPath)}`
    const existing = await this.runner.run(host, installed, runOptions(request))
    if (existing.code === 0 && digestField(existing.stdout) === digest) {
      return { node, helper: entryPath, helperHash: digest, workspace }
    }

    const extract = `mkdir -p ${quote(installDir)} && tar -xzf - -C ${quote(installDir)}`
    const upload = await this.runner.run(host, extract, runOptions(request, request.artifact.archive))
    if (upload.code !== 0) {
      throw new Error(`ssh helper installer: uploading the helper to ${host} exited with code ${String(upload.code)}; the remote install is unconfirmed: ${snippet(upload.stderr)}`)
    }

    const remote = await this.runner.run(host, `sha256sum ${quote(entryPath)}`, runOptions(request))
    const remoteDigest = digestField(remote.stdout)
    if (remote.code !== 0 || remoteDigest !== digest) {
      throw new Error(`ssh helper installer: the helper on ${host} hashes to ${JSON.stringify(remoteDigest)} instead of the local artifact digest ${digest}; the remote install is unconfirmed`)
    }

    return { node, helper: entryPath, helperHash: digest, workspace }
  }
}

/**
 * Build the default runner: one local `ssh` invocation per remote command.
 *
 * A non-zero exit, a spawn error, and a timeout all resolve with a non-zero
 * `code`; `run` never rejects. A timeout terminates `ssh` with `SIGTERM` and
 * reports code 255 with the output collected so far.
 * @param config - installer configuration carrying the command deadline and optional local SSH config file.
 * @returns the runner used when the caller injects no runner.
 */
export function createSshRunner(config: Config = {}): RemoteCommandRunner {
  const timeoutMs = config.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  return {
    /**
     * Run one command on a host through the local OpenSSH client.
     * @param host - OpenSSH host alias.
     * @param command - command executed by the remote login shell.
     * @param options - optional standard input and per-call OpenSSH client configuration file.
     * @returns exit code, standard output and standard error.
     */
    run: (host, command, options) => runSsh(config, timeoutMs, host, command, options),
  }
}

/**
 * Mount the installer on a context.
 * @param ctx - context that owns the service registration.
 * @param config - remote command deadline and optional local OpenSSH client configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  new SshHelperInstallerService(ctx, config)
}

/**
 * Run one command over the local OpenSSH client and collect its result.
 * A per-call `sshConfigFile` overrides the plugin config one, and either adds
 * `-F` as the first client argument.
 * @param config - installer configuration; `sshConfigFile` adds `-F` when the call names none.
 * @param timeoutMs - deadline after which the client is terminated.
 * @param host - OpenSSH host alias.
 * @param command - command executed by the remote login shell.
 * @param options - optional standard input and per-call OpenSSH client configuration file.
 * @returns exit code, standard output and standard error; never rejects.
 */
function runSsh(
  config: Config,
  timeoutMs: number,
  host: string,
  command: string,
  options?: RemoteCommandRunOptions,
): Promise<RemoteCommandResult> {
  const sshConfigFile = options?.sshConfigFile ?? config.sshConfigFile
  const args = [
    ...sshConfigFile === undefined ? [] : ['-F', sshConfigFile],
    '-T',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', host, command,
  ]
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: string[] = []
    const stderr: string[] = []
    let timedOut = false
    let settled = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout.push(chunk) })
    child.stderr.on('data', (chunk: string) => { stderr.push(chunk) })
    // A remote command can exit before reading its input; the exit result owns the outcome.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stderr.push(error.message)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    timer.unref()
    child.once('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const diagnostics = stderr.join('')
      resolve({
        code: code ?? 255,
        stdout: stdout.join(''),
        stderr: timedOut ? `${diagnostics}\nssh helper installer: ssh ${host} timed out after ${String(timeoutMs)} ms` : diagnostics,
      })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({ code: 255, stdout: stdout.join(''), stderr: `${error.message}\n${stderr.join('')}`.trim() })
    })
    child.stdin.end(options?.stdin === undefined ? undefined : Buffer.from(options.stdin))
  })
}

/**
 * Build the runner options one install request supplies for each call.
 * @param request - the caller's provisioning request.
 * @param stdin - bytes this call writes to the remote command, absent for every read-only probe.
 * @returns the per-call stdin and the request's local SSH client configuration, each omitted when unset.
 */
function runOptions(request: HelperInstallRequest, stdin?: Uint8Array): RemoteCommandRunOptions {
  return {
    ...stdin === undefined ? {} : { stdin },
    ...request.sshConfigFile === undefined ? {} : { sshConfigFile: request.sshConfigFile },
  }
}

/**
 * Validate one request before any remote command runs.
 * @param request - the caller's provisioning request.
 * @returns the target with its digest-named install directory and entry path.
 * @throws when a field carries a control character or newline, the host is not an alias, or a path is not absolute.
 * @throws when the artifact digest is not a lowercase SHA-256.
 */
function resolveTarget(request: HelperInstallRequest): InstallTarget {
  const host = controlFree(request.host, 'host')
  if (!HOST_ALIAS.test(host)) throw new Error(`ssh helper installer: host ${JSON.stringify(host)} is not a valid OpenSSH host alias`)
  const root = controlFree(request.root, 'root')
  if (!root.startsWith('/')) throw new Error('ssh helper installer: root must be an absolute remote path')
  const workspace = controlFree(request.workspace, 'workspace')
  if (!workspace.startsWith('/')) throw new Error('ssh helper installer: workspace must be an absolute remote path')
  const entry = controlFree(request.artifact.entry, 'entry')
  if (entry.length === 0 || entry.startsWith('/')) throw new Error('ssh helper installer: entry must be a path relative to the archive root')
  if (!SHA256.test(request.artifact.digest)) throw new Error('ssh helper installer: artifact digest must be a lowercase SHA-256')
  const installDir = `${root}/${request.artifact.digest}`
  return { host, root, workspace, installDir, entryPath: `${installDir}/${entry}` }
}

/**
 * Reject a value that cannot travel as one remote shell word.
 * @param value - candidate text.
 * @param field - request field named in the diagnostic.
 * @returns the value when it carries no control character.
 * @throws when the value contains a control character or newline.
 */
function controlFree(value: string, field: string): string {
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`ssh helper installer: ${field} contains a control character or newline`)
  return value
}

/**
 * Quote one value as a POSIX single-quoted shell word.
 * @param value - value already rejected for control characters.
 * @returns the quoted word, with each embedded `'` written as `'\''`.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Decide whether a remote Node version satisfies {@link SSH_HELPER_NODE_ENGINE}.
 * @param major - major version component.
 * @param minor - minor version component.
 * @returns true for 22.19 and later 22.x minors, and for every major at or above 24.
 */
function satisfiesNodeEngine(major: number, minor: number): boolean {
  if (major === 22) return minor >= 19
  return major >= 24
}

/**
 * Parse the output of `node --version`.
 * @param output - trimmed command output.
 * @returns the major and minor components, or undefined when the line is not `vX.Y.Z`.
 */
function parseNodeVersion(output: string): { major: number; minor: number } | undefined {
  const match = /^v(\d+)\.(\d+)\.\d+$/u.exec(output)
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]) }
}

/**
 * Read the digest field of `sha256sum` output.
 * @param stdout - complete standard output of the command.
 * @returns the first whitespace-separated field, or an empty string when there is none.
 */
function digestField(stdout: string): string {
  /* v8 ignore next -- String.split always returns at least one element, so the noUncheckedIndexedAccess guard has no reachable input */
  return stdout.trim().split(/\s+/u, 1)[0] ?? ''
}

/**
 * Bound one diagnostic fragment so an error never echoes a whole remote transcript.
 * @param text - collected command output.
 * @returns at most 200 characters of trimmed output.
 */
function snippet(text: string): string {
  return text.trim().slice(0, 200)
}

/**
 * Build the actionable diagnostic for a host that cannot run the helper.
 * @param host - OpenSSH host alias.
 * @param detail - what the caller must change on that host.
 * @returns the error naming the host and the required engine range.
 */
function nodeRequirementError(host: string, detail: string): Error {
  return new Error(`ssh helper installer: ${host} cannot run the SSH helper (requires Node ${SSH_HELPER_NODE_ENGINE}); ${detail}`)
}

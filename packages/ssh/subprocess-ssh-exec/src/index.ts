/**
 * Subprocess provider over native SSH exec without a remote helper daemon.
 *
 * Implements the {@link SubprocessRuntime} seam directly over SSH exec
 * channels. The remote host needs only an OpenSSH server — no Node.js, no
 * helper daemon. Terminal allocation uses SSH PTY via `ssh -t`.
 *
 * @module @deepseek-ai/dsh-subprocess-ssh-exec
 */

import { PassThrough } from 'node:stream'
import { SubprocessRuntime, SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
  SubprocessTerminalSignal,
  SubprocessTerminalForeground,
  SubprocessTerminalActivity,
} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-ssh-native'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SshExecSubprocessRuntime
  }
}

/**
 * Remote subprocess runtime over SSH exec. One-shot commands are executed
 * via `ssh exec` channels; terminal sessions use SSH PTY allocation.
 */
export class SshExecSubprocessRuntime extends SubprocessRuntime {
  static inject = ['sshNative']

  /**
   * Resolve one configured executable in this provider's execution world.
   * @param command - absolute executable path or bare PATH name.
   * @returns a canonical executable path.
   * @throws SubprocessExecutableNotFoundError when the executable cannot be found.
   */
  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    void env
    void signal
    const path = await this.ctx.sshNative.resolveExecutable(command)
    if (path === undefined) {
      throw new SubprocessExecutableNotFoundError(`executable not found: ${command}`)
    }
    return path
  }

  /**
   * Inspect shell-selection facts in the provider's execution environment.
   * @returns platform and preferred shell.
   */
  override async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    void signal
    const { shellPath } = await this.ctx.sshNative.terminalEnvironment()
    return {
      platform: 'posix',
      defaultShell: shellPath,
    }
  }

  /**
   * Start one managed child process from a fully-specified spec.
   * @param spec - fully specified argv, cwd, stdio, and grace period.
   * @returns the live process handle.
   */
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const command = spec.argv.map(shellQuote).join(' ')
    const fullCommand = spec.cwd !== undefined ? `cd ${shellQuote(spec.cwd)} && ${command}` : command

    const stdoutStream = new PassThrough()
    const stderrStream = new PassThrough()

    const done = (async (): Promise<SubprocessOutcome> => {
      try {
        const handle = await this.ctx.sshNative.exec(fullCommand, {
          env: {},
          maxOutputBytes: 1024 * 1024,
        })
        const result = await handle.wait()
        stdoutStream.end(result.stdout)
        stderrStream.end(result.stderr)
        return {
          exitCode: result.code,
          signal: null,
        }
      } catch (error) {
        stdoutStream.destroy(error as Error)
        stderrStream.destroy(error as Error)
        throw error
      }
    })()

    done.catch(() => { /* errors surface through the streams */ })

    return {
      stdin: undefined,
      stdout: spec.stdio.stdout === 'pipe' ? stdoutStream : undefined,
      stderr: spec.stdio.stderr === 'pipe' ? stderrStream : undefined,
      control: undefined,
      collected: {},
      done,
      terminate: () => {
        // Termination is not supported for one-shot exec commands.
        // The command runs to completion.
      },
      waitForExit: async () => {
        await done
        return true
      },
    }
  }

  /**
   * Allocate a real terminal and start one owned process session.
   * @param spec - fully specified terminal spawn.
   * @returns the live terminal handle.
   */
  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const command = spec.argv.map(shellQuote).join(' ')
    const fullCommand = spec.cwd !== undefined ? `cd ${shellQuote(spec.cwd)} && ${command}` : command

    const output = new PassThrough()

    // Use PTY for terminal allocation.
    const handle = await this.ctx.sshNative.exec(fullCommand, {
      ...(spec.env === undefined ? {} : { env: spec.env }),
      pty: {
        cols: spec.cols,
        rows: spec.rows,
        term: spec.terminalType,
      },
      maxOutputBytes: 1024 * 1024 * 10,
    })

    // Wire output to the handle's stream.
    const resultPromise = handle.wait()
    resultPromise.then((result) => {
      output.end(result.stdout)
    }).catch((error) => {
      output.destroy(error as Error)
    })

    return {
      pid: 0,
      output,
      done: resultPromise.then(result => ({
        exitCode: result.code,
        signal: null,
      })),
      write: async (data: string) => {
        await handle.write(data)
      },
      resize: async (cols: number, rows: number) => {
        await handle.resize(cols, rows)
      },
      inspectForeground: async (): Promise<SubprocessTerminalForeground | undefined> => {
        return undefined
      },
      inspectActivity: async (): Promise<SubprocessTerminalActivity> => {
        return { state: 'unknown', revision: 0 }
      },
      signalForeground: async (_signal: SubprocessTerminalSignal): Promise<number> => {
        throw new Error('signalForeground is not supported in the SSH exec implementation')
      },
      terminate: async () => {
        await handle.terminate()
      },
    }
  }
}

/** Shell-quote a string for safe inclusion in a shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export default SshExecSubprocessRuntime

---
description: "Runs one-shot commands and SSH PTY terminal sessions on a remote POSIX host through the ctx.subprocess service, requiring only an OpenSSH server with no helper daemon."
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess-ssh-exec

English | [中文](README.zh.md)

## Summary

Run commands and interactive terminal sessions on a remote POSIX host through the `ctx.subprocess` service, requiring only an OpenSSH server on that host: no Node.js runtime and no helper daemon. One-shot commands execute as one SSH exec channel with piped stdout and stderr; terminal sessions allocate an SSH PTY and expose input, resize and termination. Executable lookup and shell selection are answered from the remote host's own environment. The cost: a running one-shot command cannot be stopped, its stdin is not writable, and every exit fact reports `signal: null`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service class with `ctx.plugin(SshExecSubprocessRuntime)`, or let the Loader mount it by the package name. It registers `ctx.subprocess` for the context it mounts into and injects `sshNative`, so activation waits for the [ssh-native](../ssh-native/README.md) connection. Mount it beside the SFTP filesystem provider that shares the same connection.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { SshExecSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh-exec'

export async function mount(realm: Context): Promise<void> {
  await realm.plugin(SshExecSubprocessRuntime)
}
```

The package declares no `Config` and reads no configuration field, so there is no `cordis.yml` surface to set. Connection coordinates come from the [ssh-native](../ssh-native/README.md) config mounted in the same context, and the [configuration catalog](../../../docs/config-catalog.md) lists this package with the injected service `sshNative` and no fields.

`SshExecSubprocessRuntime` overrides the four members of the [subprocess](../../subprocess/subprocess/README.md) seam:

| Member | Returns | Behavior |
|---|---|---|
| `resolveExecutable(command, env?, signal?)` | `Promise<string>` | Delegates to `sshNative.resolveExecutable(command)`; `env` and `signal` are unused. Throws `SubprocessExecutableNotFoundError` with the message `executable not found: <command>` when the connection returns `undefined`. |
| `terminalEnvironment(signal?)` | `Promise<SubprocessTerminalEnvironment>` | Returns `platform: 'posix'` with `defaultShell` from the remote `$SHELL`; `signal` is unused and the connection's `shellArgs` are dropped. |
| `spawn(spec)` | `SubprocessHandle` | Synchronous. Builds one shell command from `argv`, runs it through `sshNative.exec`, and streams the buffered result into `PassThrough` stdout and stderr. |
| `spawnTerminal(spec)` | `Promise<SubprocessTerminalHandle>` | Builds the same command, requests an SSH PTY, and returns the live terminal handle. |

A one-shot handle exposes `stdin: undefined`, `control: undefined` and `collected: {}`; `stdout` and `stderr` appear only when `spec.stdio` names `'pipe'` for that stream. `terminate()` is a no-op, so the command runs to completion, and `waitForExit()` awaits the outcome and returns `true`. `done` always resolves to `{ exitCode, signal: null }`; on failure both streams are destroyed with the error and the rejection is otherwise swallowed, so the error surfaces through the streams.

A terminal handle publishes `pid: 0` and one `output` stream fed from the channel's stdout only. `write(data)` and `resize(cols, rows)` forward to the SSH channel, and `terminate()` forwards to it as well. `inspectForeground()` returns `undefined`, `inspectActivity()` returns `{ state: 'unknown', revision: 0 }`, and `signalForeground(signal)` throws `signalForeground is not supported in the SSH exec implementation`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider installs no process on the remote host. It serializes one `argv` into a shell command string and hands that string to an `sshNative` exec channel, so every command the seam receives is interpreted by the remote host's shell. Each `argv` entry is quoted by `shellQuote`, which wraps the value in single quotes and escapes an embedded quote:

```ts
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
```

A `cwd` is prepended as `cd <quoted cwd> && <command>` before the channel opens. Executable lookup and shell inspection run through the same `exec` primitive, so each costs one remote round trip.

One-shot execution flows one way: the spec becomes a quoted command, the channel returns buffered `stdout` and `stderr`, both are ended onto the handle's streams, and then `done` resolves. `spawn()` always opens the channel with `env: {}` and caps collection at 1 MiB. `spawnTerminal()` forwards `spec.env` when it is set, requests a PTY with `spec.cols`, `spec.rows` and `spec.terminalType`, and caps collection at 10 MiB. The terminal path drops the stderr split entirely, because a PTY merges both streams into one.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | `SshExecSubprocessRuntime`, its four seam overrides, and `shellQuote`. |
| [`tests/index.spec.ts`](tests/index.spec.ts) | Builds the service against a stubbed `sshNative` and exercises `resolveExecutable` and `terminalEnvironment`. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — shared execution coordinates and transport ownership.
- [subprocess](../../subprocess/subprocess/README.md) — the seam contract this provider implements.
- [ssh-native](../ssh-native/README.md) — the OpenSSH connection and exec channels it drives.
- [fs-sftp](../fs-sftp/README.md) — the paired SFTP filesystem provider in the same realm.
- [configuration catalog](../../../docs/config-catalog.md) — every service this package injects.

-----

<a id="model-experience"></a>
## Model Experience

### Remote execution

#### What the model sees

Nothing. The provider registers no tool, prompt section, schema, or result of its own; the bash executors, PTY shell backend, LSP host, and out-of-process subagent backends that consume `ctx.subprocess` render every model-visible value, and each reaches whichever realm resolved this service.

#### Token effect

Executing a remote command changes no request prefix and adds no package-owned token budget: the provider only supplies exit facts, streams, executable paths, and shell selection to the consumers that assemble the request.

#### KV Cache effect

The provider contributes no request-prefix content, so request prefixes stay as the consumers compose them, and nothing it supplies can invalidate an already-reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One-shot commands cannot be stopped** — `SubprocessHandle.terminate()` is a no-op, so `graceMs` and `spec.signal` never influence the exec channel and the command runs to completion; `waitForExit()` only awaits the outcome and returns `true`.
- **One-shot commands have no stdin** — `stdin` is always `undefined`, so the `'pipe'` and `{ data }` stdin modes are ignored, and `spec.env` is never forwarded because the channel always opens with `env: {}`.
- **Exit facts never report a signal** — both paths resolve `{ exitCode, signal: null }`, so a consumer cannot distinguish a signal termination from a code exit, and `signalForeground()` throws unconditionally.
- **Foreground process groups are invisible** — `inspectForeground()` returns `undefined`, `inspectActivity()` returns `{ state: 'unknown', revision: 0 }`, and the handle publishes `pid: 0`; the provider holds no remote process-group identity to observe or escalate.
- **Terminal stderr is not separable** — `spawnTerminal()` exposes one `output` stream fed from the channel's stdout, so a PTY session has no stderr member.
- **Output is capped without spill** — `spawn()` collects at most 1 MiB and `spawnTerminal()` at most 10 MiB through `maxOutputBytes`, and `collected` is always `{}`, so no offset-based reader or spill path exists.
- **Command semantics belong to the remote shell** — `argv` is joined into one shell command and executed by the remote host's shell rather than dispatched as an argv vector, so argument boundaries rest entirely on single-quote escaping, a bare executable name resolves through the remote shell's PATH, and `terminalEnvironment()` reports the remote `$SHELL` value with the connection's `shellArgs` dropped.
- **`spawn` and `spawnTerminal` have no test coverage** — `tests/index.spec.ts` exercises only construction, `resolveExecutable`, and `terminalEnvironment` against a stubbed `sshNative`; neither exec-channel path is verified.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. The package has no `invariant/` directory, `package.json` exports no `./invariant` entry, and `tsconfig.json` references no `runtime-diagnostics/invariants` project: the provider stores no state of its own, so every value it returns is read directly off one `sshNative` call result and no two independent observations can diverge.

`package.json` lists `@deepseek-ai/schemastery` and `zod` in `dependencies` even though `src/index.ts` imports neither; both are leftovers from a `Config` that does not exist and are candidates for removal with the config surface.

The host registry README describes SSH PTY terminal sessions as read-only with stubbed input and resize. `spawnTerminal()` implements `write()`, `resize()`, and `terminate()`, so that sentence is stale.

</details>

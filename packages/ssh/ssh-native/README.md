---
description: "One SSH connection to one remote host over ssh2, exposing SFTP file operations, SSH exec, process and system inspection, and optional exponential-backoff reconnection."
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh-native

English | [中文](README.zh.md)

## Summary

`dsh-ssh-native` owns one SSH connection to one remote host over `ssh2`, serving it two ways: SFTP for stat, read, write, list, rename, copy and link operations, and SSH exec for commands with output caps, timeouts, stdin writes, PTY resize and signals. The remote host needs only an OpenSSH server. One service instance is one connection: `ready` resolves when the connection and the SFTP subsystem are open, a `close` event disposes the instance by default, and `reconnect.enabled` retries with exponential backoff instead. Process lists, process control and system information run through the same exec channel.

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

Mount the service in a composition with `await realm.plugin(SshNativeConnection, config)`, which is the packaged shape: [the host registry's native composition](../host-registry/README.md) does exactly that, then mounts the filesystem and subprocess providers beside it. The package default-exports the service class, registers it as `ctx.sshNative`, and declares no `static inject`, so no other service must be present for it to activate. Call `validateConfig()` to check a configuration without connecting.

| Field | Default | Meaning |
|---|---|---|
| `host` | required | Remote host address (hostname or IP) |
| `port` | `22` | Remote SSH port |
| `username` | required | Username |
| `privateKey` | none | Private key content (PEM format) |
| `password` | none | Password, mutually exclusive with `privateKey` |
| `identityFile` | none | Local identity file path |
| `knownHostsFile` | none | Path to a known_hosts file |
| `connectTimeout` | `30000` | Connection timeout in milliseconds, also passed to ssh2 as `readyTimeout` |
| `keepaliveInterval` | `30000` | Keepalive interval in milliseconds, capped at 600000 |
| `keepaliveCountMax` | `3` | Keepalive count max, capped at 100 |
| `strictHostKeyChecking` | `'accept-new'` | One of `'yes'`, `'no'`, `'accept-new'` |
| `maxSftpReadBytes` | `67108864` | Maximum bytes for `sftpRead` and `sftpReadStream`, capped at 1073741824 |
| `maxExecOutputBytes` | `67108864` | Maximum bytes per exec output stream, capped at 1073741824 |
| `reconnect.enabled` | `false` | Retry after the `close` event |
| `reconnect.maxAttempts` | `3` | Maximum reconnection attempts |
| `reconnect.delayMs` | `1000` | Base delay between attempts, in milliseconds |
| `reconnect.backoffMultiplier` | `2` | Multiplier applied to the delay per attempt |
| `compression` | `{ enabled: false, algorithm: 'zlib' }` | Parsed but never applied to the connection |
| `proxy` | none | Parsed but never applied to the connection |

`static Config` carries the flat connection fields only; `reconnect`, `compression`, and `proxy` are accepted by the runtime parse but are not part of it. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-ssh-native) lists every accepted field.

Readiness is the connection: `ready` resolves once the SSH connection and the SFTP subsystem are open, and `[Service.init]` awaits it. Before that, `clientConnection` throws `ssh-native: connection is not established` and `sftpClient` throws `ssh-native: SFTP subsystem is not available`. Once disposed, every operation rejects with `ssh-native: connection is disposed`.

The SFTP operations are `sftpStat`, `sftpLstat`, `sftpRead`, `sftpReadRange`, `sftpWrite`, `sftpMkdir`, `sftpReaddir`, `sftpRealpath`, `sftpUnlink`, `sftpChmod`, `sftpChown`, `sftpSymlink`, `sftpRename`, `sftpReadlink`, `sftpCopy`, `sftpFind`, `sftpBatch`, and `sftpReadStream`. `sftpStat` and `sftpLstat` resolve a missing path as `undefined`; `sftpRead` and `sftpReadStream` stat the path first, reject a missing path as `ssh-native: file not found: <path>`, and reject an oversized one as `ssh-native: file too large: <size> bytes exceeds <maxSftpReadBytes>`. `sftpReadStream` reads ranges of `chunkSize` bytes, defaulting to 65536, and stops on the final range rather than raising an error. `sftpBatch` accepts `stat`, `lstat`, `read`, `write`, `mkdir`, `readdir`, `realpath`, and `unlink` operations, runs them in order, and returns one `{ success, data?, error? }` per operation.

`exec(command, options)` returns a handle exposing `done`, `wait()`, `terminate()`, `write()`, `resize()`, and `signal()`. `options.cwd` is prepended as `cd <quoted> && <command>`, `env` and `pty` are forwarded to ssh2, and `maxOutputBytes` defaults to `maxExecOutputBytes`. `timeoutMs` resolves the handle with `code: -1` and appends `Process timed out after <timeoutMs>ms` to stderr; `signal()` accepts `SIGTERM`, `SIGKILL`, `SIGINT`, and `SIGHUP`, and `terminate()` ends the exec stream.

The exec-backed helpers are `resolveExecutable()` (`command -v`), `sftpFind()` (`find -name`), `terminalEnvironment()` (`echo "$SHELL"`, falling back to `/bin/bash` with `-l -i`), `listProcesses()` (`ps -eo pid,comm,args,%cpu,rss,user,state --no-headers`), `killProcess()` (`kill -<signal> <pid>`, defaulting to `SIGTERM`), and `getSystemInfo()` (`/proc/uptime`, `/proc/loadavg`, `/proc/meminfo`, and `df -B1`). `sftpMkdir(path, true)` creates parent directories because ssh2 has no recursive mkdir. `createSession()` merges a session-level `cwd`, `env`, and `pty` into each `exec()` it runs.

A connection that closes is retried only when `reconnect.enabled` is `true`: the `close` handler compares the attempt counter against `reconnect.maxAttempts` and calls `reconnect()`, which waits `delayMs * backoffMultiplier^attempt` before each attempt, opens a fresh client each time, resets the counter on success, and disposes the instance after the last failed attempt. With `reconnect.enabled` unset or false, `close` disposes the instance instead. `error` is not retried; an initial connection failure rejects `ready`, which fails activation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One service instance owns one ssh2 `Client` and one SFTP wrapper. The constructor registers the instance under the name `sshNative`, schedules `dispose()` through `ctx.effect(() => () => this.dispose())`, and starts the connection without awaiting it, so construction itself never fails on an unreachable host; `[Service.init]` is where readiness is enforced, and it awaits `ready`, which is how an unreachable host reaches activation. The class declares only `static Config` — no `static inject` — so activation has no other service to wait for.

Configuration passes through two validators. `SshNativeConfigSchema`, a schemastery object published as `static Config`, carries the flat connection fields and is what the Loader configures. A zod schema parses the full shape the constructor accepts, adding `reconnect`, `compression`, and `proxy` with their defaults and bounds, and throws when `host` or `username` is empty.

`connect()` assembles one ssh2 config from `host`, `port`, `username`, `readyTimeout` from `connectTimeout`, `keepaliveInterval`, `keepaliveCountMax`, and `strictHostKeyChecking`, then opens the SFTP subsystem. `privateKey` and `password` are mutually exclusive branches, and a set `identityFile` is read with `readFileSync` and overwrites `privateKey` in the same object. The `close` listener is attached only after both succeed, so a failure during connection and SFTP setup is a rejection rather than a retry decision.

`dispose()` marks the instance disposed, aborts its lifetime `AbortController`, terminates every live exec handle, closes SFTP, and ends the client. It is idempotent and is invoked both by disposal and by the connection-loss path.

`createSession()` keeps no long-lived shell: each call merges session options into a fresh `exec()`, and the ssh2 stream is created per command, so a `cd` or exported variable does not survive to the next command.

`metrics` reports only `connectionTime`; ssh2 exposes no request, byte, or latency counters, so the remaining fields stay at zero. `healthStatus` returns `'healthy'` or `'disconnected'`, never `'degraded'`.

| File | Contents |
|---|---|
| [src/index.ts](src/index.ts) | `SshNativeConnection`, both config schemas, connection and SFTP setup, exec, reconnection, disposal |
| [src/types.ts](src/types.ts) | `NativeSftpStat`, `NativeSftpEntry`, `NativeExecHandle`, `NativeExecOptions`, `NativeSessionHandle`, `NativeSystemInfo`, `ConnectionMetrics`, and the remaining public types |
| [tests/index.spec.ts](tests/index.spec.ts) | Unit tests over mocked `exec`, SFTP methods, and validation paths |
| [tests/integration.spec.ts](tests/integration.spec.ts) | Real-host tests that self-skip without `DEEPSEEK_SSH_TEST_HOST` |

The generated [ctx.sshNative API](../../../docs/subsystems/ssh.md#ctxsshnative--sshnativeconnection) owns the exhaustive method list.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — connection ownership, execution coordinates, and the generated `ctx.sshNative` API.
- [Host registry](../host-registry/README.md) — the per-host realm that mounts this service beside its execution providers.
- [Host credentials](../host-credentials/README.md) — the OpenSSH configuration, identity, and known_hosts a connection authenticates with.
- [fs-sftp](../fs-sftp/README.md) — the filesystem provider built on the SFTP operations here.
- [subprocess-ssh-exec](../subprocess-ssh-exec/README.md) — the subprocess provider built on `exec`.

-----

<a id="model-experience"></a>
## Model Experience

### Native SSH connection

#### What the model sees

Nothing. The service registers no tool, prompt section, or Session event; `ctx.sshNative` is a host-side capability consumed by [fs-sftp](../fs-sftp/README.md) and [subprocess-ssh-exec](../subprocess-ssh-exec/README.md), and those providers own every model-visible value and result.

#### Token effect

None. Connecting, reconnecting, SFTP calls, and exec runs add no request-prefix text, tool schema, or result content of their own.

#### KV Cache effect

None. The service contributes no request-prefix content, so it cannot invalidate a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `knownHostsFile`, `compression`, and `proxy` are parsed but never reach the ssh2 connection config, so a caller that sets them gets no custom verification path, no compression, and no jump host; `strictHostKeyChecking` is the only host-key control that takes effect.
- A dropped connection disposes the instance unless `reconnect.enabled` is `true`, so `ctx.sshNative` rejects permanently with `ssh-native: connection is disposed` for that realm; [the host registry](../host-registry/README.md) reopens the host rather than reviving the realm.
- Reconnection retries the `close` event only; an `error` before readiness, a refused connection, or an authentication failure rejects `ready` and fails activation without a retry.
- `healthStatus` returns only `'healthy'` or `'disconnected'`, so the declared `'degraded'` value is unreachable.
- `metrics` reports only `connectionTime`; `requestsSent`, `requestsReceived`, `bytesSent`, `bytesReceived`, and `avgLatency` stay `0` because ssh2 exposes no counters.
- `createSession()` shares no shell state: each command opens its own channel, so a `cd` or exported variable is not visible to the next command.
- Exec output past `maxOutputBytes` is dropped silently with no truncation marker, `resize()` and `signal()` act only when the ssh2 stream exposes `setWindow` and `sendSignal`, and `terminate()` ends the exec stream rather than sending a signal to the process.
- `getSystemInfo()` reads `/proc` and `killProcess()` uses `kill`, so both assume a Linux-like remote host.
- `sftpReadStream()` returns `null` on a failed range read instead of surfacing the error, and `sftpCopy()` copies through local memory rather than an SFTP copy request.
- `NativeSshConnectionId`, `NativeSftpRealpath`, and `NativeFileMode` are exported from `src/types.ts` but no service method returns them.
- No real remote end-to-end test runs in CI; `tests/integration.spec.ts` self-skips without `DEEPSEEK_SSH_TEST_HOST`, `DEEPSEEK_SSH_TEST_USER`, and a key or password.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Connection state is owned by one service instance and observed only through that instance's own operations, so no independent observation can diverge from it; `tsconfig.json` references only `vendor/cordis` and `vendor/schemastery`, with no `runtime-diagnostics/invariants` reference and no `lib/invariant.js` in `files`.

</details>

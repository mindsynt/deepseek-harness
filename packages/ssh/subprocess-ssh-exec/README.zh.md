---
description: "通过 ctx.subprocess 服务在远端 POSIX 主机上运行一次性命令与 SSH PTY 终端会话，只需该主机装有 OpenSSH 服务端，无需 helper daemon。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess-ssh-exec

[English](README.md) | 中文

## 概述

通过 `ctx.subprocess` 服务在远端 POSIX 主机上运行命令与交互式终端会话，该主机只需装有 OpenSSH 服务端：不需要 Node.js 运行时，也不需要 helper daemon。一次性命令以一条 SSH exec 通道执行，stdout 与 stderr 均以管道方式获取；终端会话分配 SSH PTY，并暴露输入、resize 与终止操作。可执行文件查找与 shell 选择由远端主机自身的环境回答。代价是：正在运行的一次性命令无法停止，其 stdin 不可写，且每次退出事实都报告 `signal: null`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用 `ctx.plugin(SshExecSubprocessRuntime)` 挂载该服务类，或让加载器按包名直接挂载。它在被挂载的 context 中注册 `ctx.subprocess`，并注入 `sshNative`，因此激活会等待 [ssh-native](../ssh-native/README.zh.md) 连接就绪。[host registry](../host-registry/README.zh.md) 把它挂载到每个 native 主机领域中，与共享同一条连接的 SFTP 文件系统提供方相邻。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { SshExecSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh-exec'

export async function mount(realm: Context): Promise<void> {
  await realm.plugin(SshExecSubprocessRuntime)
}
```

本包不声明 `Config`，也不读取任何配置字段，因此没有任何需要设置的 `cordis.yml` 表面。连接坐标来自同一 context 中挂载的 [ssh-native](../ssh-native/README.zh.md) 配置；[配置目录](../../../docs/config-catalog.zh.md) 将本包列为注入了 `sshNative` 服务且没有字段。

`SshExecSubprocessRuntime` 覆写了 [subprocess](../../subprocess/subprocess/README.zh.md) seam 的四个成员：

| 成员 | 返回类型 | 行为 |
|---|---|---|
| `resolveExecutable(command, env?, signal?)` | `Promise<string>` | 委托给 `sshNative.resolveExecutable(command)`；`env` 与 `signal` 均不使用。当连接返回 `undefined` 时抛出 `SubprocessExecutableNotFoundError`，消息为 `executable not found: <command>`。 |
| `terminalEnvironment(signal?)` | `Promise<SubprocessTerminalEnvironment>` | 返回 `platform: 'posix'`，`defaultShell` 取自远端 `$SHELL`；`signal` 不使用，连接返回的 `shellArgs` 被丢弃。 |
| `spawn(spec)` | `SubprocessHandle` | 同步。由 `argv` 构造一条 shell 命令，通过 `sshNative.exec` 执行，并把缓冲结果流入 `PassThrough` 的 stdout 与 stderr。 |
| `spawnTerminal(spec)` | `Promise<SubprocessTerminalHandle>` | 构造同一条命令，请求 SSH PTY，返回存活的终端句柄。 |

一次性句柄暴露 `stdin: undefined`、`control: undefined` 与 `collected: {}`；仅当 `spec.stdio` 对相应流声明 `'pipe'` 时，`stdout` 与 `stderr` 才出现。`terminate()` 是空操作，因此命令会一直运行到结束；`waitForExit()` 只等待退出结果并返回 `true`。`done` 总是解析为 `{ exitCode, signal: null }`；失败时两条流都会带上该错误被销毁，其余拒绝被吞掉，因此错误通过流暴露出来。

终端句柄发布 `pid: 0` 与一条仅由通道 stdout 供给的 `output` 流。`write(data)` 与 `resize(cols, rows)` 转发给 SSH 通道，`terminate()` 同样转发。`inspectForeground()` 返回 `undefined`，`inspectActivity()` 返回 `{ state: 'unknown', revision: 0 }`，`signalForeground(signal)` 抛出 `signalForeground is not supported in the SSH exec implementation`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本提供方在远端主机上不留驻任何进程。它把一条 `argv` 序列化成 shell 命令字符串，交给 `sshNative` exec 通道，因此 seam 收到的每条命令都由远端主机的 shell 解释。每个 `argv` 条目由 `shellQuote` 加引号：包裹在单引号内，并把内嵌的单引号转义：

```ts
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
```

打开通道前，`cwd` 被前置为 `cd <quoted cwd> && <command>`。可执行文件查找与 shell 探查走同一个 `exec` 原语，因此每次各花费一次远端往返。

一次性执行是单向的：spec 变成带引号的命令，通道返回缓冲的 `stdout` 与 `stderr`，两者被写入句柄的流并结束，随后 `done` 解析。`spawn()` 始终以 `env: {}` 打开通道，并把收集上限设为 1 MiB。`spawnTerminal()` 在 `spec.env` 已设置时转发它，用 `spec.cols`、`spec.rows` 与 `spec.terminalType` 请求 PTY，并把收集上限设为 10 MiB。终端路径完全去掉了 stderr 分流，因为 PTY 把两条流合并为一条。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `SshExecSubprocessRuntime`、四个 seam 覆写与 `shellQuote`。 |
| [`tests/index.spec.ts`](tests/index.spec.ts) | 以桩化 `sshNative` 构造服务，覆盖 `resolveExecutable` 与 `terminalEnvironment`。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 共享的执行坐标与传输所有权。
- [subprocess](../../subprocess/subprocess/README.zh.md) — 本提供方实现的 seam 契约。
- [host registry](../host-registry/README.zh.md) — 按主机挂载本提供方的组合。
- [ssh-native](../ssh-native/README.zh.md) — 它所驱动的 OpenSSH 连接与 exec 通道。
- [fs-sftp](../fs-sftp/README.zh.md) — 同一领域中配套的 SFTP 文件系统提供方。
- [配置目录](../../../docs/config-catalog.zh.md) — 本包注入的全部服务。

-----

<a id="model-experience"></a>
## 模型体验

### 远端执行

#### 模型看到什么

无。本提供方不注册自己的工具、提示段、schema 或结果；消费 `ctx.subprocess` 的 bash 执行器、PTY shell 后端、LSP host 与进程外 subagent 后端负责渲染每个面向模型的值，各自抵达解析出本服务的那个领域。

#### Token 影响

执行远端命令不改变请求前缀，也不增加本包拥有的 token 预算：本提供方只是把退出事实、流、可执行文件路径与 shell 选择交给组装请求的消费方。

#### KV Cache 影响

本提供方不贡献请求前缀内容，请求前缀保持由消费方组合出的样子，它提供的任何内容都不会使已可复用的前缀失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **一次性命令无法停止** — `SubprocessHandle.terminate()` 是空操作，因此 `graceMs` 与 `spec.signal` 都不影响 exec 通道，命令会一直运行到结束；`waitForExit()` 只等待退出结果并返回 `true`。
- **一次性命令没有 stdin** — `stdin` 恒为 `undefined`，因此 `'pipe'` 与 `{ data }` 两种 stdin 模式都被忽略；通道始终以 `env: {}` 打开，`spec.env` 也从不被转发。
- **退出事实从不报告信号** — 两条路径都解析为 `{ exitCode, signal: null }`，因此消费方无法区分信号终止与按码退出，`signalForeground()` 也一律抛出异常。
- **前台进程组不可见** — `inspectForeground()` 返回 `undefined`，`inspectActivity()` 返回 `{ state: 'unknown', revision: 0 }`，句柄发布 `pid: 0`；本提供方不持有可观察或可升级的远端进程组身份。
- **终端 stderr 无法分离** — `spawnTerminal()` 只暴露一条由通道 stdout 供给的 `output` 流，PTY 会话没有 stderr 成员。
- **输出有上限且无 spill** — `spawn()` 经 `maxOutputBytes` 最多收集 1 MiB，`spawnTerminal()` 最多 10 MiB，且 `collected` 恒为 `{}`，因此不存在偏移读取器或 spill 路径。
- **命令语义属于远端 shell** — `argv` 被拼成一条 shell 命令并由远端主机 shell 执行，而不是以 argv 向量派发，因此参数边界完全依赖单引号转义，裸命令名经由远端 shell 的 PATH 解析，`terminalEnvironment()` 也只报告远端 `$SHELL` 值，连接的 `shellArgs` 被丢弃。
- **`spawn` 与 `spawnTerminal` 没有测试覆盖** — `tests/index.spec.ts` 只用桩化 `sshNative` 覆盖构造、`resolveExecutable` 与 `terminalEnvironment`，两条 exec 通道路径都未经验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口。它没有 `invariant/` 目录，`package.json` 没有导出 `./invariant` 条目，`tsconfig.json` 也未引用 `runtime-diagnostics/invariants` 工程：本提供方不保存任何自有状态，它返回的每个值都直接读取自一次 `sshNative` 调用结果，因此不存在两个独立观察结果会分歧的情况。

`package.json` 在 `dependencies` 中列出 `@deepseek-ai/schemastery` 与 `zod`，但 `src/index.ts` 两者都未导入；这两项都是不存在的 `Config` 留下的残留，可与配置表面一并移除。

host registry 的 README 把 SSH PTY 终端会话描述为只读、输入与 resize 以桩形式占位。`spawnTerminal()` 已实现 `write()`、`resize()` 与 `terminate()`，因此该句已过时。

</details>

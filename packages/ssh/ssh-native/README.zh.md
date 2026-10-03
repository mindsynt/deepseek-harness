---
description: "通过 ssh2 持有一台远端主机的一个 SSH 连接，提供 SFTP 文件操作、SSH exec、进程与系统检查，以及可选的指数退避重连。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh-native

[English](README.md) | 中文

## 概述

`dsh-ssh-native` 通过 `ssh2` 持有一台远端主机的一个 SSH 连接，并以两种方式提供服务：通过 SFTP 完成 stat、读、写、列目录、重命名、复制与链接操作，通过 SSH exec 执行命令，并支持输出上限、超时、stdin 写入、PTY resize 与信号。远端主机只需具备 OpenSSH 服务。一个服务实例即一个连接：`ready` 在连接与 SFTP 子系统就绪时解析，`close` 事件默认析构该实例，而 `reconnect.enabled` 改为以指数退避重试。进程列表、进程控制与系统信息同样走该 exec 通道。

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

用 `await realm.plugin(SshNativeConnection, config)` 在组合中挂载该服务，这是其打包形态：[主机注册表的原生组合](../host-registry/README.zh.md) 正是如此，并在其旁挂载文件系统与子进程提供方。本包 default-export 服务类，将其注册为 `ctx.sshNative`，且不声明 `static inject`，因此激活时无需任何其他服务在场。调用 `validateConfig()` 可在不建立连接的情况下检查配置。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` | 必填 | 远端主机地址（主机名或 IP） |
| `port` | `22` | 远端 SSH 端口 |
| `username` | 必填 | 用户名 |
| `privateKey` | 无 | 私钥内容（PEM 格式） |
| `password` | 无 | 密码，与 `privateKey` 互斥 |
| `identityFile` | 无 | 本机身份文件路径 |
| `knownHostsFile` | 无 | known_hosts 文件路径 |
| `connectTimeout` | `30000` | 连接超时毫秒数，同时作为 `readyTimeout` 传给 ssh2 |
| `keepaliveInterval` | `30000` | 保活间隔毫秒数，上限 600000 |
| `keepaliveCountMax` | `3` | 保活次数上限，上限 100 |
| `strictHostKeyChecking` | `'accept-new'` | 取值为 `'yes'`、`'no'` 或 `'accept-new'` |
| `maxSftpReadBytes` | `67108864` | `sftpRead` 与 `sftpReadStream` 的最大字节数，上限 1073741824 |
| `maxExecOutputBytes` | `67108864` | 每条 exec 输出流的最大字节数，上限 1073741824 |
| `reconnect.enabled` | `false` | 在 `close` 事件后重试 |
| `reconnect.maxAttempts` | `3` | 最大重连次数 |
| `reconnect.delayMs` | `1000` | 相邻重试的基础延迟，单位为毫秒 |
| `reconnect.backoffMultiplier` | `2` | 每次重试施加到延迟上的倍率 |
| `compression` | `{ enabled: false, algorithm: 'zlib' }` | 被解析但从不作用于连接 |
| `proxy` | 无 | 被解析但从不作用于连接 |

`static Config` 只承载扁平的连接字段；`reconnect`、`compression` 与 `proxy` 被运行时解析接受，但不属于 `static Config`。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-ssh-native) 列出所有被接受的字段。

就绪即连接：`ready` 在 SSH 连接与 SFTP 子系统均打开后解析，`[Service.init]` 等待它。在此之前，`clientConnection` 抛出 `ssh-native: connection is not established`，`sftpClient` 抛出 `ssh-native: SFTP subsystem is not available`。一旦析构，每个操作都以 `ssh-native: connection is disposed` 拒绝。

SFTP 操作包括 `sftpStat`、`sftpLstat`、`sftpRead`、`sftpReadRange`、`sftpWrite`、`sftpMkdir`、`sftpReaddir`、`sftpRealpath`、`sftpUnlink`、`sftpChmod`、`sftpChown`、`sftpSymlink`、`sftpRename`、`sftpReadlink`、`sftpCopy`、`sftpFind`、`sftpBatch` 与 `sftpReadStream`。`sftpStat` 与 `sftpLstat` 对不存在的路径解析为 `undefined`；`sftpRead` 与 `sftpReadStream` 先 stat 该路径，对不存在的路径以 `ssh-native: file not found: <path>` 拒绝，对超限的路径以 `ssh-native: file too large: <size> bytes exceeds <maxSftpReadBytes>` 拒绝。`sftpReadStream` 按 `chunkSize` 字节读取范围，默认 65536，并在最后一个范围结束时停止而不是抛出错误。`sftpBatch` 接受 `stat`、`lstat`、`read`、`write`、`mkdir`、`readdir`、`realpath` 与 `unlink` 操作，按顺序执行，并为每个操作返回一条 `{ success, data?, error? }`。

`exec(command, options)` 返回一个句柄，暴露 `done`、`wait()`、`terminate()`、`write()`、`resize()` 与 `signal()`。`options.cwd` 被前置为 `cd <quoted> && <command>`，`env` 与 `pty` 转发给 ssh2，`maxOutputBytes` 默认取 `maxExecOutputBytes`。`timeoutMs` 以 `code: -1` 解析该句柄，并向 stderr 追加 `Process timed out after <timeoutMs>ms`；`signal()` 接受 `SIGTERM`、`SIGKILL`、`SIGINT` 与 `SIGHUP`，`terminate()` 结束 exec 流。

基于 exec 的辅助方法包括 `resolveExecutable()`（`command -v`）、`sftpFind()`（`find -name`）、`terminalEnvironment()`（`echo "$SHELL"`，失败时回退到带 `-l -i` 的 `/bin/bash`）、`listProcesses()`（`ps -eo pid,comm,args,%cpu,rss,user,state --no-headers`）、`killProcess()`（`kill -<signal> <pid>`，默认 `SIGTERM`）与 `getSystemInfo()`（`/proc/uptime`、`/proc/loadavg`、`/proc/meminfo` 与 `df -B1`）。`sftpMkdir(path, true)` 会创建父目录，因为 ssh2 没有递归 mkdir。`createSession()` 将会话级 `cwd`、`env` 与 `pty` 合并进其执行的每个 `exec()`。

只有当 `reconnect.enabled` 为 `true` 时，被关闭的连接才会重试：`close` 处理程序把尝试计数与 `reconnect.maxAttempts` 比较并调用 `reconnect()`，后者在每次尝试前等待 `delayMs * backoffMultiplier^attempt`，每次都新建一个 client，成功时归零计数，并在最后一次尝试失败后析构该实例。当 `reconnect.enabled` 未设置或为 false 时，`close` 改为析构该实例。`error` 不会被重试；初次连接失败会拒绝 `ready`，从而使激活失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

一个服务实例持有一个 ssh2 `Client` 与一个 SFTP wrapper。构造函数把实例注册到 `sshNative` 名下，通过 `ctx.effect(() => () => this.dispose())` 安排 `dispose()`，并在不等待的前提下启动连接，因此构造本身不会因为远端不可达而失败；就绪由 `[Service.init]` 施加，它等待 `ready`，不可达的主机正是这样抵达激活阶段的。该类只声明 `static Config`，不声明 `static inject`，因此激活无需等待其他服务。

配置经过两个校验器。发布为 `static Config` 的 `SshNativeConfigSchema` 是一个 schemastery object，承载扁平的连接字段，也就是加载器所配置的部分。zod schema 解析构造函数接受的完整形状，并加上 `reconnect`、`compression` 与 `proxy` 及其默认值与边界；当 `host` 或 `username` 为空时它抛出。

`connect()` 用 `host`、`port`、`username`、取自 `connectTimeout` 的 `readyTimeout`、`keepaliveInterval`、`keepaliveCountMax` 与 `strictHostKeyChecking` 组装一份 ssh2 配置，然后打开 SFTP 子系统。`privateKey` 与 `password` 是互斥分支，而设置了 `identityFile` 时会用 `readFileSync` 读取并覆盖同一对象中的 `privateKey`。`close` 监听器只在两者都成功之后才附加，因此连接与 SFTP 设置期间的失败是一次拒绝，而不是一次重试决定。

`dispose()` 把实例标记为已析构，中止其 lifetime `AbortController`，终止每个存活的 exec 句柄，关闭 SFTP，并结束 client。它是幂等的，并由析构路径与连接丢失路径共同调用。

`createSession()` 不保持任何长期 shell：每次调用都把会话选项合并进一次全新的 `exec()`，而 ssh2 流按命令创建，因此 `cd` 或导出的变量不会延续到下一条命令。

`metrics` 只报告 `connectionTime`；ssh2 不暴露请求、字节或延迟计数器，因此其余字段保持为 0。`healthStatus` 只返回 `'healthy'` 或 `'disconnected'`，从不返回 `'degraded'`。

| 文件 | 内容 |
|---|---|
| [src/index.ts](src/index.ts) | `SshNativeConnection`、两份配置 schema、连接与 SFTP 设置、exec、重连、析构 |
| [src/types.ts](src/types.ts) | `NativeSftpStat`、`NativeSftpEntry`、`NativeExecHandle`、`NativeExecOptions`、`NativeSessionHandle`、`NativeSystemInfo`、`ConnectionMetrics` 及其余公开类型 |
| [tests/index.spec.ts](tests/index.spec.ts) | 基于桩化的 `exec`、SFTP 方法与校验路径的单元测试 |
| [tests/integration.spec.ts](tests/integration.spec.ts) | 在未设置 `DEEPSEEK_SSH_TEST_HOST` 时自行跳过的真实主机测试 |

生成式的 [ctx.sshNative API](../../../docs/subsystems/ssh.zh.md#ctxsshnative--sshnativeconnection) 拥有完整的方法列表。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 连接归属、执行坐标与生成式的 `ctx.sshNative` API。
- [主机注册表](../host-registry/README.zh.md) — 在其旁挂载执行提供方的每主机 realm。
- [主机凭证](../host-credentials/README.zh.md) — 连接所认证所用的 OpenSSH 配置、身份与 known_hosts。
- [fs-sftp](../fs-sftp/README.zh.md) — 基于此处 SFTP 操作的文件系统提供方。
- [subprocess-ssh-exec](../subprocess-ssh-exec/README.zh.md) — 基于 `exec` 的子进程提供方。

-----

<a id="model-experience"></a>
## 模型体验

### 原生 SSH 连接

#### 模型所见

无。该服务不注册任何工具、提示段或会话事件；`ctx.sshNative` 是一个主机侧能力，由 [fs-sftp](../fs-sftp/README.zh.md) 与 [subprocess-ssh-exec](../subprocess-ssh-exec/README.zh.md) 消费，每个面向模型的值与结果都由这两个提供方拥有。

#### Token 影响

无。连接、重连、SFTP 调用与 exec 运行都不添加任何请求前缀文本、工具 schema 或结果内容。

#### KV Cache 影响

无。该服务不贡献请求前缀内容，因此不会使已缓存的前缀失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- `knownHostsFile`、`compression` 与 `proxy` 被解析却从不进入 ssh2 连接配置，因此设置了它们的调用方既得不到自定义校验路径，也得不到压缩或跳板主机；真正生效的主机密钥控制只有 `strictHostKeyChecking`。
- 除非 `reconnect.enabled` 为 `true`，连接丢失会析构该实例，因此对该 realm 而言 `ctx.sshNative` 会以 `ssh-native: connection is disposed` 永久拒绝；[主机注册表](../host-registry/README.zh.md) 重新打开主机，而不是恢复该 realm。
- 重连只重试 `close` 事件；就绪前的 `error`、被拒绝的连接或认证失败会拒绝 `ready` 并使激活失败，且不重试。
- `healthStatus` 只返回 `'healthy'` 或 `'disconnected'`，因此已声明的 `'degraded'` 值不可达。
- `metrics` 只报告 `connectionTime`；由于 ssh2 不暴露计数器，`requestsSent`、`requestsReceived`、`bytesSent`、`bytesReceived` 与 `avgLatency` 保持为 `0`。
- `createSession()` 不共享 shell 状态：每条命令各开一条通道，因此 `cd` 或导出的变量对下一条命令不可见。
- 超出 `maxOutputBytes` 的 exec 输出被静默丢弃且没有截断标记，`resize()` 与 `signal()` 仅在 ssh2 流暴露 `setWindow` 与 `sendSignal` 时才生效，`terminate()` 也是结束 exec 流而不是向进程发送信号。
- `getSystemInfo()` 读取 `/proc`，`killProcess()` 使用 `kill`，因此两者都假定远端主机是类 Linux 环境。
- `sftpReadStream()` 在范围读取失败时返回 `null` 而不是暴露错误，`sftpCopy()` 通过本地内存复制而不是 SFTP copy 请求。
- `NativeSshConnectionId`、`NativeSftpRealpath` 与 `NativeFileMode` 从 `src/types.ts` 导出，但没有任何服务方法返回它们。
- CI 中不运行真实的远端端到端测试；未设置 `DEEPSEEK_SSH_TEST_HOST`、`DEEPSEEK_SSH_TEST_USER` 以及密钥或密码时，`tests/integration.spec.ts` 自行跳过。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口。连接状态由一个服务实例拥有，且只能通过该实例自己的操作被观察，因此不存在可能与之偏离的独立观察；`tsconfig.json` 只引用 `vendor/cordis` 与 `vendor/schemastery`，没有 `runtime-diagnostics/invariants` 引用，`files` 中也没有 `lib/invariant.js`。

</details>

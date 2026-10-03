---
description: "面向通过一条 OpenSSH 连接的 SFTP 子系统访问的主机的远端文件系统提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-sftp

[English](README.md) | 中文

## 概述

`dsh-fs-sftp` 用于需要通过一条 OpenSSH 连接读取、列举、写入与编辑远端主机文件的情形：该提供方通过 SFTP 子系统跑完整个 `ctx.fs` 契约，因此远端不需要 Node.js 运行时，也不需要 helper 守护进程。resolve、stat、列举、文本与字节读取、流式读取、目录创建、整文件写入与字面量编辑都保留远程 realpath 作为 target key，并返回带类型的 `FsError` 错误码。版本守卫会被传入但随即丢弃，因此受保护的编辑就是普通的读改写，并发写入不会被检测出来。

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

用 `ctx.plugin(SftpFileSystem)` 把该服务类挂载进一个组合中，或让[主机注册表](../host-registry/README.zh.md)替你挂载：它的默认组合会为每个已打开的主机领域调用 `realm.plugin(SftpFileSystem)`，该提供方由此在 `sshNative` 与 `subprocess` 旁边以 `fs` 服务名注册。

本包没有声明任何插件 `Config`，因此没有字段可设，挂载时也不携带任何配置。所有可调项都位于被注入的 `sshNative` 服务中——远端主机、端口、凭证、主机密钥策略与读取上限——因为本提供方不拥有自己的连接坐标。

| 注入服务 | 本提供方从中读取什么 |
|---|---|
| `sshNative` | 每一次 I/O 调用：`sftpRealpath`、`sftpStat`、`sftpLstat`、`sftpRead`、`sftpReadRange`、`sftpWrite`、`sftpMkdir`、`sftpReaddir` |
| `sandboxPolicy` | 仅 `defaultMode`，被上报为 `sandboxMode` |

### 路径标识与包含性

`resolve(path, { cwd })` 在传入 `cwd` 时先与之拼接，再调用 `sftpRealpath`，并把解析出的路径同时作为 `targetKey` 与 `displayPath` 返回。`processPath` 就是该 key 转成字符串，`fileUrl` 把它包成 `file:` URI，`contains` 用词法上的 `posix.relative` 判断比较两个 key，不做任何 I/O。因此远程路径是直接暴露给消费方的，而不是隐藏在不可解析的 id 之后；`processPathFromHostPath` 保持未重写，所以本地主机的文件无法映射进本提供方。

### 写入与守卫

`mkdir` 会创建所有缺失的父目录，路径已存在时报告 `created: false` 而不是失败。`writeText` 先 stat 该路径以决定 `create` 还是 `update`，在更新时读取原内容填入 outcome 的 `before` 一半，写入新内容后报告一个由写入时刻与新字符数推导出的版本。`writeText` 与 `editText` 都接受守卫却把它丢弃，因此过期的文件永远不会被拒绝，本提供方也不会产生 `FS_STALE_VERSION`。

`editText` 没有原生 compare-and-swap 可调用：它读取文件，在内存中应用字面量替换，再把结果写回。当 `replaceAll` 为 false 且 `oldString` 完全不存在时，它以 `FS_EDIT_NOT_FOUND` 失败，这是唯一一种未经变换就到达调用方的编辑失败。这里没有锁、没有预留、写入之后也没有二次读取，因此发生在读取与写入之间的变更是不可见的。

### 沙箱上报

`sandboxMode` 原样返回 `sandboxPolicy.defaultMode`，因此它永远不会上报 `undefined`。`mkdir`、`writeText` 与 `editText` 收到的逐次调用 `SandboxExecutionPolicy` 会被接受随即丢弃，本提供方也不执行任何 harness 侧的约束：真正的执行取决于远程账户自身的权限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

每个方法都是在同一个 `try` 内通过 `sshNative` 完成一次 SFTP 往返，失败统一交由 `toFsError` 处理。该映射函数只依据消息文本重新推导错误码：已中止的信号判为 `FS_ABORTED`，`ENOENT` 或 `No such file` 判为 `FS_NOT_FOUND`，`EEXIST` 判为 `FS_IO_ERROR`，`EPERM` 或 `EACCES` 判为 `FS_PERMISSION_DENIED`，其余一律判为 `FS_IO_ERROR`。它会丢弃传入 `FsError` 原有的码，因此 `streamText` 在自身 `try` 内构造的类型化错误永远到不了调用方——目标不存在与非普通文件两种情况都会变成 `FS_IO_ERROR`。

观察到的状态从 `stat`、`lstat` 与目录条目携带 `FsVersion(mtime:size)`，而一次写入或编辑携带 `FsVersion(Date.now():charCount)`。两个尺度并不一致，因此消费方从写入拿到的版本无法与之后的一次 `stat` 相互匹配。

读取分为一次性与流式两条路径。`readText` 是单次 `sftpRead` 解码，受 ssh-native 自身的 `maxSftpReadBytes` 限制，该上限触发时表现为 `FS_IO_ERROR` 而非 `FS_TOO_LARGE`。`streamText` 先 stat 目标，再从 `sftpReadRange` 逐个取得 64 KiB 窗口，直到某个窗口返回空为止。`readBytes` 与 `readByteRange` 返回原始字节，不做解码，也不把结果与文件的真实大小作比较。

`listDir` 为每个条目索取名称、类型、已解析的子目标，以及仅对文件与目录索取的版本和大小。它只凭 `isDirectory()` 或 `isFile()` 分类，所以符号链接条目会变成 `other` 并同时丢失版本与大小；只有按路径形态的 `lstat` 能报告 `symlink`。

### 源码对照

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `SftpFileSystem`、`toFsError` 映射函数，以及全部被重写的 seam 成员 |
| [`tests/index.spec.ts`](tests/index.spec.ts) | 仅覆盖构造函数、`processPath` 与 `contains` |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [fs](../../fs/fs/README.zh.md) — 本提供方所扩展的 seam，以及它无法满足的守卫语义。
- [主机注册表](../host-registry/README.zh.md) — 为每个已注册主机挂载一个领域，其中挂载本提供方。
- [ssh-native](../ssh-native/README.zh.md) — 支撑每次调用的 SSH 连接与 SFTP 操作。
- [subprocess-ssh-exec](../subprocess-ssh-exec/README.zh.md) — 同一领域中的姊妹远程子进程提供方。
- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 共享连接所有权与提供方组合。
- [文件系统子系统](../../../docs/subsystems/filesystem.zh.md) — 穷尽的提供方契约与错误分类法。

-----

<a id="model-experience"></a>
## 模型体验

### 文件系统消费方

#### 模型看到什么

本提供方不注册自己的工具、提示段或结果。`ctx.fs` 的消费方负责渲染每个面向模型的值，各自抵达解析出 `fs` 的那台主机领域，因此本包不向任何请求贡献自己的文本。

#### Token 影响

挂载本提供方不增加面向模型的输入，也不改变请求前缀文本；本提供方不拥有自己的 token 预算。

#### KV Cache 影响

本提供方不贡献请求前缀内容，请求前缀保持由消费方组合出的样子，远程文件内容也仅通过消费方已经渲染的内容进入缓存。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **受保护的编辑既不原子也没有锁** — `editText` 读取、在内存中应用替换、再写入；读取与写入之间的并发写入不会被检测，也没有文件系统锁来对它串行化。`writeText` 与 `editText` 的 `expected` 版本守卫被丢弃，因此永远不会产生 `FS_STALE_VERSION` 与 `FS_NOT_OBSERVED`。
- **字节读取受窗口而非文件约束** — `readBytes(target, signal, maxBytes)` 读取 `maxBytes` 字节并原样返回所得，因此更大的文件会返回被截断的前缀，而不是 seam 契约所承诺的 `FS_TOO_LARGE`。`readText` 受 ssh-native 的 `maxSftpReadBytes` 约束，该拒绝同样表现为 `FS_IO_ERROR` 而非 `FS_TOO_LARGE`。
- **不支持监视** — `watch` 未被重写，消费方继承基类的拒绝：`FS_IO_ERROR` 与 "Filesystem watching is not supported by this provider."；这条连接上的 SFTP 也不提供任何变更通知可供利用。
- **没有模式、所有权、重命名、删除或符号链接变更** — seam 未暴露此类原语，本提供方也一个都没有重写，尽管 `sshNative` 提供了 `sftpChmod`、`sftpChown`、`sftpRename`、`sftpUnlink`、`sftpSymlink` 与 `sftpReadlink`；权限位、所有权与符号链接都无法通过 `ctx.fs` 触达。因此 `FS_NOT_DIRECTORY` 也永远不会被抛出，包括 `mkdir` 指向已存在文件的情形。
- **符号链接在列举中退化** — `listDir` 只凭 `isDirectory()` 与 `isFile()` 分类，所以符号链接条目会变成 `other` 并同时丢失版本与大小；只有 `lstat` 报告 `symlink`，而 `resolve`、`stat` 与每次读取都会跟随符号链接。
- **两个互不相干的版本尺度** — `stat`、`lstat` 与 `listDir` 推导 `FsVersion(mtime:size)`，而 `writeText` 与 `editText` 推导 `FsVersion(Date.now():charCount)`，因此消费方无法把一次写入返回的版本与之后的一次观察对应起来。
- **错误码按消息文本重新推导** — `toFsError` 丢弃传入 `FsError` 原有的码，因此 `streamText` 在自身 `try` 内构造的 `FS_NOT_FOUND` 与 `FS_NOT_REGULAR_FILE` 到达调用方时都变成 `FS_IO_ERROR`；只有 `editText` 会原样重抛自己的 `FS_EDIT_NOT_FOUND`。本提供方也从不产生 `FS_NOT_TEXT`、`FS_AMBIGUOUS_EDIT`、`FS_SANDBOX_DENIED`、`FS_TOO_LARGE` 与 `FS_NOT_DIRECTORY`，调用方无法依据其中任何一个分支。
- **上报的默认沙箱模式不被执行** — `sandboxMode` 上报 `sandboxPolicy.defaultMode`，而工具层据此宣传升级能力；但传给 `mkdir`、`writeText` 与 `editText` 的逐次调用 `SandboxExecutionPolicy` 被丢弃，也没有任何 harness 侧约束生效，唯一真正的执行是远程账户自身的权限。
- **没有任何测试驱动 SFTP 操作** — 测试只覆盖构造函数、`processPath` 与 `contains`，全是纯逻辑；没有任何测试触及远程往返，因此本页关于错误映射的每条说法都是从源码读出的，而非实测观察。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口：不存在 `invariant/` 目录，`tsconfig.json` 也没有引用任何 `runtime-diagnostics/invariants` 项目。这里没有任何需要对齐的状态——每次操作都是单次 SFTP 往返，其结果直接返回给调用方，因此没有任何被拥有的关系存在两个可能相互偏离的独立观察。

模块头部仍然把受保护的编辑描述为 "compare-and-swap via read-then-write with a lockfile"。实现中既没有锁也没有 compare-and-swap，只有 `editText` 里的读改写；在真正引入锁之前，这句话应当视为过时的期望。

</details>

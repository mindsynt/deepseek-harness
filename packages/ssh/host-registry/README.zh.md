---
description: "面向在同一 Harness 进程内运行多台 SSH 主机的部署，说明每主机隔离的执行领域。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh-host-registry

[English](README.md) | 中文

## 概述

`dsh-ssh-host-registry` 提供 `ctx.remoteHosts`，为每个已注册的 SSH 主机拥有一个隔离的 Cordis 领域。每个领域用该主机的连接坐标挂载 [`dsh-ssh-native`](../../../docs/subsystems/ssh.zh.md)，并挂载配套的 SFTP 文件系统与 SSH-exec 子进程提供方，使 `ctx.fs` 与 `ctx.subprocess` 按主机解析，而不是按进程解析一次。打开主机会返回句柄，携带该主机的规格、执行领域与关闭入口；注册表按 id 寻址已打开的主机，并在关闭或自身析构时释放每个领域。

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

用 `ctx.plugin(RemoteHostRegistryService)` 挂载注册表服务，或让加载器直接挂载本包：本包是函数插件且没有 default export，其 `apply` 以默认组合安装该服务。当部署或测试需要向领域挂载 SSH 原生提供方之外的服务时，改为传入 `RemoteHostComposition`。

`ctx.remoteHosts.open(spec)` 打开一个领域，返回带规格、已解析执行领域和 `closed` promise 的句柄；`get(id)` 与 `list()` 寻址已打开的主机，`close(id)` 释放一个领域，对未知 id 不做任何事。重复 id 会显式报错；`label` 原样交给调用方，不做默认值。

| 字段 | 含义 |
|---|---|
| `id` | 注册表身份。 |
| `label` | 面向调用方的标签。 |
| `host` | 远端主机地址（主机名或 IP）。 |
| `port` | 远端 SSH 端口（默认 22）。 |
| `user` | 用户名。 |
| `privateKey` | 私钥内容（PEM 格式）。 |
| `password` | 密码（与 privateKey 互斥）。 |
| `identityFile` | 本机身份文件路径。 |
| `knownHostsFile` | known_hosts 文件路径。 |

profile 不通过插件 `Config` 声明主机：native SSH 组合不安装任何 helper 制品，因此 `config.hosts` 条目会让激活失败，报错会点名该条目 id，并指出真正注册主机的控制器。由于本插件注入 `sshHostCredentials` 与 `storageDomain`，激活会等待两者，而不会与它们抢跑。

在声明的各主机之后，`apply` 会恢复每一条 Config 未声明的持久化记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

一个主机领域就是一个 Cordis fiber。`open()` 启动一个持有者 fiber，在其下隔离三个执行服务名，并把该主机的提供方挂载到那里；析构持有者 fiber 即卸载这些提供方，这正是 `close()` 与注册表自身析构所做的事。Cordis 仅按隔离标签定位服务实现，因此每台主机的三个服务名各用一个标签：共用一个标签会在第二个提供方处冲突，并解析到错误的实例。

默认组合挂载三个提供方：
- [`SshNativeConnection`](../../../docs/subsystems/ssh.zh.md) — 基于 ssh2 的 SSH 连接服务
- [`SftpFileSystem`](../../../docs/subsystems/ssh.zh.md) — 基于 SFTP 的文件系统提供方
- [`SshExecSubprocessRuntime`](../../../docs/subsystems/ssh.zh.md) — 基于 SSH exec 的子进程提供方

主机记录存放在 `ctx.storageDomain` 之上的 `ssh_hosts` 域中。注册表在激活期间打开该域——其声明的 `storageDomain` 注入会推迟激活直到该服务就绪——从域经过校验的内存状态同步读取记录，并在自身析构时于所有领域之后关闭该域。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 连接与提供方组合。
- [SSH 连接](../../../docs/subsystems/ssh.zh.md) — 基于 ssh2 的原生 SSH 连接。
- [SSH 文件系统](../../../docs/subsystems/ssh.zh.md) — 基于 SFTP 的远端文件语义。
- [SSH 子进程](../../../docs/subsystems/ssh.zh.md) — 基于 SSH exec 的子进程执行。

-----

<a id="model-experience"></a>
## 模型体验

### 远端执行服务

#### 模型看到什么

注册表不注册自己的工具、提示段或结果。`ctx.fs` 与 `ctx.subprocess` 的消费方负责渲染每个面向模型的值，各自抵达解析出对应服务的那台主机的领域。

#### Token 影响

打开或关闭主机不增加面向模型的输入，也不改变请求前缀文本；注册表不拥有自己的 token 预算。

#### KV Cache 影响

注册表不贡献请求前缀内容，请求前缀保持由消费方组合出的样子。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 主机只能通过 Host 的设置界面或 `hosts` Remote namespace 注册：注册表本身不暴露列出、新增、编辑或删除操作，因此手工改动记录存储的操作者可以留下一条启动恢复无法打开的记录。
- 用 `open()` 打开的主机不写记录，因此不出现在 `records()` 中，也不参与启动恢复。
- 主机领域只提供 `sshNative`、`fs`、`subprocess`。它不提供 `sandbox`，因此凡是主机领域改从父作用域解析的东西——进程约束、搜索、终端、spill——都尚未按主机隔离。
- 安装尚无真实远端端到端验证。测试以桩化服务驱动整个组合，没有任何测试连接真实主机。
- 注册表从不重连。SSH 连接丢失会使该领域的提供方失效，与连接的不重连约定一致；调用方需重新打开主机。
- SSH PTY 终端会话会申请 PTY，并把输入、resize 与终止转发到通道。远端前台进程组不可见，因此句柄发布 `pid: 0`，`inspectForeground()` 返回 `undefined`，`signalForeground()` 抛出异常。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口。领域存在与否即 fiber 所有权，领域释放由 `packages/api/hosts-controller/tests/hosts-controller.spec.ts` 的增删用例直接观察，因此本包没有可独立观察的状态关系需要校验。

</details>

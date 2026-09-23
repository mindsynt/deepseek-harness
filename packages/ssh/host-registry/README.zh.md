---
description: "面向在同一 Harness 进程内运行多台 SSH 主机的部署，说明每主机隔离的执行领域。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh-host-registry

[English](README.md) | 中文

## 概述

`dsh-ssh-host-registry` 提供 `ctx.remoteHosts`，为每个已注册的 SSH 主机拥有一个隔离的 Cordis 领域。每个领域用该主机的连接与辅助程序坐标挂载 [`dsh-ssh`](../ssh/README.zh.md)，并挂载配套的文件系统、子进程和沙箱提供方，使 `ctx.ssh`、`ctx.fs`、`ctx.subprocess` 和 `ctx.sandbox` 按主机解析，而不是按进程解析一次。打开主机会返回句柄，携带该主机的规格、执行领域与关闭入口；注册表按 id 寻址已打开的主机，并在关闭或自身析构时释放每个领域。通过登录材料安装的主机还会在 `ctx.storageDomain` 中持久化一条记录，使其坐标与已安装辅助程序摘要跨重启存活。

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

用 `ctx.plugin(RemoteHostRegistryService)` 挂载注册表服务，或让加载器直接挂载本包：本包是函数插件且没有 default export，其 `apply` 以默认组合安装该服务，然后安装 `Config` 声明的各台主机。当部署或测试需要向领域挂载这四件套之外的 SSH 提供方时，改为传入 `RemoteHostComposition`。

`ctx.remoteHosts.open(spec)` 打开一个领域，返回带规格、已解析执行领域和 `closed` promise 的句柄；`get(id)` 与 `list()` 寻址已打开的主机，`close(id)` 释放一个领域，对未知 id 不做任何事。重复 id 会显式报错；`label` 原样交给调用方，不做默认值：本包不推导凭证，也不推导辅助程序坐标。

`ctx.remoteHosts.provision(request)` 打通从产物到领域的闭环：它先用 `ctx.sshHelperInstaller.install({ host, root, workspace, artifact })` 安装产物，再用返回的 `node`、`helper`、`helperHash` 和 `workspace`，连同 `request.id` 与 `request.label` 打开句柄。因此 `provision()` 要求在同一上下文中挂载 [`dsh-helper-installer`](../helper-installer/README.zh.md)，或由程序化调用方向构造函数注入安装器；两者都没有时，`provision()` 会报错并点名该包。安装失败不会打开领域，并原样抛出安装器的错误；重复 id 在任何安装开始之前就失败。

`ctx.remoteHosts.provisionFromLogin(request)` 打通从录入的登录材料到领域的闭环：它通过 `ctx.sshHostCredentials` 物化 `request.login`，为该身份信任端点公布的主机密钥，以生成的别名并把该身份的配置作为 `ssh -F` 传入来安装产物，再用取自该身份的 `host` 与 `sshConfigFile` 打开句柄。句柄在其整个生命周期内拥有该身份：`close()` 先释放领域，再删除生成的目录，且只执行一次。从主机密钥信任到领域组合之间任一步失败，都会在重新抛出错误之前删除该身份，且不注册任何句柄。注册表从不调用 `store`，因此持久化登录材料仍是调用方的决定；它只在启动恢复期间通过 `load` 读回这些材料。请求携带 `manifest` 时，注册表会在领域打开后写入一条主机记录；记录写入失败会先关闭该领域及其身份，再重新抛出。因此登录式安装还要求在同一上下文中挂载 [`dsh-host-credentials`](../host-credentials/README.zh.md)，或向构造函数注入该服务；两者都没有时，`provisionFromLogin()` 会报错并点名该包。

`ctx.remoteHosts.records()` 按 id 顺序返回每条持久化主机记录，`save(record)` 持久写入一条记录并替换同 id 的既有记录，`forget(id)` 关闭一台主机、删除其记录，并调用 `ctx.sshHostCredentials.forget(id)` 丢弃其存储的登录材料。记录只携带面向调用方的坐标；登录材料仍留在凭证存储中。

| 字段 | 含义 |
|---|---|
| `id` | 注册表身份。 |
| `label` | 面向调用方的标签。 |
| `host` | 物化身份所寻址的 OpenSSH 别名。 |
| `root` | 接收按摘要命名安装目录的绝对远端目录。 |
| `workspace` | 绝对远端默认工作区。 |
| `manifest` | 该主机安装所用产物清单的绝对本机路径；不允许为空。 |
| `helperHash` | 该主机最后安装的辅助程序入口的小写 SHA-256。 |

profile 通过插件 `Config` 声明主机。`hosts` 列出激活时安装的条目——每个条目都需要非空的 `id`、OpenSSH `host` 别名、绝对的本机 `root` 与 `workspace` 远端路径，以及一个绝对本机 `manifest`（自带，或使用插件级的那一个）——省略 `hosts` 则不打开任何主机。`apply` 先校验整份配置，再挂载服务，然后逐个条目读取 manifest、从本机磁盘装载它指向的归档，并调用 `provision()`。字段格式错误、manifest 缺失或格式非法、安装失败都会抛出并令激活失败，错误信息带上主机 id 与文件路径；不会静默跳过任何条目。manifest 是 `pnpm run build:ssh-helper-artifact` 产出的 `manifest.json`。由于本插件注入 `sshHelperInstaller`、`sshHostCredentials` 与 `storageDomain`，激活会等待三者，而不会与它们抢跑。

在声明的各主机之后，`apply` 会恢复每一条 Config 未声明的持久化记录。它按 id 顺序逐条通过 `ctx.sshHostCredentials.load(id)` 读取存储的登录材料、读取记录所指的产物 manifest，再用 `provisionFromLogin()` 安装该主机，并由这次全新安装重写记录。Config 已声明的 id 永不参与恢复，因此其主机只安装一次。缺少存储登录材料的记录会令激活失败，错误信息带上其 id 以及"存储登录材料或删除该记录"的提示；其他任何失败都会中止激活，而不会跳过该记录。

当前本包负责领域生命周期、寻址、辅助程序安装、所拥有身份的生命周期，以及登录式安装所持久化的主机记录。工作区与 Session 记录尚不携带主机身份，也还没有管理主机的 GUI 界面。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

一个主机领域就是一个 Cordis fiber。`open()` 启动一个持有者 fiber，在其下隔离四个执行服务名，并把该主机的提供方挂载到那里；析构持有者 fiber 即卸载这些提供方，这正是 `close()` 与注册表自身析构所做的事。Cordis 仅按隔离标签定位服务实现，因此每台主机的四个服务名各用一个标签：共用一个标签会在第二个提供方处冲突，并解析到错误的实例。注册表不隔离的服务名——目前是 `sandboxPolicy`——仍从父作用域解析。

主机记录存放在 `ctx.storageDomain` 之上的 `ssh_hosts` 域中。注册表在激活期间打开该域——其声明的 `storageDomain` 注入会推迟激活直到该服务就绪——从域经过校验的内存状态同步读取记录，并在自身析构时于所有领域之后关闭该域。记录 schema 会拒绝 `manifest` 不是非空绝对路径的已存记录，域会以 `invalid-record` 报错并点名表与键，因此并非由本注册表写入的介质会令激活失败，而不是丢弃一台主机。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 连接、辅助程序与提供方组合。
- [SSH 连接](../ssh/README.zh.md) — 部署、就绪与断连行为。
- [SSH 文件系统](../fs-ssh/README.zh.md) — 每个领域安装的远端文件语义。

-----

<a id="model-experience"></a>
## 模型体验

### 远端执行服务

#### 模型看到什么

注册表不注册自己的工具、提示段或结果。`ctx.fs`、`ctx.subprocess` 与 `ctx.sandbox` 的消费方负责渲染每个面向模型的值，各自抵达解析出对应服务的那台主机的领域。

#### Token 影响

打开或关闭主机不增加面向模型的输入，也不改变请求前缀文本；注册表不拥有自己的 token 预算。

#### KV Cache 影响

注册表不贡献请求前缀内容，请求前缀保持由消费方组合出的样子。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 尚未实现 GUI 主机管理：没有任何界面列出、新增、编辑或删除主机，`provisionFromLogin()` 也会在没有指纹确认步骤的情况下信任端点公布的主机密钥。工作区与 Session 上的主机身份属于后续阶段。
- 记录里的 `manifest` 是写入它的那台机器上的绝对路径。把域迁移到另一台机器，或删除该 manifest，都会让该记录无法恢复：启动恢复会持续失败，直到用 `pnpm run build:ssh-helper-artifact` 重建 manifest，或用 `forget(id)` 删除该记录。
- 只有登录式安装会持久化记录。用 `open()` 或 `provision()` 打开的主机不写记录，因此既不出现在 `records()` 中，也不参与启动恢复。
- 安装尚无真实远端端到端验证。测试通过注入的安装器驱动整个闭环，没有测试在真实主机上安装产物。
- `sandboxPolicy` 尚未按主机隔离。每个领域都从父作用域解析它，因此两台主机目前无法使用不同的限制策略。
- 注册表从不重连。SSH 连接丢失会使该领域的提供方失效，与连接的不重连约定一致；调用方需重新打开主机。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口。领域存在与否即 fiber 所有权，领域释放由 `packages/ssh/host-registry/tests/registry.spec.ts` 直接观察，因此本包没有可独立观察的状态关系需要校验。

</details>

---
description: "列出、新增、移除并检查 GUI 管理的 SSH 主机连接的 Host Remote owner，并向浏览器推送主机记录变化。"
kind: "package-reference"
---
# Hosts Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-hosts-controller` 提供生成的 `ctx.remote.hosts` namespace，使浏览器页面可以列出部署已注册的服务器、用输入的主机、端口、用户与密钥新增一台、移除一台，并检查已存登录是否仍能到达其端点。新增主机会存储该登录、从本地制品 manifest 安装助手，并把打开该主机执行世界作为一次事务处理；任一步失败都会清除全部半成品并报告发生了什么。列表操作只读，这里没有任何方法会返回已存机密。

## 目录
- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

请把本包挂载在远端主机注册表与主机凭证存储旁边：它注入这两者，因此只有在这些行挂载后本包的行才会激活，并且它自身不持有任何状态。

### Remote namespace 提供什么

| 端点 | 作用 |
|---|---|
| `hosts/list` | 按 id 顺序返回每条持久主机记录，并标明本进程当前是否为该主机持有已打开的执行世界。 |
| `hosts/add` | 存储输入的登录材料、按指定的本地制品 manifest 安装助手，并打开该主机。 |
| `hosts/delete` | 移除一台主机的执行世界、持久记录与已存登录；对已经消失的 id 重复调用会正常返回。线上方法名为 `delete`，因为 Gateway Client 在命名空间服务上保留了 `remove`。 |
| `hosts/testConnection` | 信任该端点当前发布的 host key，并返回 DSH 控制的 `known_hosts` 为它记录的各行。 |
| `hosts/follow` | 先流式发出一份完整 baseline，再按顺序发出 `upsert` 与 `remove` 增量，供可重连的主机列表使用。 |

预期拒绝会携带稳定错误码：无已存登录时为 `hosts/unknown-host`，某个记录或已打开的执行世界已占用该 id 时为 `hosts/already-exists`，新增失败时为 `hosts/add-failed`，已打开的执行世界来自配置的制品而非已存登录材料时为 `hosts/no-login-identity`。

### 新增是一次事务

`hosts/add` 会拒绝已被记录或已打开执行世界占用的 id，因此失败的新增绝不会移除既有主机。随后它存储登录、读取制品 manifest 与其归档、安装助手并打开领域。任一步失败时，它会移除已存登录、记录以及注册表已打开的任何领域，抛出的 `hosts/add-failed` 会同时说明原因与清理结果；清理本身也失败时会被如实报告，而不会被隐藏。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包是位于两个已交付服务之上的 Remote owner：`ctx.remoteHosts` 负责主机记录、每台主机一个隔离执行领域以及助手安装，而 `ctx.sshHostCredentials` 负责登录材料与由它生成的受控 OpenSSH 身份。本包只组合这两者，不新增任何 SSH 行为；`hosts/add` 是唯一会写入的方法，并且把每次写入都委托给上述两个服务。

连接检查会为没有已打开世界的主机物化一个用后即弃的身份，经它信任端点当前发布的 key，读回由此得到的 `known_hosts` 各行，然后再次移除该身份。执行世界已经打开的主机则通过该世界已经使用的身份检查，因为打开的 handle 拥有这些文件，关闭它是唯一一次移除。

follow 流会先安装自己的 `domain/changed` 监听器，再读取 baseline，因此两者之间提交的记录不会丢失。只有存储领域自身提交的变更才会产生增量；open 标志则在每次 baseline 与 upsert 时从实时注册表读取。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `HostsController` 服务：五个 Remote 操作、新增事务，以及借用身份的规则。 |
| [`src/feed.ts`](src/feed.ts) | 主机记录投影，以及可重连的 baseline 加增量流。 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的请求、结果与流词汇，以及声明的 Remote 失败码。 |
| [`tests/hosts-controller.spec.ts`](tests/hosts-controller.spec.ts) | 以真实注册表与凭证存储、加上桩安装器与桩组合，覆盖 Remote 表层。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索
- [SSH 子系统](../../../docs/subsystems/ssh.zh.md)——每台主机背后的连接、助手与提供方组合。
- [主机注册表](../../ssh/host-registry/README.zh.md)——领域生命周期、记录持久化与安装语义。
- [主机凭证](../../ssh/host-credentials/README.zh.md)——本包组合的已存登录与生成身份。
- [SSH 主机组合包](../../bundle/ssh-hosts/README.zh.md)——插入本包所在行的 profile 层。
- [能力 seams](../../../docs/capability-seams.zh.md)——`ctx.hostsController` 在其他服务中的位置。

-----

<a id="model-experience"></a>
## 模型体验

无，因为主机管理属于浏览器和 Host 的控制状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；列出、新增或移除主机不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>
- 只有持久记录变化会被流式推送；执行世界的打开或关闭要到下一次记录变化或重连时才会到达浏览器列表。
- 新增主机需要事先构建好的本地制品 manifest，而没有任何 Remote 操作会构建或上传它。
- 已存登录无法就地编辑：修改它意味着先移除主机再重新新增。
- 目前还没有客户端装配挂载本贡献，因此今天没有浏览器页面渲染该 namespace。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。注册表负责记录持久化与领域生命周期，凭证存储负责生成的身份；每次流生成都是完整投影。

---
description: "每台远端主机保存一份 SSH 登录材料，并物化由 DSH 控制的 OpenSSH 配置、身份文件与 known_hosts。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-credentials

[English](README.md) | 中文

## 概述

`dsh-host-credentials` 提供 `ctx.sshHostCredentials`。它把一台远端主机录入的登录材料——主机、端口、用户及可选的 armored 私钥——存入凭证 seam，并在状态目录（默认 `<DSH home>/ssh-hosts`）下物化由 DSH 控制的 OpenSSH 配置、私钥文件与 `known_hosts`。之后的每个会话都复用已存材料而不再询问，且每条命令寻址生成的别名，而不是部署方自己的 `~/.ssh/config`。

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

直接挂载本插件即可；`stateDir` 默认是 `<DSH home>/ssh-hosts`，显式给出时必须是非空的绝对本地目录。对每台主机调用一次 `store(id, login)` 以跨会话保存其登录材料，或直接调用 `materialize(login)` 建立一次性连接。`load(id)` 返回已存材料，未存储时返回 `undefined`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `stateDir` | `<DSH home>/ssh-hosts` | 存放每台主机生成目录的绝对本地目录；`$DSH_HOME` 可覆盖 harness home，否则为 `~/.dsh` |
| `scanTimeoutMs` | `10000` | 单次 `ssh-keyscan` 调用的截止时限，范围为 1 至 2,147,483,647 毫秒 |

`materialize(login)` 返回连接所寻址的身份：`alias`、绝对的 `configPath`、生成的 `directory`、`knownHostsPath`，以及删除整个目录的 `dispose()`。别名是确定性的，因此同一登录材料总是得到同一目录；再次物化会替换该目录，并丢弃其中已写入的文件。

`pinHostKey(identity, line)` 追加人工确认过的主机密钥行，`forget(id)` 同时删除已存记录与为该 id 物化的文件。

`trustFirstUse(identity, endpoint)` 完成首次使用信任。它通过 `ssh-keyscan` 扫描真实主机与端口，遇到畸形扫描输出即显式失败，并记录该身份 `known_hosts` 尚未持有的每个已发布密钥；对同一端点重复调用不会新增任何内容，也不会改动既有行。扫描失败、超过 `scanTimeoutMs` 或未发布任何密钥时，它拒绝信任而不是继续连接。

消费该身份的连接以 `StrictHostKeyChecking=yes` 运行，因此连接过程中不会接受任何密钥：`trustFirstUse` 是首个密钥获得信任的唯一位置。

生成的配置设置 `IdentitiesOnly yes`、`BatchMode yes`、`ForwardAgent no` 与 `ClearAllForwardings yes`。有私钥时它把 `IdentityFile` 指向物化出的文件；没有私钥时，由环境中的 agent 与默认密钥完成认证。主机密钥对照 DSH 自有的 `known_hosts` 校验，并使用 `GlobalKnownHostsFile /dev/null`；文件自身的 `StrictHostKeyChecking accept-new` 会被消费连接的 `-o StrictHostKeyChecking=yes` 覆盖，因此连接本身不会记录密钥，不匹配即连接失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

已存材料是 `credentialKey('ssh-host-credentials', id)` 处的一条 `grant` 凭证记录，其 payload 为 `{ version: 1, login: { host, port, user, privateKey? } }`；该 payload 格式由本包负责，且本包绝不把密钥文本写入日志或诊断信息。别名是 `dsh-` 加上 `sha256(host + "\0" + port + "\0" + user)` 的前 16 位小写十六进制数字。

每次物化都会替换 `<stateDir>/<alias>`，创建 0700 目录，并写入 `config`、可选的 `identity` 与空的 `known_hosts`，三者均为 0600，且写入后显式 chmod。校验会在任何文件或记录变更之前拒绝畸形的主机、端口、用户、id 或私钥。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 共享执行坐标及传输归属。
- [主机注册表](../host-registry/README.zh.md) — 连接所运行的每主机执行 realm。
- [SSH 连接](../ssh/README.zh.md) — 返回的别名与配置如何到达主机。

-----

<a id="model-experience"></a>
## 模型体验

### 已存储的 SSH 登录材料

#### 模型所见

无。`ctx.sshHostCredentials` 由主机管理代码在所有模型请求之外调用；它不注册任何工具、提示词章节或会话事件，登录材料与生成的文件都不会进入模型上下文。

#### Token 影响

无。本包不添加任何请求前缀文本、工具 schema 或结果内容，其存储的私钥也不会被渲染进请求。

#### KV Cache 影响

无。本包不贡献请求前缀内容，因此不会使已缓存的前缀失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 尚未实现 GUI 主机管理，也未实现已扫描主机密钥的 GUI 展示与确认交互；扫描结果已落盘，通过其他方式确认密钥的调用方把该行交给 `pinHostKey`。
- `GlobalKnownHostsFile /dev/null` 意味着部署方自己的 `known_hosts` 文件完全不参与校验。
- 尚未实现口令认证；只有已存储的私钥或环境中的 agent 与默认密钥可以完成认证。
- 没有真实的远端端到端测试；本包由本地文件系统与凭证记录测试覆盖。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口。它只拥有一种可观察关系——已存记录与由它物化出的文件——其行为测试同时覆盖两者；不存在可能与之偏离的独立观察。

</details>

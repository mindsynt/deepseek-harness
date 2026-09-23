---
description: "在任何辅助程序 RPC 可用之前，通过本机 OpenSSH 客户端安装远端 SSH 辅助程序。"
kind: "package-reference"
---

# @deepseek-ai/dsh-helper-installer

[English](README.md) | 中文

## 概述

`dsh-helper-installer` 提供 `ctx.sshHelperInstaller`。它通过本机 OpenSSH 客户端把调用方提供的辅助程序归档放到远端主机上，在那里校验已安装入口的摘要，并返回 [`dsh-ssh`](../ssh/README.zh.md) 所需的 Node 可执行文件、辅助程序路径、摘要和工作区。它在辅助程序存在之前运行，因此从不使用辅助程序 RPC。

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

将本插件与它所要配置的连接一同挂载，并对每台主机调用一次 `install()`，参数为 OpenSSH 主机别名、绝对远端根目录、默认工作区和产物。返回的坐标即连接配置字段 `node`、`helper`、`helperHash` 和 `workspace`。之后对同一摘要的调用会确认已安装的副本，不再上传任何内容。

本包有两个配置字段。`installTimeoutMs` 限制单条远端命令的时间（默认 30,000 毫秒），`sshConfigFile` 为默认 OpenSSH 客户端配置未描述的主机添加 `ssh -F <file>`。请求也可以自带 `sshConfigFile`——即登录式配置身份生成的客户端配置——它会覆盖该次安装的插件级取值。

远端 Node 可执行文件必须满足 `^22.19 || >=24`，该范围以 `SSH_HELPER_NODE_ENGINE` 导出。缺失、相对路径或过旧的 Node 会在任何上传发生之前失败，错误信息会指明主机及需要在该主机上做出的更改。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

一次安装通过 `ssh` 运行五条单行远端命令，并带有 `BatchMode=yes`、`StrictHostKeyChecking=yes`、`ForwardAgent=no` 和 `ClearAllForwardings=yes`：`command -v node`、`node --version`、以摘要命名的入口检查配合 `sha256sum`、`mkdir -p` 配合从标准输入读取归档的 `tar -xzf -`，以及最后的 `sha256sum`。每个插值的远端路径都使用 POSIX 单引号。

安装器通过 `RemoteCommandRunner.run(host, command, options)` 执行每条命令。`options.stdin` 携带上传所需的归档字节，逐次调用的 `options.sshConfigFile` 覆盖插件配置；最终生效的取值成为 `ssh` 的首个参数 `-F <file>`。

已安装入口的摘要必须等于产物摘要。摘要不匹配或上传失败都会如实报告远端安装未确认，而不是声称成功。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 执行坐标与传输归属。
- [SSH 连接](../ssh/README.zh.md) — 返回坐标所配置的连接。

-----

<a id="model-experience"></a>
## 模型体验

### 安装器调用

#### 模型所见

无。`ctx.sshHelperInstaller.install()` 由部署代码在连接或会话存在之前调用；它不注册任何工具、提示词章节或会话事件。

#### Token 影响

无。安装器不添加任何请求前缀文本、工具 schema 或结果内容。

#### KV Cache 影响

无。安装器不贡献请求前缀内容，因此不会改变已缓存的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 归档闭包按可静态分析的导入收集，因此运行时文件只能通过计算型动态导入到达的包，需要其清单所选定的整目录回退。
- 辅助程序无法打包为单个文件。rolldown 构建会把 workspace 导入解析到 `src`，其中含有装饰器语法，而且真实依赖闭包很大，因此归档按安装时的形态携带辅助程序所加载的文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口。安装器不拥有任何实时状态关系；其可观察约束是摘要比对与返回的坐标，二者均由本包的行为测试覆盖。

</details>

---
description: "原生 SSH 提供方家族：一条 OpenSSH 连接及其承载的 SFTP 文件系统与 SSH exec 子进程提供方。"
kind: "package-group"
---

# ssh/ — POSIX 远端执行提供方

[English](README.md) | 中文

## 概述

本家族将文件与进程放在同一台 POSIX SSH 主机上运行，Harness 保留在本地。基于 ssh2 的原生 OpenSSH 连接承载 SFTP 文件操作与 SSH exec 通道，因此远端主机只需一个 OpenSSH 服务端——无需辅助程序守护进程，也无需 Node 运行时。适用于消费方遵守提供方路径语义的 headless 或自定义配置组合。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 | 服务 |
|---|---|---|
| `ssh-native` | 原生 OpenSSH 连接：SFTP 文件操作、SSH exec 进程通道与 PTY 会话 | `ctx.sshNative` |
| `fs-sftp` | 基于 SFTP 子系统的远端文件系统提供方 | `ctx.fs` |
| `subprocess-ssh-exec` | 基于 SSH exec 通道的远端子进程提供方 | `ctx.subprocess` |

<a id="related-documentation"></a>
## 相关文档

- [SSH 子系统](../../docs/subsystems/ssh.zh.md) — 共享执行坐标及传输归属。
- [POSIX SSH 决策](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md) — 替代方案、影响及验证要求。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

远端能力实现保留共享异步终端及取消接口。绝不能从远端路径字符串推断本地路径访问能力。

</details>

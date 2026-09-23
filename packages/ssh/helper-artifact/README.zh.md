---
description: "构建期把 POSIX SSH 辅助程序的依赖闭包组装为一个确定性归档。"
kind: "package-reference"
---

# @deepseek-ai/dsh-helper-artifact

[English](README.md) | 中文

## 概述

`dsh-helper-artifact` 把已构建的辅助程序入口文件转换为 [`dsh-helper-installer`](../helper-installer/README.zh.md) 上传的产物。它解析入口可达的每个静态导入模块，把所属包复制进扁平的 `node_modules` 暂存树，再把该树打包为确定性 gzip tar 并配套清单。它是纯 ESM 库：没有 Cordis 服务、没有配置字段，且只使用 `node:` 内置模块。

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

先运行 `pnpm run build:lib:host`，再运行 `pnpm run build:ssh-helper-artifact`。后者默认收集 `packages/ssh/ssh/lib/helper.js`，并在 `dist/ssh-helper/dsh-ssh-helper-<digest>.tar.gz` 旁写出记录 `entry`、`digest`、`archive` 和 `files` 的 `manifest.json`。`--entry`、`--out` 与 `--staging` 分别覆盖入口文件、输出目录与暂存目录。

该脚本以暂存目录为工作目录，用普通 Node 加载暂存后的入口，并要求辅助程序以退出码 127 结束且 stderr 上出现不接受命令参数的提示。该探针证明闭包在没有仓库 `node_modules` 的情况下可加载；缺少可达模块的闭包会以退出码 1 和未解析模块错误结束，并保留暂存目录以供排查。

程序化调用方使用 `collectHelperClosure({ entryFile, stagingDir })`、`packHelperArtifact(closure)` 与 `writeHelperArtifact({ entryFile, outputDir, stagingDir? })`。`readTarEntryNames(archive)` 是测试与自检用的读取器。入口文件为相对路径或不存在、暂存目录非空、非可选导入无法解析、相对导入越出所属包、归档路径不安全，或超出大小与文件数上限时，都会失败并给出指明文件与所需修改的错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

每个被复制的文件落在 `node_modules/<包名>/<包内相对路径>`。导入说明符只按字面读取 `from "…"`、副作用 `import "…"`、动态 `import("…")` 与 `require("…")`；计算型或模板说明符一律忽略。`@deepseek-ai/*` 包，以及清单声明 `"type": "module"` 的任何包，只贡献入口可达的文件；其他包整目录复制，排除 `node_modules`、`.git`、`*.map`、`*.ts`、`test/` 和 `tests/`。由于 `createRequire().resolve` 采用 `require` 条件，`zod` 这类双模式包还会贡献其自身 `exports` 字段为 `import` 条件声明的目标。若某个说明符无法解析、但其导入方在 `optionalDependencies` 中声明了它，则跳过该说明符，koffi 缺失的各平台包正是这样处理的。

闭包涉及的每份清单都会被复制，因此包 `exports` 在远端仍可解析。归档是确定性的：条目按路径字节排序，并携带 mode `0644`、mtime 0、uid/gid 0 及空所有者名，因此相同输入产生逐字节相同的归档。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 辅助程序坐标与远端执行归属。
- [辅助程序安装器](../helper-installer/README.zh.md) — 上传本包所产归档的服务。

-----

<a id="model-experience"></a>
## 模型体验

### 构建调用

#### 模型所见

无。这是构建期库；它不注册任何工具、提示词章节或会话事件，其写出的 `dist/ssh-helper/dsh-ssh-helper-<digest>.tar.gz` 在任何会话存在之前就已被消费。

#### Token 影响

本包不添加任何请求前缀文本、工具 schema 或结果内容。

#### KV Cache 影响

本包不贡献请求前缀内容，因此不会改变已缓存的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 闭包只沿静态可分析的导入收集。运行时加载数据文件或计算模块路径的包需要整目录复制，而 `"type": "module"` 包的可达文件规则不会回退到这种复制。
- 扁平的 `node_modules` 暂存树对每个包名只保留一份副本，因此同一依赖的两个版本无法共存于一个闭包中。
- Windows 远端不包含原生 `koffi` 模块；辅助程序仅支持 POSIX 远端。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口。本包不拥有任何实时状态关系：其可观察约束是复制出的闭包、归档布局与入口摘要，三者均由本包的行为测试覆盖。

</details>
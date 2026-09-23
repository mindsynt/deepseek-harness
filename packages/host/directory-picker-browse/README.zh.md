---
description: "目录选择 seam 的应用内浏览后端：为 web GUI 宿主提供单层目录列举与子目录创建，也能服务于远程客户端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-browse

[English](README.md) | 中文

## 概述

无法触达 OS 选择器的用户仍能通过 `dsh-host-directory-picker-browse` 选择工作区目录：它列举单个目录层级并创建子目录，宿主屏幕上不渲染任何东西，且列举经由组合出的文件系统执行，因此无论从本机世界还是已打开的远程主机 realm，都能服务原生后端无法触及的远程客户端。列举只返回目录、按名称排序，跟随指向目录的符号链接，并携带宿主判定的 `hidden` 标志；创建不递归，且把名称校验为单个路径段。一行组合配置还会用应用内**选择工作区目录**对话框填满工作区流程的目录扩展位。

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

在远程浏览器、SSH 转发会话或无人值守宿主等无法使用 OS 选择器的场景中，如果必须选择工作区目录，请组合此后端。工作区流程驱动 `directoryPicker/list` 与 `directoryPicker/createDirectory`；两者都由请求所寻址主机的文件系统返回结果。

### 列举目录

`list(path?, hostId?)` 返回一个目录层级：按名称排序的子目录及其绝对路径、`hidden` 标志（POSIX 上为点前缀）、`home` 锚点，以及 `crumbs`——从根到目标的祖先链，其中每个 crumb 都是跳转目标，根以完整路径标注。`hostId` 省略或使用内置本机身份时寻址 Harness 主机，其不带路径的请求列举账户家目录；其他 `hostId` 寻址该远程主机已打开的 execution world，其不带路径的请求列举该 realm 的文件系统根，而指定了未打开的主机则失败并带上该 id。单次调用至多返回 `maxEntries` 行（配置项，默认 1,000——GitHub 网页端对目录列举采用的同一上限），被截断的层级会报告 `truncated: true`，供客户端提示层级不完整。指向目录的符号链接会被跟随；断链与循环链接被跳过。

### 创建目录

`createDirectory(path, name, hostId?)` 在被寻址的 execution world 中既有父目录下创建一个子目录，与 `list` 复用同一解析点：指定了未打开的主机时以 `directory-unreadable` 失败并带上该 id，绝不落到 Harness 主机上创建。本机世界用平台自身的 `mkdir` 非递归创建——父目录缺失是真实失败，不是要补造的层级——并把 `EEXIST` 读作 `directory-exists`；远程 realm 委托给 `FileSystem.mkdir`（会补建缺失父目录），并把 `created: false` 读作同样的 `directory-exists` 结果。两者都拒绝任何非单个非空白路径段的内容（`name` 不得包含分隔符，也不得为 `.` 或 `..`）。

### 可观察的失败

两个原语都拒绝非完全限定的路径——相对形态，以及 Windows 上 `isAbsolute` 会放行的无盘符有根形态（`\foo`、`/foo`）与不完整的 UNC 前缀——报 `directory-unreadable` 或 `directory-create-failed`，而不是把它解析到宿主进程工作目录之下。指定了未打开 execution world 的请求会报 `directory-unreadable` 并携带该 id，绝不落到 Harness 主机目录，也绝不在那里创建。创建已存在的子目录时返回 `directory-exists`。调用方的 `AbortSignal` 会停止进行中的扫描，因此断连或超时不会让扫描比调用方活得更久。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxEntries` | `1,000` | 单个列举层级的完整结果上限；隐藏行计入该上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-directory-picker-browse)是每个受支持字段及其 JSDoc 的穷尽式真源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

后端在寻址到的 execution world 中列举单个目录层级，并对返回行套用有界、按名排序的窗口：被截断的层级保留按名排序的头部、隐藏行计入上限，并报告 `truncated: true`。窗口插入为二分查找、满窗尾部单次比较即拒绝，因此超大型层级在头部之后的每个候选都只需 O(1)，而不是窗口扫描。

### 寻址的世界

由单一解析点决定请求运行在哪个文件系统上：`hostId` 省略或为内置本机身份时读取组合出的 `ctx.fs`（即本 Harness 主机），其他 id 则通过 `ctx.remoteHosts` 读取该远程主机已打开的 execution world。两个世界随后按各自语义执行同一套步骤——用 `resolve` 解析请求路径、列举时用 `listDir` 读取层级并以窗口施加返回上限、创建时用该世界的 `mkdir`——因此本机与远程只在由哪个文件系统作答上不同。远程 realm 在任何 Harness 宿主平台上都是 POSIX，因此其路径、栅栏与面包屑使用 POSIX 语义；本机世界沿用进程平台。

### 完全限定栅栏

`fullyQualified` 拒绝任何不指向一个与进程状态无关的固定文件系统位置的路径：POSIX 上要求 POSIX 绝对路径；Windows 上只接受盘符限定（`C:\…`）或完整 UNC（`\\server\share…`）形态。无盘符有根形态与不完整 UNC 前缀能通过 `isAbsolute`，却仍会解析到进程的当前盘符，因此后端会拒绝它们，而不是重新定位协议传入的值。寻址到的 realm 以 POSIX 语义套用同一规则。

### 中止与探测

每次等待文件系统操作时，都会通过 `raceAbort` 与调用方的信号竞争，因此停滞的网络文件系统无法让已离开的调用方请求继续存活；已放弃的读取操作即使稍后结束，其结果也会被忽略。子项类型与 target 都来自寻址文件系统自身的列举。跟随链接的后端报告的是目标自身的类型，因此目录行无需探测即可进入窗口；报告链接本身的后端则用 `stat` 探测该条目自带的 target——与其他等待一样参与取消竞争——只有 target 为目录时才保留，因此断链与循环链接会被静默跳过，而取消仍抛出调用方自己的原因。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `BrowseDirectoryPicker` 服务：列举、创建、有界窗口、错误映射 |
| — | 不发布运行时不变式伴生入口；每次列举或创建都是一次无状态的文件系统往返；文件系统本身保存的状态具有权威性。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当后端约定不够用时阅读以下内容：先看 seam 定义，再看决策记录与原生替代方案。

- [目录选择 seam](../directory-picker/README.zh.md)——`browse` 能力约定与类型化错误词汇。
- [目录选择能力 seam 决策](../../../.agents/notes/archived/architecture/2026-07-28-directory-picker-capability-seam.md)——列举与创建背后的策略裁决。
- [原生后端](../directory-picker-native/README.zh.md)——面向本地操作者的 OS 选择器替代方案。
- [自适应选择器](../directory-picker-auto/README.zh.md)——两个后端之间的启动时判定。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-host-directory-picker-browse)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无。GUI 宿主的目录选择后端不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明浏览交互在何处不完整或有意不限定范围。它们是当前包约束，不是任务积压。

- **不读取 Windows 隐藏属性**——Node 的 dirent 不暴露 `FILE_ATTRIBUTE_HIDDEN`，因此在所有平台上 `hidden` 都意味着点前缀，直到原生探测值得付出相应成本为止。
- **不枚举盘符根**——Windows 上祖先链止于盘符根；跨盘依赖浏览器 UI 的路径输入入口，而不是这里的枚举原语。
- **全盘可浏览**——没有按部署限定的浏览根；`workspace.create` 接受任意路径，因此这里的根会限定 UX 范围，而不是安全边界。
- **远程创建沿用 realm 自身的创建策略**——被寻址的 realm 经 `FileSystem.mkdir` 创建，SSH 文件系统会按它自行解析的每次调用策略设栅；此后端不传策略，因此由该 realm 的默认策略决定，选择器无法在其外新建目录。
- **寻址到的单个层级会被完整物化**——`FileSystem.listDir` 返回完整层级，因此峰值内存取决于该后端自身的列举；有界窗口只约束响应保留的行数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

---
description: "为 dsh Web 客户端提供的远程主机管理设置分区：跟随的主机列表，以及添加、移除、测试连接与刷新。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-remote-hosts

[English](README.md) | 中文

## 概述

`dsh-client-ui-remote-hosts` 在 dsh Web 设置中新增一个**远程主机**分区。该分区按 id 顺序列出部署已注册的每台主机——名称、id、地址、工作区，以及本进程当前是否为该主机持有已打开的执行世界——并提供**添加主机**、**移除**、**测试连接**与**刷新**。添加主机会把存储登录材料、安装远端 helper 与打开执行世界作为一次 Host 事务执行；输入的私钥既不会被渲染，也不会被回传。它还持有“新建工作区所使用的主机”：点击某行的**选择**后，新建 Workspace 都指向该主机的执行世界；**改用本机**则把创建工作区交回 Harness 宿主机。

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

打开「设置」并选择**远程主机**。分区按 id 顺序列出已注册主机，并跟随 Host 的 `hosts/follow` 流，因此在别处注册或移除的主机无需手动刷新就会出现在列表中。

### 添加主机

添加对话框收集注册 id、名称、SSH 地址、端口、登录用户、可选的 armored 私钥、远端根目录与工作区，以及本地 helper 制品 manifest 路径。提交会调用 `hosts/add`——保存登录材料、读取 manifest、安装 helper、打开执行世界——执行期间提交按钮保持禁用。被拒绝时对话框保持打开，显示 Host 自己的诊断信息与已输入的草稿；私钥留空则该字段被省略，认证交给环境中的 SSH agent 与默认密钥。

### 移除主机

**移除**会打开一个写明主机名称的确认框。确认后调用 `hosts/delete`，关闭该主机的执行世界，并移除持久记录与已存登录材料。被拒绝时对话框保持打开并显示诊断信息，按钮重新可用。

### 测试连接

**测试连接**调用 `hosts/testConnection`，报告它到达的端点，以及 DSH 控制的 `known_hosts` 为该端点记录的每一行 host key。同一时刻只运行一次检查，因此旧的答案永远不会覆盖新的答案。

### 保持列表新鲜

列表通过 Gateway 的可重连监管器跟随 Host 流：每一代都以完整 baseline 开始，随后是按顺序的 `upsert` 与 `remove` 增量。载体中断会在监管器内部重开该代，这里无需任何操作；Host 主动结束的某一代是终止性的，因此最后一份列表会连同报告的诊断信息保留可见，直到**刷新**重开该流并读取新的 baseline。分区打开时会通过 `hosts/list` 重新采样每台主机执行世界的实时状态，因为该流只公布持久记录变化：在最后一次 baseline 之后停止的执行世界不能一直显示为已打开。

### 选择工作区主机

点击某行的**选择**后，该主机即成为之后新建 Workspace 所指向的执行世界：该行显示选中态，列表上方的文案给出所选世界，**改用本机**则把选择清回 Harness 宿主机。若所选主机离开注册表（在此处或其他客户端移除），选择也随之失效，否则之后的创建会指向一个无人持有的世界。若所选主机仍在注册表中但已不再持有执行世界，选择旁会明确指出这一点，其行内文案也会说明代价：执行世界从不重连，因此指向它的操作在主机被移除并重新添加之前都不可恢复。浏览对话框在列出路径时会标出所选世界，所选路径则与该主机一起送达 `workspaces/create`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包由一条注册规则、一个被跟随的数据源和两个对话框组成。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 插件主体：字典注册、主机列表数据源、inject face，以及 `settings.section` 注册。 |
| [`src/client/hosts-source.ts`](src/client/hosts-source.ts) | 跟随列表的投影、按需的执行世界状态采样，以及已结算的添加、移除与连接检查调用。 |
| [`src/client/selection.ts`](src/client/selection.ts) | `ctx.remoteHostSelection`：所有消费界面读取的“新建工作区所用主机”。 |
| [`src/client/RemoteHostsSection.tsx`](src/client/RemoteHostsSection.tsx) | 分区本体：列表状态、工具栏与两个对话框。 |
| [`src/client/HostRow.tsx`](src/client/HostRow.tsx) | 单行主机，包含端点信息与最近一次检查结果。 |
| [`src/client/AddHostDialog.tsx`](src/client/AddHostDialog.tsx) | 添加表单及其端口校验。 |
| [`src/client/RemoveHostDialog.tsx`](src/client/RemoveHostDialog.tsx) | 移除确认框。 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中文与英文文案字典。 |

### 注册与实时数据

分区通过 `ctx.slots.inject` 注册到 `settings.section`，因此只要 ui-settings 的声明在账本上就会出现，与 apply 顺序无关。被跟随的列表是该分区唯一的注册者私有响应式事实：它以裸快照源的形式发布在 inject face 保留的 `hooks` 舱中，并在渲染代码里通过绑定的 `useList` 选择器读取。表单草稿、进行中标记与逐行检查结果都是组件本地状态，添加、移除、连接检查与选择调用则是注入的回调。选择本身并非注册者私有——ui-workspace 通过它创建并浏览——因此本插件把它持有为 `ctx.remoteHostSelection` 服务（裸快照源加 `select`），而分区在自身的 `hooks` 舱中绑定同一个源。分区从不读取任何 context。

### 流与调用结果

`RemoteHostsSource` 通过 `ctx.remote.$stream` 打开一代受监管的流，并把每一帧折叠进已发布的列表。载体失败由监管器重试，而正常结束的一代是终止性的，会作为诊断信息显示在最后一份列表旁。每次 Remote 调用都被结算成一个结果——`{ ok: true }` 或 `{ ok: false, message }`——因此 Host 的拒绝或载体失败都以数据形式到达分区，而不是被拒绝的 promise；文案走本地化，Host 诊断则原样保留。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面覆盖本分区所依托的设置基座、它驱动的主机 namespace，以及它组合的共享控件。

- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.section` 与设置 scope 的设置领域基座。
- [ui-settings-general](../ui-settings-general/README.zh.md)——渲染每个分区的设置外壳。
- [ui-primitives](../ui-primitives/README.zh.md)——本分区组合的 `Button`、`Input` 与 `Modal` 原子组件。
- [hosts-controller](../../api/hosts-controller/README.zh.md)——`ctx.remote.hosts` namespace 及其新增事务。
- [connection](../connection/README.zh.md)——为主机流监管器供给重试节奏的载体代际。
- [Slots 参考](../../../docs/subsystems/slots.zh.md)——注册、props 五份额与 hooks 舱。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器端设置界面，不注册任何模型面。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本分区能显示与改动什么；它们是当前的包约束。

- **行内没有端口**——`hosts/list` 与 `hosts/follow` 报告的是已存 OpenSSH 别名而非输入的登录信息，因此一行只显示地址，端口仅出现在连接检查结果中。
- **打开标记是采样式而非推送式**——Host 只公布持久记录变化，因此在最后一次 baseline 之后停止的执行世界，要到分区打开、某一代重新取 baseline 或点击**刷新**时才会反映到列表。
- **断开的执行世界只被报告，不会被修复**——分区只说明其操作不可恢复，不提供重连操作，这与运行时的“不重连”契约一致；要重新持有执行世界，必须移除并重新添加该主机。
- **某一代关闭后增量即停止**——Host 主动结束的一代是终止性的；分区保留最后一份列表，需要**刷新**才能重开该流，并且其诊断文案原样显示在本地化标签旁边。
- **主机身份不会延伸到会话**——所选主机会到达 Workspace 创建及其目录浏览，但 Session 头仍然只带 `cwd`；把 Session 绑定到主机不属于本分区。
- **添加需要预先构建的制品 manifest**——表单只接收本地 manifest 路径，这里不会构建、上传或校验它。
- **没有载体中断的实时提示**——载体中断由 Gateway 监管器内部重试，因此重连期间分区不显示任何内容；只有监管器放弃的某一代才会可见。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本分区可变的事实是它从 Host 流投影出的列表，以及它为 ui-workspace 持有的“新建工作区所用主机”选择；每次 Remote 调用都以数据形式结算，注册表、凭证存储与新增事务都是各自所属包的契约。
# Agent Note: 会话到主机的身份放在 storage-domain sidecar 中

Status: implemented

[English](2026-09-22-session-host-sidecar.md) | 中文

## 问题

会话日志记录了自己的工作目录，却没有记录解释该目录的执行世界。[GUI 管理的 SSH 远端主机提案](../../proposed/architecture/2026-09-21-gui-managed-ssh-remote-hosts.zh.md)需要这一事实来支持 resume、对远端路径的 open/reveal 降级，以及按主机显示的 home；它原本计划把主机字段加在 session header 的 `cwd` 旁。

两条约束排除了该方案。已发布的 v3 读者会拒绝带未知键的 header，因为 JSONL header 的键是严格白名单，所以就地加字段会让每个新日志对已发布构建不可读。把格式升到版本 4 则是结构性变更，代价固定：迁移包、归档的 v3 前身、持久化变更记录、后继快照，以及 TypeScript 与 Python 两份 SDK 投影。与此同时，对常规路径而言这一事实本就存在于日志旁：GUI 通过 `workspaceId` 创建会话，而 workspace 记录携带拥有其路径的主机。

## 决策

会话到主机的身份存放在持久 sidecar 中，而不是会话日志里。`packages/api/session-controller/src/session-hosts.ts` 声明 `session_host` 域（版本 1），其中一张以 `SessionId` 为键的 `session_hosts` 表，记录形状只有 `{ hostId }`。store 通过 `ctx.storageDomain` 打开该域一次，随所属 fiber 关闭，以同步表查找读取记录，并通过域的 `put` 持久写入。storage domain 不可用、打开失败、写入失败，以及第二条记录指向不同主机，都会抛错；sidecar 绝不静默丢弃会话的主机。`SessionHeader`、`SESSION_FORMAT_VERSION` 与日志格式均不变。

记录在创建会话的同一操作里写入。由 `workspaceId` 创建的会话记录该 workspace 的 `hostId`；由裸 `cwd` 创建的会话记录内置本地主机，这正是此类会话今天的行为。写入发生在 Agent 已存在之后、create 调用返回之前，因此失败会报告给创建方，而不是留给后续读取去臆造答案。

一套解析顺序同时服务 resume、adopt 以及之后每一个按主机寻址的消费方：持久记录，其次是 `sessionIds` 中记有该会话的 workspace，最后是内置本地主机。在本 sidecar 之前写入的会话没有记录，因此解析结果与从前完全一致；resume 或 adopt 这类会话时会用解析出的主机回填记录。`ApiSessionAgentController.resolvedHostOf` 是该解析的唯一读取面。主机身份一经记录即不可变：出现冲突的第二主机时会在它有机会用另一个世界重新解释会话 cwd 之前就显式失败。

## 回到日志携带主机

sidecar 只对能够访问同一存储介质的读者作答。一旦某消费方必须仅凭会话日志看到主机——不打开 storage domain 的冷列表、导出或工具，Python 运行时之类本 Harness 进程之外的读者，或要求主机身份在单独复制会话文件后仍然保留——格式携带主机就变得必要。此时 sidecar 无法作答，只有带格式版本后果的 header 字段可以，因此该需求必须当作格式变更处理，而不是再加一个 sidecar。

## 考虑过的替代方案

**在现有 v3 header 中加 `hostId`。** 这是源码改动最小、读取成本最低的方案。它也会让每个已发布的 v3 读者拒绝新日志，因为 header 键是严格白名单；今天写入的会话将无法被昨天发布、并写下它的构建重新 resume。

**把格式升到版本 4，并在 header 中携带主机。** 这保留单一持久事实来源，也不需要第二个 store。代价是一个迁移包、归档的 v3 前身、持久化变更记录、后继快照与两份 SDK 投影——而 GUI 的常规创建路径本就能从 workspace 记录回答这一事实，且当前没有任何消费方仅凭日志读取主机。

**只在读取时从 workspace 推导主机。** 无需新的持久 store，对 workspace 范围内的会话而言 workspace 记录本就是权威。它无法回答裸 `cwd` 会话，workspace 删除后什么也答不出，并把每次读取变成一次 workspace 注册表扫描。

## 影响

已发布读者（含两份 SDK 投影）继续能打开今天的日志，主机身份无需迁移或后继快照即可加入。代价是第二个必须随创建写入的持久 store：某会话的记录写入被漏掉时会降级到「workspace 再本地」的回退，而不会被误读；域名称、版本与记录形状则成为后续变更必须版本化的持久格式。

拥有会话但没有 sidecar 介质的进程看不到会话的主机。在本 Harness 内，storage domain 与拥有 workspace 记录的介质相同，因此两个 sidecar 彼此一致；边界正是「回到日志携带主机」一节所指出的情形。

## 验证

`packages/api/session-controller/tests/session-hosts.host.spec.ts` 覆盖：记录并读回主机、拒绝冲突主机、记录→workspace→本地的回退顺序、写入失败显式报错、重新打开时把空主机规范化为本地、新 store 在同一介质上读到旧记录、缺少 storage domain 与缺少 workspace 注册表时的显式失败，以及未打开与打开失败的域在释放时都被处理。`tests/agent.host.spec.ts` 覆盖：创建时记录具名远端主机与裸 cwd 的本地主机；旧会话在 resume 时经其 workspace 解析并回填记录；远端创建路径继续使用其 provisioning 策略。所有被改动源文件保持逐文件 100% 覆盖率。

## 相关

[文件系统目录创建决策](2026-09-22-filesystem-directory-creation-primitive.zh.md)拥有本 sidecar 主机随后要寻址的会话 cwd 预备策略。[GUI 管理的 SSH 远端主机提案](../../proposed/architecture/2026-09-21-gui-managed-ssh-remote-hosts.zh.md)在主机注册表与 GUI 界面方面仍然有效；本笔记只取代它「session header 携带主机身份」的预期。
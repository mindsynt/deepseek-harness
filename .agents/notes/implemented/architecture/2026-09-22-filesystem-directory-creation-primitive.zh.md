# Agent Note: 文件系统 seam 上的目录创建

Status: implemented

[English](2026-09-22-filesystem-directory-creation-primitive.md) | 中文

## 问题

`dsh-fs` Service Definition 交付了十三个原语，却无法创建目录。需要创建目录的消费方只能离开 seam：会话创建通过远端世界的 subprocess 提供方执行 `mkdir -p`，直到本决策把它移回 seam；目录选择器则仍然完全拒绝在远端主机内创建。两种做法都绕过了文件系统能力负责的约束，而且 subprocess 变通把一个只产生文件系统改动的操作与进程词汇绑在一起。

执行世界已经能通过 `writeText` 创建文件，而后者会顺带创建缺失的父目录。因此缺失的目录原语表现为写入路径的副作用，而不是一份契约，也没有消费方能够询问目录是否已经存在。

## 决策

`FileSystem` 新增抽象方法 `mkdir(target, signal?, sandboxPolicy?)`，返回 `FsMkdirOutcome`（`{ created: boolean }`）。创建总是包含所有缺失的父目录，并且是幂等的：目标已是目录时不做任何改动并返回 `created: false`；目标或父路径组件已存在但不是目录时以 `FS_NOT_DIRECTORY` 失败。该操作不接受 `recursive` 或 mode 参数——父目录总是被创建，权限由提供方的 umask 决定——也没有版本守卫，因为重复执行在构造上就是安全的。

失败沿用既有 `FsErrorCode`：目标或父目录不是目录用 `FS_NOT_DIRECTORY`，提供方的权限与 I/O 故障用 `FS_PERMISSION_DENIED` 与 `FS_IO_ERROR`，目录生效前的取消用 `FS_ABORTED`。seam 不新增错误码，因此错误分类体系、其文档以及每个消费方的分支集合都保持不变。

`fs-local` 先探测目标，再用其原子写入早已使用的同一个递归辅助函数创建目录，并把创建失败统一翻译：竞争导致的非目录父路径映射为 `FS_NOT_DIRECTORY`，权限故障映射为 `FS_PERMISSION_DENIED`，其余映射为 `FS_IO_ERROR`。`fs-sandbox` 用 `checkedTarget` 像围栏 `writeText` 与 `editText` 一样围栏创建，然后用重新规范化后的目标委托。`fs-ssh` 携带解析后的逐次调用策略转发 `fs.mkdir`，辅助程序在该策略下运行远端 `SandboxedFileSystem.mkdir`，因此远端围栏绝不会弱于远端写入。

没有任何后端回落：无法创建目录的提供方必须显式失败，而不是报告成功；Definition 也不声明默认实现。

## 远端辅助程序与线路版本

辅助程序的分发新增 `fs.mkdir`，它和 `fs.write`、`fs.edit` 一样要求调用方提供策略。`SSH_PROTOCOL_VERSION` 在同一改动中由 1 升到 2。任何辅助程序源码改动都会改变入口摘要，因此面对重建安装时，1 版已安装辅助程序本就会因摘要不匹配被拒绝；版本升级把失败提前到握手阶段——用于配置的产物仍指向旧辅助程序的部署不必等到稍后某个未知操作以 `FS_IO_ERROR` 暴露。`helloSchema` 改为读取该常量而非字面量，使两者不会再次漂移。

## 考虑过的替代方案

**在基类给出抛错的默认实现。** 让 `mkdir` 保持非抽象可以避免破坏仓外提供方，但此 seam 上其他变更操作都是抽象的，而基类默认值会让从未实现创建的提供方先激活、只在模型调用时才失败。抽象成员把缺失角色变成编译期事实。

**保留 subprocess 的 `mkdir -p` 变通。** 它对会话创建可用，且无需改动 seam。但它绕过了文件系统能力本应施加的沙箱围栏，要求调用方提供与策略无关的执行世界路径，并会被之后每个消费方复制。把操作移回 seam 让约束只有一个所有者。

**增加 `recursive` 与 mode 选项。** 非递归模式可以让选择器用平台自身的错误区分「已存在」，mode 可以让调用方设置权限。当前没有消费方需要二者：选择器映射 `created: false`，所有调用方都接受 umask。没有当前所有者的选项应当延后，而非提前交付。

**为非目录情况新增 `FS_ALREADY_EXISTS` 错误码。** 选择器的本地实现曾报告 `EEXIST`，新错误码可以镜像它。新增联合成员会改变每个后端与消费方分支所依据的分类体系；`created: false` 加 `FS_NOT_DIRECTORY` 已能表达相同结果。

**让 `SSH_PROTOCOL_VERSION` 停在 1。** 纯增量操作在线路上兼容，因此严格来说不需要升级。已安装辅助程序与客户端本就由摘要固定成对，而升级只花一行，却把一次迟到的、含义模糊的逐调用失败提前为握手拒绝。

## 影响

seam 现在暴露十四个原语，`dsh-fs` 用一个契约同时拥有本地、受限与远端世界的目录创建。会话创建在同一改动中切到该原语，不再为一个文件系统效果启动进程；目录选择器的远端半边仍是独立后续项，并且还需要在其线路请求中携带主机身份。

每个 `FileSystem` 实现方都必须实现该成员，包括三个 provider 之外的仓内测试替身；它们在同一改动中获得了最小实现。已发布的辅助程序产物必须重建并重新安装：归档、其 manifest 摘要与 `SSH_PROTOCOL_VERSION` 一起变化，仍运行旧产物的部署在重新置备之前会握手失败。

`mkdir` 创建父目录，并且只报告本次调用是否创建了目标；它不返回版本，并发创建者也可能让另一次调用刚刚创建的目录报告 `created: true`。这与幂等创建一致：需要所有权协调的调用方必须自行串行化。

## 验证

`packages/fs/fs-local` 对已创建目录、已存在目录、文件目标、已取消调用、竞争导致的非目录父路径、权限失败与 I/O 失败分别单测探测与错误翻译，provider 测试则覆盖经 `ctx.fs` 的「解析后创建」。`packages/fs/fs-sandbox` 证明 `read-only` 拒绝且磁盘上不留目录、`workspace-write` 在工作区内创建并在区外及经符号链接外指时拒绝、`danger-full-access` 委托，以及逐次调用的升级授予。`packages/ssh/fs-ssh` 断言转发的请求、显式与默认两条路径上的解析策略，以及返回的标志。`packages/ssh/ssh` 通过私有传输驱动真实辅助程序，证明创建、第二次调用的 `created: false`，以及只读策略下的 `FS_SANDBOX_DENIED`，辅助程序自身的文件系统套件覆盖该操作。所有被改动源文件保持逐文件 100% 覆盖率。

catalog 与 graph 生成器依据新声明重新生成，辅助程序产物构建产出部署方安装所需的摘要。`packages/sandbox/sandbox-policy` 单测证明 `provisioningPolicy` 在只读部署默认下仍返回以给定根为界的 `workspace-write`，并拒绝相对根；`packages/api/session-controller` 断言远端分支传入的策略精确相等、无策略 owner 的路径、保持不变的 Harness 主机分支，以及主机缺失或未打开时的显式失败。

## 会话根目录预备的授权

会话创建通过 `world.fs.mkdir` 预备其工作目录，授权该调用的策略来自 sandbox-policy owner，而不是创建请求：`SandboxPolicyService.provisioningPolicy(root)` 返回 `{ mode: 'workspace-write', workspaceRoot: root }`，并像 `resolve` 一样保留根的「执行世界」拼写。目标根只授权它自己的子树，这正是会话存在之后 `resolve` 赋予它的边界——会话 cwd 就是它的 `workspace-write` 根——因此预备不会扩大到所创建目录之外的任何范围，而施加围栏的后端在包含关系不成立时依旧显式失败。

该授权有意独立于部署默认 mode 与会话 mode，因为创建发生在会话存在之前：`read-only` 部署仍必须创建只读会话将要读取的目录，而会话自身的 mode 此后管辖每一项模型操作。创建请求不携带 mode，因此 GUI 或任何其他客户端都无法在创建时放宽围栏。没有策略 owner 的组合读不到策略，由后端沿用自身规则。

「cwd 位于所有工作区之外」对本操作没有独立含义：被创建的目录本身就是围栏根。仍可能失败的是目标是已存在的文件（`FS_NOT_DIRECTORY`）、宿主权限或 I/O 故障（`FS_PERMISSION_DENIED` 或 `FS_IO_ERROR`）、后端包含关系不一致（`FS_SANDBOX_DENIED`），以及命名主机没有打开的 realm——后者保持显式错误，绝不回落到 Harness 主机的文件系统。Harness 主机自身的分支保留 `node:fs.mkdir`，因此本机行为不变。

## 延后：选择器的远端半边

目录选择器仍只在 Harness 主机上创建，其 `createDirectory` 请求不携带 `hostId`，因此无法寻址远端世界。该线路改动是独立后续项；从裸 `cwd`（而非 Workspace 身份）创建会话同样如此：远端创建通过携带主机身份的 Workspace 寻址，而本决策正需要这一身份。
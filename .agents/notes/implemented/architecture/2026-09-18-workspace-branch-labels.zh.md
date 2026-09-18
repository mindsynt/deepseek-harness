# Agent Note: 工作区分支标签

Status: implemented

[English](2026-09-18-workspace-branch-labels.md) | 中文

## Problem

工作区浏览器只显示工作区标题，不显示它的检出状态，因此同一项目存在多个检出时，开发者必须离开 GUI 才能判断某一行属于哪个分支。

检出分支是工作区目录的真实状态，但不是工作区状态：`git checkout` 不修改注册表拥有的任何记录，而持久化的 `WorkspaceView` 投影由 `domain/changed` 事件重建。把它存进该记录，从第一次切换分支起就会失真；只读一次的分支，也会在用户在终端或 DSH 自带终端面板里切换的那一刻过期。

## Decision

`workspace/branches` 是宿主工作区控制器上独立的一元 Remote 动词。它读取每个已注册工作区的 `.git/HEAD`（[branches.ts](../../../../packages/api/workspace-controller/src/branches.ts)）：`ref: refs/heads/<name>` 给出分支名，40 位十六进制的 HEAD 给出其前 8 个字符，`gitdir:` 指针文件解析到 worktree 或 submodule 的元数据目录；其余情况——不是检出、元数据不可读、符号引用不在 `refs/heads` 下——返回无条目而不是错误。

每个检出配一个 watcher 让标签保持实时。`WorkspaceBranchWatch` 跟随持有 `HEAD` 的目录——git 目录本身，或 `gitdir:` 指针时的工作区根——按可校验的 `Config` 字段 `branchWatchDebounceMs` 作为落定窗口，在写入后重读分支并发 `workspace/branch-changed`；该事件在"转发宿主事件"白名单里，因此浏览器经 `$events` 流收到它，客户端模型直接更新标签映射，无需重新拉取。监听不可用的宿主或沙箱退化为按需读取：此时标签在工作区集合变化或界面加载时刷新。

客户端工作区模型把标签放在 `WorkspaceSnapshot.branches`，与宿主投影分开的映射。已注册的 (id, path) 集合变化时重新读取，`IWorkspaces.refreshBranches()` 让展示分支的界面在加载时显式重读。工作区浏览器把该映射合并进树用于分组的行，项目行在标题之后用自己的字典条目渲染标签（中文全角括号、英文半角）。

不启动子进程：`.git/HEAD` 就是检出引用在磁盘上的事实，而调用 `git` 需要 Subprocess 能力、可执行文件与限制 Config，还要为缺少该能力的组合准备回退。

读取按设计失败即降级。分支只是一个标签，因此文件系统故障、目录被删除或 HEAD 无法解析都不得表现为工作区错误，也不得移除该行。

## Alternatives considered

**把分支存进持久化工作区记录。** 已否决：`git checkout` 不会触发任何 DSH 事件，因此该值会一直失真，直到别的修改重写记录；而两个构建 Remote 值的投影函数都是同步的，由 `domain/changed` 驱动。

**通过 Subprocess 能力运行 `git rev-parse --abbrev-ref HEAD`。** 已否决：这会让该动词依赖工作区注册表本不需要的能力与 Config，而读一个文件已经回答了同一事实。若标签需要报告 `.git/HEAD` 无法表达的状态（例如进行中的 rebase 或与上游的分叉），再重新考虑。

**在浏览器里计算标签。** 已否决：浏览器既够不到文件系统，也起不了进程。

**用定时器轮询分支。** 已否决：定时器为每个已注册检出反复询问一个极少变化的事实，并且只要标签页存在就要一直付费。操作系统本来就会报告改变它的那次写入。

**递归监听工作区根目录。** 已否决：检出的 `HEAD` 只在一个已知文件里，递归监听会把 inotify 预算花在构建与编辑流量上，只为一个事实。每个检出一个非递归 watcher 就是全部需求。

## Consequences

- 分支永不持久化：会话日志、录制的快照与 profile 投影都不携带分支值，推送的标签只是进程内的。
- 实时标签的代价是每个已注册检出一个文件系统 watcher，随插件存活，并在工作区集合变化时重建。不是检出的路径没有 watcher，因此在其上新建的检出要等下一次工作区集合变化才会被发现。
- 受限宿主可能无法监听，届时标签退化为按需读取，在下一次工作区集合变化或界面加载前保持陈旧。
- `WorkspaceSnapshot` 新增必填的 `branches` 字段，`IWorkspaces` 新增 `refreshBranches()` 方法，因此实现其一的每个测试替身与快照 fixture 都要带上新成员。
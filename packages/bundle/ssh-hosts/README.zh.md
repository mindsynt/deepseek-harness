---
description: "面向基于 base 的 dsh profile 的可选 SSH 远程主机层：已注册主机会在各自隔离的执行世界中运行，本机则保持内置执行世界，供组合或定制 profile 的用户使用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-ssh-hosts

[English](README.md) | 中文

## 概述

`dsh-ssh-hosts` 是可选的组合包，让一个基于 base 的 `dsh --profile` 表层把 SSH 主机当作执行世界来使用。它挂载[主机注册表](../../ssh/host-registry/README.zh.md)、[助手安装器](../../ssh/helper-installer/README.zh.md)、[主机凭证存储](../../ssh/host-credentials/README.zh.md)，以及位于这三者之上的[主机控制器](../../api/hosts-controller/README.zh.md)；本机保持内置世界，每台已注册主机则获得自己隔离的 `ssh`、`fs`、`subprocess` 与 `sandbox` 服务领域。随发行版交付的任何 profile 都不包含本层：请在 `@deepseek-ai/dsh-base` 之后把它加入 `dsh.profile.bundles`，再在后续 profile patch 层声明主机。未声明任何主机时，它不改变任何行为。

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

### 把本层加入 profile

随发行版交付的 `web`、`headless`、`acp` 与 `sdk` profile 不包含本组合包；需要远程主机的 profile 应在 `dsh-base` 之后列出它：

```json
{
  "name": "my-remote-profile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-ssh-hosts"]
    }
  }
}
```

树外（out-of-tree）组合包通过 `dsh plugin --profile <name> add @deepseek-ai/dsh-ssh-hosts` 安装进 profile；内置组合包从 dsh 安装目录解析。该层随后恰好贡献四条行：`ssh-host-registry`、它用于执行安装的 `ssh-helper-installer`、它用于物化登录材料的 `ssh-host-credentials`，以及位于前两者之上的 `ssh-hosts-controller` Remote owner。注册表行把安装器与凭证存储声明为注入依赖，控制器则声明注册表与凭证存储，因此每条行都只在所需服务挂载后激活；凭证行不需要任何配置，因为其状态目录默认是 `<DSH home>/ssh-hosts`。profile 约定见 [app-boot 的 profile 章节](../../boot/app-boot/README.zh.md)。

### 声明主机

该层自身不声明任何主机：其 `ssh-host-registry` 行携带 `hosts: []`，因此添加本组合包的 profile 在后续 patch 层声明主机之前，一直保持本机执行世界。请先用 `pnpm run build:ssh-helper-artifact` 构建助手包，再让该行指向它的 manifest：

```yaml
- id: ssh-host-registry
  config:
    manifest: /opt/dsh/ssh-helper/manifest.json
    hosts:
      - id: build-01
        host: build-01
        root: /opt/dsh
        workspace: /srv/work
      - id: gpu-02
        label: GPU box
        host: gpu-02
        manifest: /opt/dsh/gpu-02/manifest.json
        root: /opt/dsh
        workspace: /home/ci/work
```

`manifest` 是 `pnpm run build:ssh-helper-artifact` 产出的 `manifest.json` 的本机绝对路径；每个条目可以自带一个，未自带的条目使用插件级路径。随发行版交付的行使用环境变量 `DSH_SSH_HELPER_MANIFEST` 作为回退。随后激活会读取每个 manifest、装载其指向的归档、经 OpenSSH 安装该制品，并打开该主机的隔离领域。配置、manifest 或安装出错都会让 profile 加载失败，并在错误信息中带上主机 id 与文件路径；不会静默跳过任何条目。

### 你得到什么

声明主机后，`ctx.remoteHosts` 为每台主机列出一个已打开的 handle，每个 handle 暴露该主机的 `ssh`、`fs`、`subprocess` 与 `sandbox` 服务。`ctx.hostsController` 与生成的 `ctx.remote.hosts` namespace 让浏览器可以列出、新增与移除这些主机。[注册表包](../../ssh/host-registry/README.zh.md)负责领域生命周期、地址寻址与安装；[连接包](../../ssh/ssh/README.zh.md)负责每个领域背后那条不重连的 OpenSSH 会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本组合包是一份静态 patch 文档：一个应用在 `dsh-base` 层之后的 `insert` 列表。它自身不挂载任何服务，也不持有任何可变状态；每条插入行所属的包负责该行的行为与不变式。

### 组合机制

该 insert 只携带注册表、安装器、凭证存储与主机控制器，刻意不携带本机的 `fs`、`subprocess` 与 `sandbox` 提供方：本机保持 base 组合出的内置世界，每台远端主机的执行世界则由注册表挂载在自己的隔离领域中。patch 会替换目标行的整个 `config`，因此声明主机的部署必须同时重述 `manifest` 与 `hosts`。注册表行把 `sshHelperInstaller` 与 `sshHostCredentials` 声明为注入依赖，因此无论行序如何，激活都会等待这两条行，安装过程绝不会与它需要的服务抢跑。

### 激活

`apply` 先校验配置，再挂载注册表，然后按顺序安装每个已声明主机：读取条目的 manifest，校验 `entry`、`digest` 与 `archive`，装载 manifest 旁的归档字节，并调用 `ctx.remoteHosts.provision(...)`。任一步失败都会抛出，因此配置到一半的 profile 会在加载时失败，而不是带着更少的主机继续运行。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 组合包的实体：四条插入行，附以行内注释说明依据 |
| [`src/index.ts`](src/index.ts) | 包入口；不携带任何运行时 API |
| — | 不发布运行时不变式伴生入口；本包是静态 patch 列表载体，每条插入行所属的包负责该行的不变式。 |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | patch 声明、行集合与依赖检查 |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | 以测试专用凭证提供方为依赖，经真实 Loader 组合这四条行，并覆盖缺注入场景 |

### 不变式归属

不发布不变式伴生入口，因为本包是静态 patch 列表载体：注册表负责领域生命周期与安装，安装器负责经摘要校验把制品放到主机上。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md)——连接、助手与提供方组合。
- [主机注册表](../../ssh/host-registry/README.zh.md)——领域生命周期、地址寻址与安装语义。
- [助手安装器](../../ssh/helper-installer/README.zh.md)——制品如何到达主机。
- [主机凭证](../../ssh/host-credentials/README.zh.md)——注册表用于物化登录材料的已存登录记录。
- [主机控制器](../../api/hosts-controller/README.zh.md)——浏览器主机管理页面调用的 Remote namespace。
- [组合包索引](../README.zh.md)——可以叠加的 profile 层。
- [GUI 管理 SSH 远程主机设计笔记](../../../.agents/notes/proposed/architecture/2026-09-21-gui-managed-ssh-remote-hosts.zh.md)——本层所属的阶段规划。

-----

<a id="model-experience"></a>
## 模型体验

通过注册表及其挂载的执行提供方间接产生影响：这些包负责所有模型可见的值，而本组合包自身不注册任何工具、提示词章节或结果。

#### KV Cache 影响

组合包本身不添加任何请求前缀；其四条行背后的包负责各自的缓存影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **尚无浏览器页面渲染主机管理**——控制器已暴露该 namespace，但还没有客户端装配挂载本贡献，也没有设置页面可以列出、新增或移除主机。
- **主机不会被持久化**——已声明的主机列表保存在 profile patch 中，而不是持久存储；新增或编辑主机意味着修改配置并重新加载 profile。
- **没有真实远端的端到端验证**——组合测试以测试专用凭证提供方为依赖、经真实 Loader 装载这三条行，但此处的任何内容都不会连接真实 SSH 主机。
- **必须构建制品 manifest 并指向它**——未配置 manifest 时激活会立即失败，其旁的归档必须是 `pnpm run build:ssh-helper-artifact` 的产物。
- **`sandboxPolicy` 未按主机隔离**——每个领域都从父作用域解析它，因此两台主机目前还不能使用不同的约束策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
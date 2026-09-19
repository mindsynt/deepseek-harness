# Agent Note: 设置持久化跟随 Host 的 /api 信任围栏

Status: implemented

[English](2026-09-19-settings-persistence-follows-the-host-fence.md) | 中文

## 问题

设置面板对所有 authority 不是 loopback 的页面禁用 Host 持久化设置：`dsh-client-ui-settings` 在 apply 时解析一次 `ctx.remote.$host.isLoopback`，并把 `memory` 持久化交给 describe mirror 和每个绑定的 scope。因此，当浏览器以服务 authority 打开 GUI 时——无论是 `dsh web` 推导出的局域网 IP，还是运维用 `--trusted-host` 明确声明的 authority——拿到的 mirror 从不过线路：模型页面加载失败，每一行偏好设置都失效，尽管 Connection 已认证整个 API。

该限制早于[浏览器信任围栏](2026-07-28-api-browser-trust-boundary.zh.md)与[进程绑定的浏览器会话](2026-09-18-process-bound-browser-session.zh.md)，并且它重新裁定了 Host 已经裁定的事。`src/api-request-trust.ts` 接受 loopback、部署推导出的局域网 IPv4 字面量，以及显式的 `trustedHosts` 条目；浏览器认证随后把页面绑定到只有签发进程才能校验的 cookie。只要页面能到达 `/api`，Host 就已经接受了它的 authority。Client 看不到这些声明的 authority——它们位于 Host 配置中——所以它改用页面 hostname 来猜测，结果恰好拒绝了那些特意声明自己 authority 的部署。

## 决定

`dsh-client-ui-settings` 不再携带持久化模式。`SettingsDescribeMirror` 无条件读取 `settings.describe`，`SettingsScopeController` 由这一个答复推导出所有命名空间 scope，所有写入都经 `settings.mutate`。`SettingsScopeSnapshot` 去掉 `mode`，`SettingsMirrorSnapshot` 去掉只有 memory 模式才会产生的终态 `unavailable` 状态。

信任裁定留在能够尊重 `trustedHosts` 的地方：Host 的 `/api` 围栏加上浏览器认证。消费方随之调整：

- `dsh-client-ui-settings-general` 无条件注册设置文档操作。该操作仍只在 Host 报告 `hasDocument` 后才渲染，因此没有本地文档的提供方不显示任何内容。
- `dsh-client-ui-settings-models` 始终通过 `ui-onboarding.welcomeNoticeVersion` 记录欢迎提示的确认；进程内确认回退被移除，而 mirror 无答复时报告为 `the settings document has not answered yet`，不再归咎于浏览器。
- `dsh-client-ui-permission-presets` 去掉其 mirror 终态分支。

被反转的规则记录在 [Host 支撑的 Web 偏好笔记](../bug-fix/2026-08-06-host-backed-web-preferences.zh.md)中，该笔记保留其余决定并链接到本文。

## 考虑过的替代方案

- **把围栏的判定作为每连接的 Host 事实传给 Client。** 转发事件的开帧携带在注册时构建一次的进程事实（`home`），而 WebSocket mux 不会把 upgrade 请求传递到 stream opener，因此该标志需要新的 wire 管道并拓宽 `RemoteEventHostInfo`。若改为在 Client 内比较 `trustedHosts`，则会在强制执行信任规则的实现之外，再复制一份围栏的规范化 authority 逻辑，两者可能漂移。
- **对围栏拒绝的 authority 保留 memory 模式。** 否决：被拒绝的 authority 永远到不了 `/api`（分发前即 403），因此该模式没有可达的用户群。保留它只会留下死分支，以及浏览器内第二份更弱的信任规则。
- **新增 `--allow-remote-settings` 之类的开关。** 否决：`--trusted-host` 已经表达了这一区分，再加开关会增加产品面，且两者可能互相矛盾。
- **接受该失败并把它记录为限制。** 否决：这会让 GUI 最主要的配置界面在运维特意配置的部署中不可用，而同一个页面已经可以通过已认证 API 驱动具备工具能力的会话。

## 后果

loopback 页面与以可信 authority 提供的页面现在读写同一份持久化 `$DSH_HOME/settings.yaml`。被围栏拒绝的页面拿不到设置——也拿不到任何其他 `/api` 方法。Client 不再在任何地方提供进程内设置模式：在共享的服务 Host 上，设置写入会落入服务用户的 home，所使用的已认证会话本就允许会话提示与工具调用。`SettingsScopeSnapshot.mode` 与 mirror 的 `unavailable` 状态已从公开契约中移除。

`packages/client/ui-settings/tests/plugin.client.spec.ts` 固定了报告 `$host.isLoopback === false` 的页面仍会读取 Host 文档。`packages/client/ui-settings-general/tests/apply.client.spec.ts` 在非 loopback 下填充每个 seat 并采用 Host 语言，`packages/client/ui-settings-models/tests/apply.client.spec.ts` 在非 loopback 下经 `settings/mutate` 完成确认。
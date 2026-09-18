# Agent Note: 进程绑定的浏览器会话

Status: implemented

[English](2026-09-18-process-bound-browser-session.md) | 中文

## Problem

[浏览器启动令牌认证](2026-08-24-browser-token-authentication.zh.md)的决定把 cookie 签名密钥做成持久的，好让浏览器在普通 `dsh` 重启后仍能连回。这让启动令牌成为进程级凭据，而它换来的 cookie 却成了长期凭据：一个 cookie 能跨任意次重启一直用到 `cookieMaxAgeDays`（默认 30 天），于是停掉 Host 并不能结束上一个进程授权过的浏览器会话。停掉服务的运维者没有"以重启为界"的吊销手段；文档给出的机制是删除凭据记录，而那会连带结束其他所有浏览器会话，并且要求编辑凭据文件。

## Decision

`BrowserAuth` 用持久记录与**本进程自己的启动令牌**派生每个进程的签名密钥：`HMAC-SHA256(rootSecret, launchToken)`。`isAuthenticated` 用该密钥校验 cookie，因此 cookie 只对签发它的那个进程有效。重启会生成新的启动令牌，于是上一个进程签发的所有 cookie 都验不过，得到最小化的 401——也就是未认证请求本来就收到的那个响应，其正文已经提示调用方重新打开 `dsh web` 打印的 URL。

会话的其他部分没有变化。cookie 仍绑定 authority、仍有绝对的 `cookieMaxAgeDays` 生命周期、属性不变；同一进程内的 Connection 重载保留启动令牌，因此浏览器不会被登出；持久记录 `client-connection/browser-session` 仍是吊销根，删除它依旧会让此后签发的每个 cookie 失效。

## Alternatives considered

**继续用持久密钥直接签名。** 已否决：这正是本 note 取代的行为。它让被盗 cookie 拥有完整配置生命周期，也让"重启 Host"成为一个不结束浏览器权限的操作。

**只缩短 `cookieMaxAgeDays`。** 已否决：它只能收紧被盗 cookie 的窗口，运维者仍然无法靠重启结束既有会话。

**每次重启轮换持久密钥。** 已否决：那会在每次启动时改写 `$DSH_HOME/.credentials.yaml`，与并发启动竞争，并消耗该记录作为显式吊销根的角色。从既有密钥与启动令牌派生进程密钥能达到同样的有效性规则，且不触碰持久状态。

**增加 logout 或会话吊销动词。** 已否决：当前没有消费方要求吊销单个会话，而进程绑定已经补上本 note 针对的重启缺口。删除凭据记录并重启仍是全局吊销机制。

## Consequences

- Host 进程停止时每个浏览器会话都结束，包括同 home、同 authority 的重启。重新打开打印的 URL 是唯一入口，这也是 401 正文已经给出的指引。
- 被盗 cookie 同时受进程生命周期与绝对生命周期约束，持久密钥不再隐含自己的 bearer 生命周期。
- Connection 重载（HMR、generation 替换）发生在同一进程内，不会把浏览器登出。
- 持久记录不再直接签名；它的剩余角色是吊销根，缺失或被替换仍会让此后所有 cookie 失效。
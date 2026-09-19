# Agent Note: Settings persistence follows the Host /api fence

Status: implemented

English | [中文](2026-09-19-settings-persistence-follows-the-host-fence.zh.md)

## Problem

The Settings plane disabled durable Host settings on every page whose authority was not loopback: `dsh-client-ui-settings` resolved `ctx.remote.$host.isLoopback` once at apply and handed `memory` persistence to the describe mirror and every bound scope. A browser that reached the GUI at a serving authority — the LAN IP `dsh web` derives, or an authority the operator declared with `--trusted-host` — therefore got a mirror that never crossed the wire: the Models page failed its load, and every preference row was inert even though Connection authenticated the complete API.

That gate predates the [browser-trust fence](2026-07-28-api-browser-trust-boundary.md) and the [process-bound browser session](2026-09-18-process-bound-browser-session.md), and it re-decided what the Host already decides. `src/api-request-trust.ts` admits loopback, the deployment-derived LAN IPv4 literals, and explicit `trustedHosts` entries; browser authentication then binds the page to a cookie only the issuing process can verify. Whenever a page can reach `/api` at all, the Host has already accepted its authority. The Client cannot see the declared authorities — they live in Host configuration — so it guessed from the page hostname instead, and refused exactly the deployments that named their authority on purpose.

## Decision

`dsh-client-ui-settings` carries no persistence mode. `SettingsDescribeMirror` reads `settings.describe` unconditionally, `SettingsScopeController` derives every namespace scope from that one answer, and all writes go through `settings.mutate`. `SettingsScopeSnapshot` loses `mode`, and `SettingsMirrorSnapshot` loses the terminal `unavailable` status that only memory mode produced.

The trust decision stays where it can honor `trustedHosts`: the Host `/api` fence plus browser authentication. Consumers follow:

- `dsh-client-ui-settings-general` registers the settings-document action unconditionally. The action still renders only after the Host reports `hasDocument`, so a provider with no local document shows nothing.
- `dsh-client-ui-settings-models` always records the welcome acknowledgement through `ui-onboarding.welcomeNoticeVersion`; the process-local acknowledgement fallback is gone, and an unanswered mirror is reported as `the settings document has not answered yet` instead of blaming the browser.
- `dsh-client-ui-permission-presets` drops its terminal mirror-status branch.

The reversed rule was recorded by the [Host-backed Web preferences note](../bug-fix/2026-08-06-host-backed-web-preferences.md), which keeps its remaining decision and links here.

## Alternatives considered

- **Carry the fence's verdict to the Client as a per-connection Host fact.** The forwarded-event opening frame carries process facts (`home`) built once at registration, and the WebSocket mux does not thread the upgrade request into the stream opener, so the flag would need new wire plumbing plus a widened `RemoteEventHostInfo`. Comparing `trustedHosts` inside the Client instead would duplicate the fence's canonical-authority normalization in a second implementation that can drift from the one enforcing it.
- **Keep memory mode for authorities the fence refuses.** Rejected: a refused authority never reaches `/api` (403 before dispatch), so the mode had no reachable population. Keeping it would leave dead branches and a second, weaker copy of the trust rule in the browser.
- **A new opt-in such as `--allow-remote-settings`.** Rejected: it adds product surface for a distinction `--trusted-host` already expresses, and the two settings could disagree.
- **Accept the failure and document the limitation.** Rejected: it makes the GUI's primary configuration surface unusable in the deployment the operator configured, while the same page already drives tool-capable Sessions through the authenticated API.

## Consequences

Loopback pages and pages served at a trusted authority now read and write the same durable `$DSH_HOME/settings.yaml`. A page the fence refuses gets no settings — and no other `/api` method either. The Client no longer offers a process-local settings mode anywhere: on a shared serving Host, Settings writes land in the serving user's home under the same authenticated session that already permits session prompts and tool calls. `SettingsScopeSnapshot.mode` and the mirror's `unavailable` status are removed from the published contract.

`packages/client/ui-settings/tests/plugin.client.spec.ts` pins that a page reporting `$host.isLoopback === false` still reads the Host document. `packages/client/ui-settings-general/tests/apply.client.spec.ts` fills every seat and adopts the Host locale off-loopback, and `packages/client/ui-settings-models/tests/apply.client.spec.ts` acknowledges through `settings/mutate` off-loopback.
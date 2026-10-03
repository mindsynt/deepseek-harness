---
description: "The optional SSH remote-host layer for base-backed dsh profiles: registered hosts run in isolated execution worlds while the local machine stays the built-in realm, for users composing or customizing a profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-ssh-hosts

English | [中文](README.zh.md)

## Summary

`dsh-ssh-hosts` is the remote-execution layer for base-backed `dsh --profile` surfaces: it lets them address SSH hosts as execution worlds. It mounts [the host registry](../../ssh/host-registry/README.md), [the host-credentials store](../../ssh/host-credentials/README.md) and [the hosts controller](../../api/hosts-controller/README.md); the local machine stays the built-in world, and every registered host gets its own isolated realm of `sshNative`, `fs` and `subprocess`, mounted from that host's stored login. The shipped `web` profile includes this layer between `dsh-base` and `dsh-web-app`, so Settings → Remote hosts has its Host owner; the `headless`, `acp` and `sdk` profiles do not, and add it after `dsh-base`. With no registered host it changes nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Add the layer to another profile

The shipped `headless`, `acp` and `sdk` profiles do not include this bundle; a profile that wants remote hosts names it after `dsh-base`:

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

An out-of-tree bundle installs into a profile through `dsh plugin --profile <name> add @deepseek-ai/dsh-ssh-hosts`; in-box bundles resolve from the dsh installation. The layer then contributes exactly three rows: the `ssh-host-registry` realm owner, the `ssh-host-credentials` store it materializes logins with, and the `ssh-hosts-controller` Remote owner over both. The registry row declares `sshHostCredentials` and `storageDomain` as injected dependencies, and the controller declares the registry and the credential store, so each row activates only once the services it needs are mounted; the credentials row needs no config because its state directory defaults to `<DSH home>/ssh-hosts`. The profile contract is documented in the [app-boot profile section](../../boot/app-boot/README.md).

### Register hosts

The bundle declares no host: its `ssh-host-registry` row carries `hosts: []`, and a profile that adds the bundle keeps only the local execution world until a host is registered. Registration is interactive, through the Host's Settings → Remote hosts section, which writes the host's login material to the credential store, persists its record, and opens its realm. Storing login material in a profile patch is not supported: the registry's `config.hosts` entries are refused at load because the native SSH composition installs no helper artifact to provision them from.

Every registered host is restored when the profile starts again, so a registration survives a restart.

### What you get

With hosts registered, `ctx.remoteHosts` lists one open handle per host, and each handle exposes that host's `sshNative`, `fs` and `subprocess` services. `ctx.hostsController` and the generated `ctx.remote.hosts` namespace let a browser list, add, remove and test those hosts. The [registry package](../../ssh/host-registry/README.md) owns the realm lifecycle and the native SSH composition; the [ssh-native package](../../../docs/subsystems/ssh.md) owns the single non-reconnecting OpenSSH connection behind each realm.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is a static patch document: one `insert` list applied after the `dsh-base` layer. It mounts no service itself and holds no mutable state; each inserted row's package owns that row's behavior and invariants.

### Composition mechanics

The insert carries only the registry, the credentials store and the hosts controller, deliberately not the local `fs`, `subprocess` or `sandbox` providers: the local machine stays the base-composed built-in world, and each remote host's world is mounted by the registry inside its own isolated realm. A patch replaces the targeted row's whole `config`, so a deployment that changes one config field restates the row. The registry row declares `sshHostCredentials` and `storageDomain` as injected dependencies, so activation waits for both regardless of row order; the credential store and the domain the registry persists its records through both ship with `dsh-base`.

### Activation

`apply` validates the config, mounts the registry, and then restores every persisted host: it reads each stored login from the credential store and opens that host's isolated realm with the native SSH composition. A `config.hosts` entry refuses the load instead of opening, because the native composition installs nothing on the host and a configured entry would have no installation to run. A persisted record with no stored login, or a host that cannot be opened, fails the profile load; nothing is skipped silently.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle substance: the three inserted rows, with rationale as inline comments |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API |
| — | No runtime invariant companion is published; the package is a static patch-list carrier, and each inserted row's package owns that row's invariants. |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | Patch declaration, row set, and dependency checks |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | Real Loader composition of the three rows against a test-only credentials provider, including the missing-injection case |

### Invariant ownership

No invariant companion is published because the package is a static patch-list carrier: the registry owns realm lifecycle and the native SSH composition, and the credentials store owns login material and the generated OpenSSH identity.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — connection and provider composition.
- [Host registry](../../ssh/host-registry/README.md) — realm lifecycle and the native SSH composition semantics.
- [Host credentials](../../ssh/host-credentials/README.md) — the stored logins the registry materializes.
- [Hosts controller](../../api/hosts-controller/README.md) — the Remote namespace a browser host-management page calls.
- [Bundle package map](../README.md) — the profile layers you can stack.
- [GUI-managed SSH remote hosts note](../../../.agents/notes/proposed/architecture/2026-09-21-gui-managed-ssh-remote-hosts.md) — the proposal this layer belongs to; its helper-provisioned composition was replaced by the native SSH runtime.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the registry and the execution providers it mounts: those packages own every model-facing value, and this bundle registers no tool, prompt section or result of its own.

#### KV Cache effect

The bundle itself adds no request prefix; the packages behind its three rows own any cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No agent runs in a host realm yet** — a host realm provides only `sshNative`, `fs` and `subprocess`, and no mechanism binds an agent's context to a host realm, so tool, terminal, search, spill and language-server work still resolve the local machine's providers.
- **`sandboxPolicy` is not host-isolated** — a host realm provides no `sandbox`, so any caller that resolves process confinement from the parent scope confines against the local policy.
- **No real remote end-to-end verification** — the composition test boots the three rows through the real Loader against a test-only credentials provider, and the controller test drives the real registry and credential store with a stubbed execution composition, but nothing here contacts a real SSH host.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

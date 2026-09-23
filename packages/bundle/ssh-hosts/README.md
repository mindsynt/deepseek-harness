---
description: "The optional SSH remote-host layer for base-backed dsh profiles: registered hosts run in isolated execution worlds while the local machine stays the built-in realm, for users composing or customizing a profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-ssh-hosts

English | [中文](README.zh.md)

## Summary

`dsh-ssh-hosts` is the optional bundle that lets one base-backed `dsh --profile` surface address SSH hosts as execution worlds. It mounts [the host registry](../../ssh/host-registry/README.md), [the helper installer](../../ssh/helper-installer/README.md), [the host-credentials store](../../ssh/host-credentials/README.md) and [the hosts controller](../../api/hosts-controller/README.md) over both; the local machine stays the built-in world, and every registered host gets its own isolated realm of `ssh`, `fs`, `subprocess` and `sandbox` services. No shipped profile includes this layer: add it to `dsh.profile.bundles` after `@deepseek-ai/dsh-base`, then declare hosts in a later profile patch layer. With no declared host it changes nothing.

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

### Add the layer to a profile

The shipped `web`, `headless`, `acp` and `sdk` profiles do not include this bundle; a profile that wants remote hosts names it after `dsh-base`:

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

An out-of-tree bundle installs into a profile through `dsh plugin --profile <name> add @deepseek-ai/dsh-ssh-hosts`; in-box bundles resolve from the dsh installation. The layer then contributes exactly four rows: `ssh-host-registry`, the `ssh-helper-installer` it provisions through, the `ssh-host-credentials` store it materializes logins with, and the `ssh-hosts-controller` Remote owner over both. The registry row declares the installer and the credential store as injected dependencies, and the controller declares the registry and the credential store, so each row activates only once the services it needs are mounted; the credentials row needs no config because its state directory defaults to `<DSH home>/ssh-hosts`. The profile contract is documented in the [app-boot profile section](../../boot/app-boot/README.md).

### Declare hosts

The layer itself declares no host: its `ssh-host-registry` row carries `hosts: []`, so a profile that adds the bundle keeps the local execution world until a later patch layer declares hosts. Build the helper package first with `pnpm run build:ssh-helper-artifact`, then point the row at its manifest:

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

`manifest` is the absolute local path of a `manifest.json` produced by `pnpm run build:ssh-helper-artifact`; an entry may name its own, and every entry without one uses the plugin-level path. `DSH_SSH_HELPER_MANIFEST` is the environment fallback the shipped row uses. Activation then reads each manifest, loads the archive it names, installs that artifact over OpenSSH, and opens the host's isolated realm. A malformed config, manifest, or install fails the profile load with the host id and file path; nothing is skipped silently.

### What you get

With hosts declared, `ctx.remoteHosts` lists one open handle per host, and each handle exposes that host's `ssh`, `fs`, `subprocess` and `sandbox` services. `ctx.hostsController` and the generated `ctx.remote.hosts` namespace let a browser list, add and remove those hosts. The [registry package](../../ssh/host-registry/README.md) owns the realm lifecycle, addressing and provisioning; the [connection package](../../ssh/ssh/README.md) owns the single non-reconnecting OpenSSH session behind each realm.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is a static patch document: one `insert` list applied after the `dsh-base` layer. It mounts no service itself and holds no mutable state; each inserted row's package owns that row's behavior and invariants.

### Composition mechanics

The insert carries only the registry, the installer, the credentials store and the hosts controller, deliberately not the local `fs`, `subprocess` or `sandbox` providers: the local machine stays the base-composed built-in world, and each remote host's world is mounted by the registry inside its own isolated realm. A patch replaces the targeted row's whole `config`, so a deployment that declares hosts restates `manifest` and `hosts` together. The registry row declares `sshHelperInstaller` and `sshHostCredentials` as injected dependencies, so activation waits for both rows regardless of row order and provisioning never races a service it needs.

### Activation

`apply` validates the config first, mounts the registry, then provisions each declared host in order: it reads the entry's manifest, validates `entry`, `digest` and `archive`, loads the archive bytes beside that manifest, and calls `ctx.remoteHosts.provision(...)`. A failure throws, so a half-configured profile fails its load instead of running with fewer hosts.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | The bundle substance: the four inserted rows, with rationale as inline comments |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API |
| — | No runtime invariant companion is published; the package is a static patch-list carrier, and each inserted row's package owns that row's invariants. |
| [`tests/bundle.spec.ts`](tests/bundle.spec.ts) | Patch declaration, row set, and dependency checks |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | Real Loader composition of the four rows against a test-only credentials provider, including the missing-injection case |

### Invariant ownership

No invariant companion is published because the package is a static patch-list carrier: the registry owns realm lifecycle and provisioning, and the installer owns digest-verified placement on the host.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — connection, helper and provider composition.
- [Host registry](../../ssh/host-registry/README.md) — realm lifecycle, addressing and provisioning semantics.
- [Helper installer](../../ssh/helper-installer/README.md) — how an artifact reaches a host.
- [Host credentials](../../ssh/host-credentials/README.md) — the stored logins the registry materializes.
- [Hosts controller](../../api/hosts-controller/README.md) — the Remote namespace a browser host-management page calls.
- [Bundle package map](../README.md) — the profile layers you can stack.
- [GUI-managed SSH remote hosts note](../../../.agents/notes/proposed/architecture/2026-09-21-gui-managed-ssh-remote-hosts.md) — the phases this layer belongs to.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the registry and the execution providers it mounts: those packages own every model-facing value, and this bundle registers no tool, prompt section or result of its own.

#### KV Cache effect

The bundle itself adds no request prefix; the packages behind its four rows own any cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No browser page renders host management yet** — the controller exposes the namespace, but no client assembly mounts this contribution and no settings page lists, adds or removes a host.
- **Hosts are not persisted** — the declared host list lives in the profile patch, not in durable storage, so adding or editing a host means editing configuration and reloading the profile.
- **No real remote end-to-end verification** — the composition test boots the three rows through the real Loader against a test-only credentials provider, but nothing here contacts a real SSH host.
- **The artifact manifest must be built and pointed at** — activation fails loud when no manifest is configured, and the archive beside it must be the output of `pnpm run build:ssh-helper-artifact`.
- **`sandboxPolicy` is not host-isolated** — every realm resolves it from the parent scope, so two hosts cannot yet carry different confinement policies.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
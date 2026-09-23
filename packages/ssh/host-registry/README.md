---
description: "Per-host isolated execution realms for deployments running several SSH hosts in one Harness process."
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh-host-registry

English | [中文](README.zh.md)

## Summary

`dsh-ssh-host-registry` provides `ctx.remoteHosts`, which owns one isolated Cordis realm per registered SSH host. Each realm mounts [`dsh-ssh`](../ssh/README.md) with that host’s connection and helper coordinates plus the paired filesystem, subprocess and sandbox providers, so `ctx.ssh`, `ctx.fs`, `ctx.subprocess` and `ctx.sandbox` resolve per host instead of once per process. Opening a host returns a handle carrying its spec, execution world and closure; the registry addresses open hosts by id and releases each realm on close or on its own disposal. Login-provisioned hosts also persist one record in `ctx.storageDomain`, so their coordinates and installed helper digest survive a restart.

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

Mount the registry service with `ctx.plugin(RemoteHostRegistryService)`, or let the Loader mount the package itself: this is a function plugin with no default export, and its `apply` installs the service with the default composition and then provisions the hosts its `Config` declares. Supply a `RemoteHostComposition` instead when a deployment or a test mounts services other than the four SSH providers into the realm.

`ctx.remoteHosts.open(spec)` opens one realm and returns a handle with the spec, the resolved execution world and a `closed` promise; `get(id)` and `list()` address open hosts, and `close(id)` releases one realm and does nothing for an unknown id. A duplicate id fails loud, and `label` is carried to callers without defaulting: neither credentials nor helper coordinates are derived here.

`ctx.remoteHosts.provision(request)` closes the loop from artifact to realm: it installs the artifact with `ctx.sshHelperInstaller.install({ host, root, workspace, artifact })` and opens the handle from the returned `node`, `helper`, `helperHash` and `workspace` together with `request.id` and `request.label`. Provisioning therefore requires [`dsh-helper-installer`](../helper-installer/README.md) mounted in the same context, or the installer passed to the constructor by a programmatic caller; with neither, `provision()` throws and names that package. An install failure opens no realm and rethrows the installer's error, and a duplicate id fails before any install starts.

`ctx.remoteHosts.provisionFromLogin(request)` closes the loop from entered login material to realm: it materializes `request.login` through `ctx.sshHostCredentials`, trusts the endpoint’s published host keys for that identity, installs the artifact over the generated alias with the identity’s configuration passed as `ssh -F`, and opens the handle with `host` and `sshConfigFile` taken from that identity. The handle owns the identity for its whole life: `close()` releases the realm first and then removes the generated directory, exactly once. A failure from host-key trust through composition removes the identity before the error is rethrown and registers no handle. The registry never calls `store`, so persisting login material stays the caller’s decision; it reads that material back only through `load`, during startup recovery. A request carrying `manifest` writes one host record once the realm is open, and a record write that fails closes that realm and its identity before rethrowing. Login provisioning therefore also requires [`dsh-host-credentials`](../host-credentials/README.md) mounted in the same context, or injected into the constructor; with neither, `provisionFromLogin()` throws and names that package.

`ctx.remoteHosts.records()` returns every persisted host record in id order, `save(record)` writes one durably and replaces any record with the same id, and `forget(id)` closes one host, deletes its record, and calls `ctx.sshHostCredentials.forget(id)` to drop its stored login. The record carries caller-facing coordinates only; the login material stays in the credentials store.

| Field | Meaning |
|---|---|
| `id` | Registry identity. |
| `label` | Caller-facing label. |
| `host` | OpenSSH alias the materialized identity addresses. |
| `root` | Absolute remote directory receiving the digest-named install directory. |
| `workspace` | Absolute remote default workspace. |
| `manifest` | Absolute local path of the artifact manifest this host installs from; never empty. |
| `helperHash` | Lowercase SHA-256 of the helper entry last installed for this host. |

A profile declares hosts through the plugin `Config`. `hosts` lists the entries provisioned at activation — each needs a non-empty `id`, an OpenSSH `host` alias, an absolute remote `root` and `workspace`, and an absolute local `manifest` (its own, else the plugin-level one) — and omitting `hosts` opens nothing. `apply` validates the whole config first, mounts the service, then for each entry reads the manifest, loads the archive it names from the local disk, and calls `provision()`. A malformed field, a missing or malformed manifest, or a failed install throws and fails activation with the host id and file path; no entry is skipped silently. The manifest is the `manifest.json` produced by `pnpm run build:ssh-helper-artifact`. Because the plugin injects `sshHelperInstaller`, `sshHostCredentials` and `storageDomain`, activation waits for all three instead of racing them.

After the declared hosts, `apply` restores every persisted record whose id the config does not declare. Per record, in id order, it reads the stored login with `ctx.sshHostCredentials.load(id)`, reads the artifact manifest the record names, and provisions the host through `provisionFromLogin()`, which rewrites the record from the fresh installation. A record the config does declare is never restored, so its host installs exactly once. A record without stored login material fails activation with its id and the instruction to store login material or remove the record, and any other failure aborts activation rather than skipping the record.

Realm lifecycle, addressing, helper provisioning, the owned identity lifetime, and the host records login provisioning persists are all this package owns today. No workspace or Session record carries a host identity, and no GUI surface manages hosts yet.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One host realm is one Cordis fiber. `open()` starts an owner fiber, isolates the four execution service names below it, and mounts that host’s providers there; disposing the owner fiber unloads them, which is what `close()` and the registry’s own disposal do. Cordis keys a service implementation by isolation label alone, so the four names take four labels per host: one shared label would collide on the second provider and resolve the wrong instance. Service names the registry does not isolate — `sandboxPolicy` today — keep resolving from the parent scope.

Host records live in the `ssh_hosts` domain over `ctx.storageDomain`. The registry opens that domain while activating — its declared `storageDomain` injection delays activation until the service exists — reads records synchronously from the domain’s validated in-memory state, and closes the domain after every realm on its own disposal. The record schema rejects a stored record whose `manifest` is not a non-empty absolute path, and the domain fails the open with `invalid-record` naming the table and key, so a medium this registry did not write fails activation instead of dropping a host.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — connection, helper and provider composition.
- [SSH connection](../ssh/README.md) — deployment, readiness and disconnection behavior.
- [SSH filesystem](../fs-ssh/README.md) — the remote file semantics each realm installs.

-----

<a id="model-experience"></a>
## Model Experience

### Remote execution services

#### What the model sees

The registry registers no tool, prompt section or result of its own. Consumers of `ctx.fs`, `ctx.subprocess` and `ctx.sandbox` render every model-visible value, and each of them reaches whichever host’s realm resolved its service.

#### Token effect

Opening or closing a host adds no model-visible input and changes no request-prefix text; the registry owns no token budget of its own.

#### KV Cache effect

The registry contributes no request-prefix content, so request prefixes stay as the consumers compose them.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No GUI surface manages hosts yet: nothing lists, adds, edits or removes a host, and `provisionFromLogin()` trusts the endpoint's published host keys without a fingerprint-confirmation step. The host identity on workspaces and Sessions is a later phase.
- A record's `manifest` is an absolute path on the machine that wrote it. Moving the domain to another machine, or deleting the manifest, leaves that record unrestorable: startup recovery fails until the manifest is rebuilt with `pnpm run build:ssh-helper-artifact` or the record is removed with `forget(id)`.
- Only login provisioning persists a record. A host opened with `open()` or `provision()` writes none, so it is absent from `records()` and from startup recovery.
- Provisioning has no real remote end-to-end verification yet. Tests drive the closed loop through an injected installer, and none installs an artifact on a real host.
- `sandboxPolicy` is not host-isolated. Every realm resolves it from the parent scope, so two hosts cannot yet carry different confinement policies.
- The registry never reconnects. A lost SSH connection invalidates that realm’s providers, matching the connection’s no-reconnect contract, and callers reopen the host instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Realm existence is fiber ownership, and realm release is observed directly by `packages/ssh/host-registry/tests/registry.spec.ts`, so the package has no independently observed state relation to check.

</details>

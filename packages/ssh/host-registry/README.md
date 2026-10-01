---
description: "Per-host isolated execution realms for deployments running several SSH hosts in one Harness process."
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh-host-registry

English | [中文](README.zh.md)

## Summary

`dsh-ssh-host-registry` provides `ctx.remoteHosts`, which owns one isolated Cordis realm per registered SSH host. Each realm mounts [`dsh-ssh-native`](../ssh-native/README.md) with that host's connection coordinates plus the paired SFTP filesystem and SSH-exec subprocess providers, so `ctx.fs` and `ctx.subprocess` resolve per host instead of once per process. Opening a host returns a handle carrying its spec, execution world and closure; the registry addresses open hosts by id and releases each realm on close or on its own disposal.

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

Mount the registry service with `ctx.plugin(RemoteHostRegistryService)`, or let the Loader mount the package itself: this is a function plugin with no default export, and its `apply` installs the service with the default composition. Supply a `RemoteHostComposition` instead when a deployment or a test mounts services other than the SSH-native providers into the realm.

`ctx.remoteHosts.open(spec)` opens one realm and returns a handle with the spec, the resolved execution world and a `closed` promise; `get(id)` and `list()` address open hosts, and `close(id)` releases one realm and does nothing for an unknown id. A duplicate id fails loud, and `label` is carried to callers without defaulting.

| Field | Meaning |
|---|---|
| `id` | Registry identity. |
| `label` | Caller-facing label. |
| `host` | Remote host address (hostname or IP). |
| `port` | Remote SSH port (default: 22). |
| `user` | Username. |
| `privateKey` | Private key content (PEM format). |
| `password` | Password (mutually exclusive with privateKey). |
| `identityFile` | Local identity file path. |
| `knownHostsFile` | Path to known_hosts file. |

A profile declares hosts through the plugin `Config`. `hosts` lists the entries opened at activation — each needs a non-empty `id`, a `host`, and a `user` — and omitting `hosts` opens nothing. Because the plugin injects `sshHostCredentials` and `storageDomain`, activation waits for both instead of racing them.

After the declared hosts, `apply` restores every persisted record whose id the config does not declare.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One host realm is one Cordis fiber. `open()` starts an owner fiber, isolates the three execution service names below it, and mounts that host's providers there; disposing the owner fiber unloads them, which is what `close()` and the registry's own disposal do. Cordis keys a service implementation by isolation label alone, so the three names take three labels per host: one shared label would collide on the second provider and resolve the wrong instance.

The default composition mounts three providers:
- [`SshNativeConnection`](../ssh-native/README.md) — the SSH connection service over ssh2
- [`SftpFileSystem`](../fs-sftp/README.md) — the filesystem provider over SFTP
- [`SshExecSubprocessRuntime`](../subprocess-ssh-exec/README.md) — the subprocess provider over SSH exec

Host records live in the `ssh_hosts` domain over `ctx.storageDomain`. The registry opens that domain while activating — its declared `storageDomain` injection delays activation until the service exists — reads records synchronously from the domain's validated in-memory state, and closes the domain after every realm on its own disposal.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — connection and provider composition.
- [SSH connection](../ssh-native/README.md) — native SSH connection over ssh2.
- [SSH filesystem](../fs-sftp/README.md) — the remote file semantics over SFTP.
- [SSH subprocess](../subprocess-ssh-exec/README.md) — subprocess execution over SSH exec.

-----

<a id="model-experience"></a>
## Model Experience

### Remote execution services

#### What the model sees

The registry registers no tool, prompt section or result of its own. Consumers of `ctx.fs` and `ctx.subprocess` render every model-visible value, and each of them reaches whichever host's realm resolved its service.

#### Token effect

Opening or closing a host adds no model-visible input and changes no request-prefix text; the registry owns no token budget of its own.

#### KV Cache effect

The registry contributes no request-prefix content, so request prefixes stay as the consumers compose them.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No GUI surface manages hosts yet: nothing lists, adds, edits or removes a host.
- A host opened with `open()` writes no record, so it is absent from `records()` and from startup recovery.
- Provisioning has no real remote end-to-end verification yet. Tests drive the composition with mocked services, and none connects to a real host.
- `sandboxPolicy` is not host-isolated. Every realm resolves it from the parent scope, so two hosts cannot yet carry different confinement policies.
- The registry never reconnects. A lost SSH connection invalidates that realm's providers, and callers reopen the host instead.
- Terminal sessions via SSH PTY are read-only in the current implementation; interactive input and resize are stubbed with TODOs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Realm existence is fiber ownership, and realm release is observed directly by the composition tests, so the package has no independently observed state relation to check.

</details>

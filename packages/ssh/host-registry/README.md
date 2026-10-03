---
description: "Per-host isolated execution realms for deployments running several SSH hosts in one Harness process."
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh-host-registry

English | [中文](README.zh.md)

## Summary

`dsh-ssh-host-registry` provides `ctx.remoteHosts`, which owns one isolated Cordis realm per registered SSH host. Each realm mounts [`dsh-ssh-native`](../../../docs/subsystems/ssh.md) with that host's connection coordinates plus the paired SFTP filesystem and SSH-exec subprocess providers, so `ctx.fs` and `ctx.subprocess` resolve per host instead of once per process. Opening a host returns a handle carrying its spec, execution world and closure; the registry addresses open hosts by id and releases each realm on close or on its own disposal.

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

A profile names no host through the plugin `Config`: the native SSH composition installs no helper artifact, so a `config.hosts` entry fails activation with the entry's id, naming the controller that does register hosts. Because the plugin injects `sshHostCredentials` and `storageDomain`, activation waits for both instead of racing them.

After the declared hosts, `apply` restores every persisted record whose id the config does not declare.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One host realm is one Cordis fiber. `open()` starts an owner fiber, isolates the three execution service names below it, and mounts that host's providers there; disposing the owner fiber unloads them, which is what `close()` and the registry's own disposal do. Cordis keys a service implementation by isolation label alone, so the three names take three labels per host: one shared label would collide on the second provider and resolve the wrong instance.

The default composition mounts three providers:
- [`SshNativeConnection`](../../../docs/subsystems/ssh.md) — the SSH connection service over ssh2
- [`SftpFileSystem`](../../../docs/subsystems/ssh.md) — the filesystem provider over SFTP
- [`SshExecSubprocessRuntime`](../../../docs/subsystems/ssh.md) — the subprocess provider over SSH exec

Host records live in the `ssh_hosts` domain over `ctx.storageDomain`. The registry opens that domain while activating — its declared `storageDomain` injection delays activation until the service exists — reads records synchronously from the domain's validated in-memory state, and closes the domain after every realm on its own disposal.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — connection and provider composition.
- [SSH connection](../../../docs/subsystems/ssh.md) — native SSH connection over ssh2.
- [SSH filesystem](../../../docs/subsystems/ssh.md) — the remote file semantics over SFTP.
- [SSH subprocess](../../../docs/subsystems/ssh.md) — subprocess execution over SSH exec.

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

- Hosts are registered only through the Host's settings surface or the `hosts` Remote namespace: the registry itself exposes no list, add, edit or remove operation, so an operator who edits the record store by hand can leave a record the startup recovery cannot open.
- A host opened with `open()` writes no record, so it is absent from `records()` and from startup recovery.
- A host realm provides only `sshNative`, `fs` and `subprocess`. It provides no `sandbox`, so anything a host realm resolves from the parent scope instead — process confinement, search, terminal, spill — is not yet host-isolated.
- Provisioning has no real remote end-to-end verification yet. Tests drive the composition with stubbed services, and none connects to a real host.
- The registry never reconnects. A lost SSH connection invalidates that realm's providers, and callers reopen the host instead.
- Terminal sessions request an SSH PTY and forward input, resize and termination to the channel. The remote foreground process group is invisible, so the handle publishes `pid: 0`, `inspectForeground()` returns `undefined`, and `signalForeground()` throws.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Realm existence is fiber ownership, and realm release is observed directly by the add and remove cases in `packages/api/hosts-controller/tests/hosts-controller.spec.ts`, so the package has no independently observed state relation to check.

</details>
